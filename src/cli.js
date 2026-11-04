// The command line: init, scan, serve, install, report, selftest.
//
// `serve` is what a harness runs; everything else is what a human runs once.

import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { UpstreamPool } from "./upstream.js"
import { BuiltinUpstream, BUILTINS, DEFAULT_BUILTINS } from "./builtins.js"
import {
  CACHE_TTL_MS,
  cacheIsFresh,
  dedupe,
  defaultCachePath,
  estimateTokens,
  readCache,
  snapshot,
  writeCache,
} from "./catalog.js"
import { autoGroups, clampWords, coverage, findGroup, mergeGroups, titleFor, toolsInGroup, toolIndex } from "./groups.js"
import { Metrics, reportLines } from "./metrics.js"
import { Compactor } from "./server.js"
import { HARNESSES, detectHarnesses, installIntoHarness, readHarness } from "./adapter.js"
import { defaultConfig, loadConfig, configPath, persistPolicy, resolveConfigDir, saveConfig } from "./config.js"

const out = (line = "") => process.stdout.write(line + "\n")
const err = (line) => process.stderr.write(line + "\n")

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=")
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (inline !== undefined) args[camel] = inline
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[camel] = argv[++i]
      else args[camel] = true
    } else args._.push(token)
  }
  return args
}

export function buildPool(config, { log = err, workdir = process.cwd() } = {}) {
  const opts = {
    log,
    idleMs: config.options.idleMs,
    timeoutMs: config.options.timeoutMs,
    retries: config.options.retries,
  }
  const pool = new UpstreamPool(config.mcp || {}, opts)
  if (config.builtins?.enabled) {
    const tools = config.builtins.tools?.length ? config.builtins.tools : DEFAULT_BUILTINS
    pool.map.set("builtin", new BuiltinUpstream({ tools, cwd: config.builtins.workdir || workdir, log }))
  }
  return pool
}

function totals(catalog) {
  let tools = 0
  let tokens = 0
  for (const entry of Object.values(catalog?.servers || {})) {
    for (const tool of entry.tools || []) {
      tools += 1
      tokens += tool.tokens || estimateTokens(tool)
    }
  }
  return { tools, tokens }
}

/** Load the catalog: cache when fresh, live snapshot when not, and never block
 *  forever — a scan that cannot finish still leaves a usable (if stale) index. */
export async function ensureCatalog(config, pool, { log = err, force = false, onResult } = {}) {
  const cache = readCache(config.cachePath || defaultCachePath())
  if (cache && !force && cacheIsFresh(cache, config.options.cacheTtlMs ?? CACHE_TTL_MS)) return cache
  const fresh = await snapshot(pool, { log, onResult })
  writeCache(fresh, config.cachePath || defaultCachePath())
  return fresh
}

async function cmdInit(args) {
  const dir = resolveConfigDir(args.config)
  const cfg = loadConfig(dir)
  const harnesses = args.harness ? String(args.harness).split(",").map((s) => s.trim()) : undefined
  const detected = detectHarnesses({ only: harnesses, includeDisabled: !!args.includeDisabled })

  out(`tcc init — config dir ${dir}`)
  out("")
  for (const row of detected.report) {
    const off = row.disabled?.length ? ` (+${row.disabled.length} disabled)` : ""
    const status = !row.found ? "not found" : row.error ? row.error : `${row.count} servers${off}`
    out(`  ${row.label.padEnd(16)} ${row.path}`)
    out(`  ${"".padEnd(16)} → ${status}`)
  }
  const servers = Object.fromEntries(Object.entries(detected.servers).filter(([name]) => name !== "compactor"))
  const serverCount = Object.keys(servers).length
  out("")
  out(`detected ${serverCount} server${serverCount === 1 ? "" : "s"} across ${detected.report.filter((r) => r.count).length} harness config(s)`)
