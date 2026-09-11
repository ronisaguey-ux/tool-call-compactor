// The tool catalog: what every upstream can do, snapshotted and cached on disk.
//
// Snapshotting is what makes the index possible — we have to know the tools to
// describe the group that hides them. The snapshot is cached so a cold start does
// not have to spawn fifteen servers before the agent can ask its first question.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export function defaultCachePath() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(base, "tool-call-compactor", "catalog.json")
}

export function schemaHash(tool) {
  return createHash("sha256")
    .update(JSON.stringify({ n: tool.name, d: tool.description || "", s: tool.inputSchema || {} }))
    .digest("hex")
    .slice(0, 16)
}

/** Rough token estimate for a tool definition as the provider will see it.
 *  Deliberately the same shape harnesses serialize (name + description + JSON
 *  Schema) so the savings report is comparable to what the wire carries. */
export function estimateTokens(tool) {
  const bytes = JSON.stringify({
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.inputSchema || {},
  }).length
  return Math.ceil(bytes / 4)
}

export function cacheIsFresh(cache, ttlMs = CACHE_TTL_MS) {
  if (!cache || !cache.savedAt) return false
  return Date.now() - cache.savedAt < ttlMs
}

export function readCache(file = defaultCachePath()) {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed && parsed.servers ? parsed : null
  } catch {
    return null
  }
}

export function writeCache(cache, file = defaultCachePath()) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cache, null, 2), "utf8")
    return true
  } catch {
    return false
  }
}

/** Snapshot every upstream's tools/list, a few servers at a time so one server
 *  that hangs cannot serialise the whole scan. Servers that fail are recorded
 *  with their error and skipped — one broken server must not blind the index. */
export async function snapshot(pool, { log = () => {}, servers, concurrency = 6, onResult } = {}) {
  const names = servers || pool.names()
  const out = { savedAt: Date.now(), version: 1, servers: {} }
  const queue = [...names]
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
    while (queue.length) {
      const name = queue.shift()
      try {
        const tools = await pool.get(name).listTools()
        out.servers[name] = {
          ok: true,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema || { type: "object", properties: {} },
            hash: schemaHash(t),
            tokens: estimateTokens(t),
          })),
        }
      } catch (err) {
        log(`snapshot failed for ${name}: ${err.message}`)
        out.servers[name] = { ok: false, error: String(err.message || err), tools: [] }
      }
      onResult?.(name, out.servers[name])
    }
  })
  await Promise.all(workers)
  return out
}

/** Identical schemas served by two servers are counted once — the index only
 *  has to tell the agent where a tool lives, not pay for it twice. */
export function dedupe(catalog) {
  const seen = new Map()
  let duplicateTokens = 0
  for (const [server, entry] of Object.entries(catalog.servers || {})) {
    for (const tool of entry.tools || []) {
      const prev = seen.get(tool.hash)
      if (prev) duplicateTokens += tool.tokens
      else seen.set(tool.hash, { server, name: tool.name })
    }
  }
  return { unique: seen.size, duplicateTokens }
}
