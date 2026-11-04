// The tool catalog: what every upstream can do, snapshotted and cached on disk.
//
// Snapshotting is what makes the index possible — we have to know the tools to
// describe the group that hides them. The snapshot is cached so a cold start does
// not have to spawn fifteen servers before the agent can ask its first question.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import type {
  Catalog,
  CatalogLike,
  CatalogServerEntry,
  CatalogTool,
  JsonSchema,
  Logger,
  McpToolSchema,
  UpstreamLike,
} from "./types.js"
import { isRecord } from "./types.js"

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** The pool as `snapshot` uses it: names, and a tool listing per server. */
export interface ToolSourcePool {
  names(): string[]
  get(name: string): UpstreamLike
}

export interface SnapshotOptions {
  log?: Logger
  servers?: string[]
  concurrency?: number
  onResult?: (name: string, entry: CatalogServerEntry) => void
}

/** The parts of a tool definition a hash or a token estimate needs. Both the
 *  catalog entries and a live upstream's definitions satisfy it. */
export interface ToolDefinitionLike {
  name: string
  description?: string
  inputSchema?: JsonSchema
}

export function defaultCachePath(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(base, "tool-call-compactor", "catalog.json")
}

export function schemaHash(tool: ToolDefinitionLike): string {
  return createHash("sha256")
    .update(JSON.stringify({ n: tool.name, d: tool.description || "", s: tool.inputSchema || {} }))
    .digest("hex")
    .slice(0, 16)
}

/** Rough token estimate for a tool definition as the provider will see it.
 *  Deliberately the same shape harnesses serialize (name + description + JSON
 *  Schema) so the savings report is comparable to what the wire carries. */
export function estimateTokens(tool: ToolDefinitionLike): number {
  const bytes = JSON.stringify({
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.inputSchema || {},
  }).length
  return Math.ceil(bytes / 4)
}

export function cacheIsFresh(cache: CatalogLike | null | undefined, ttlMs: number = CACHE_TTL_MS): boolean {
  if (!cache || !cache.savedAt) return false
  return Date.now() - cache.savedAt < ttlMs
}

/** Read the snapshot, and refuse to hand back anything that is not one: the
 *  file is on disk, so it can be truncated, hand-edited, or written by an older
 *  version. A parse failure is a cache miss, never a crash.
 *
 *  Each field is narrowed on the way in, so a cache entry with a broken tool
 *  cannot later be read as a schema that does not exist. */
export function readCache(file: string = defaultCachePath()): Catalog | null {
  try {
    if (!existsSync(file)) return null
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!isRecord(parsed) || !isRecord(parsed.servers)) return null
    const servers: Record<string, CatalogServerEntry> = {}
    for (const [name, entry] of Object.entries(parsed.servers)) {
      if (!isRecord(entry)) continue
      const tools: CatalogTool[] = []
      for (const tool of Array.isArray(entry.tools) ? entry.tools : []) {
        if (!isRecord(tool) || typeof tool.name !== "string") continue
        tools.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: isRecord(tool.inputSchema) ? (tool.inputSchema as JsonSchema) : { type: "object", properties: {} },
          hash: typeof tool.hash === "string" ? tool.hash : "",
          tokens: typeof tool.tokens === "number" ? tool.tokens : 0,
        })
      }
      servers[name] = {
        ok: entry.ok === true,
        error: typeof entry.error === "string" ? entry.error : undefined,
        tools,
      }
    }
    return {
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      version: typeof parsed.version === "number" ? parsed.version : 1,
      servers,
    }
  } catch {
    return null
  }
}

export function writeCache(cache: Catalog, file: string = defaultCachePath()): boolean {
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
export async function snapshot(pool: ToolSourcePool, { log = () => {}, servers, concurrency = 6, onResult }: SnapshotOptions = {}): Promise<Catalog> {
  const names = servers || pool.names()
  const out: Catalog = { savedAt: Date.now(), version: 1, servers: {} }
  const queue = [...names]
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
    while (queue.length) {
      const name = queue.shift() as string
      try {
        const tools: McpToolSchema[] = await pool.get(name).listTools()
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
        const message = err instanceof Error ? err.message : String(err)
        log(`snapshot failed for ${name}: ${message}`)
        out.servers[name] = { ok: false, error: String((err as Error).message || err), tools: [] }
      }
      onResult?.(name, out.servers[name])
    }
  })
  await Promise.all(workers)
  return out
}

/** Identical schemas served by two servers are counted once — the index only
 *  has to tell the agent where a tool lives, not pay for it twice. */
export function dedupe(catalog: CatalogLike): { unique: number; duplicateTokens: number } {
  const seen = new Map<string, { server: string; name: string }>()
  let duplicateTokens = 0
  for (const [server, entry] of Object.entries(catalog.servers || {})) {
    for (const tool of entry.tools || []) {
      const prev = seen.get(tool.hash as string)
      if (prev) duplicateTokens += tool.tokens as number
      else seen.set(tool.hash as string, { server, name: tool.name })
    }
  }
  return { unique: seen.size, duplicateTokens }
}
