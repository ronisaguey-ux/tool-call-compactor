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
import type { SnapshotOptions } from "./catalog.js"
import { autoGroups, clampWords, coverage, findGroup, mergeGroups, titleFor, toolsInGroup, toolIndex } from "./groups.js"
import { Metrics, reportLines } from "./metrics.js"
import { Compactor } from "./server.js"
import { HARNESSES, detectHarnesses, installIntoHarness, readHarness } from "./adapter.js"
import { defaultConfig, loadConfig, configPath, persistPolicy, resolveConfigDir, saveConfig } from "./config.js"
import type {
  Catalog,
  GroupConfig,
  McpCallToolResult,
  McpContentBlock,
  McpServerConfig,
  ResolvedConfig,
} from "./types.js"

const out = (line = ""): void => {
  process.stdout.write(line + "\n")
}
const err = (line: string): void => {
  process.stderr.write(line + "\n")
}

/** Parsed argv. Everything is unknown until a command reads it: a flag value
 *  off a command line is a string, `true` when it was used as a switch. */
export interface CliArgs {
  _: string[]
  [flag: string]: string | boolean | string[]
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=")
      const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      if (inline !== undefined) args[camel] = inline
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[camel] = argv[++i]
      else args[camel] = true
    } else (args._ as string[]).push(token)
  }
  return args
}

const str = (value: string | boolean | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined

export function buildPool(config: ResolvedConfig, { log = err, workdir = process.cwd() }: { log?: (line: string) => void; workdir?: string } = {}): UpstreamPool {
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

function totals(catalog: Catalog): { tools: number; tokens: number } {
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
export async function ensureCatalog(
  config: ResolvedConfig,
  pool: UpstreamPool,
  { log = err, force = false, onResult }: { log?: (line: string) => void; force?: boolean; onResult?: SnapshotOptions["onResult"] } = {},
): Promise<Catalog> {
  const cache = readCache(config.cachePath || defaultCachePath())
  if (cache && !force && cacheIsFresh(cache, config.options.cacheTtlMs ?? CACHE_TTL_MS)) return cache
  const fresh = await snapshot(pool, { log, onResult })
  writeCache(fresh, config.cachePath || defaultCachePath())
  return fresh
}

async function cmdInit(args: CliArgs): Promise<void> {
  const dir = resolveConfigDir(str(args.config))
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

  cfg.mcp = { ...servers, ...(args.merge ? cfg.mcp : {}) }
  if (args.builtins) {
    cfg.builtins = { enabled: true, tools: DEFAULT_BUILTINS, workdir: process.cwd() }
  }
  const pool = buildPool(cfg, { log: (m) => err(`  ${m}`) })
  err("")
  err("snapshotting tools (this spawns each server once)…")
  const catalog = await snapshot(pool, {
    log: (m) => err(`  ! ${m}`),
    concurrency: Number(args.concurrency) || 6,
    onResult: (name, entry) => {
      const n = entry.tools?.length || 0
      err(`  ${entry.ok ? "✓" : "✗"} ${name.padEnd(24)} ${entry.ok ? `${n} tools` : entry.error}`)
    },
  })
  writeCache(catalog, cfg.cachePath || defaultCachePath())
  pool.closeAll()

  const auto = autoGroups(catalog)
  cfg.groups = args.merge ? mergeGroups(auto, cfg.groups) : auto
  const { tools, tokens } = totals(catalog)
  const indexPath = Object.entries(cfg.groups).length
  saveConfig(cfg, { backup: true })

  out("")
  out(`snapshot: ${tools} tools, ~${tokens} tokens of schema, across ${Object.keys(catalog.servers).length} servers`)
  out(`groups:   ${indexPath} — ${Object.keys(cfg.groups).join(", ")}`)
  out("")
  out(`wrote ${configPath(dir)}`)
  out("")
  out("Next: review the group descriptions, then run")
  out(`  tcc install --harness opencode --config ${dir}`)
  out("to put the compactor in front of those servers.")
}

async function cmdScan(args: CliArgs): Promise<void> {
  const dir = resolveConfigDir(str(args.config))
  const cfg = loadConfig(dir)
  const pool = buildPool(cfg, { log: (m) => err(`  ${m}`) })
  const catalog = await snapshot(pool, {
    log: (m) => err(`  ! ${m}`),
    concurrency: Number(args.concurrency) || 6,
    onResult: (name, entry) => {
      const n = entry.tools?.length || 0
      out(`${entry.ok ? "ok  " : "FAIL"} ${name.padEnd(24)} ${entry.ok ? `${String(n).padStart(4)} tools` : entry.error}`)
    },
  })
  writeCache(catalog, cfg.cachePath || defaultCachePath())
  const { tools, tokens } = totals(catalog)
  const dup = dedupe(catalog)
  const auto = autoGroups(catalog)
  out("")
  out(`${tools} tools, ~${tokens} tokens (${dup.unique} unique schemas, ${dup.duplicateTokens} tokens duplicated)`)
  out(`would group into ${Object.keys(auto).length}:`)
  for (const [id, group] of Object.entries(auto)) {
    const count = toolsInGroup(group, catalog, toolIndex(catalog)).length
    out(`  see_tools_${id.padEnd(16)} ${String(count).padStart(4)} tools  ${group.description}`)
  }
  pool.closeAll()
}

/** Rebuild the batches from the catalog, keeping every title and description a
 *  human or agent already wrote, and guaranteeing that no tool is left out. */
function cmdBatch(args: CliArgs): void {
  const dir = resolveConfigDir(str(args.config))
  const cfg = loadConfig(dir)
  const cache = readCache(cfg.cachePath || defaultCachePath())
  if (!cache) {
    out("no catalog cached — run `tcc scan` first")
    process.exitCode = 1
    return
  }
  // A catalog can outlive the config that produced it. Rewriting batches on top
  // of a config that no longer defines those servers silently produces a file
  // that can reach nothing — refuse instead.
  const catalogServers = Object.keys(cache.servers || {}).filter((s) => s !== "builtin")
  const orphans = catalogServers.filter((s) => !cfg.mcp?.[s])
  if (orphans.length && !args.force) {
    out(`the catalog has ${catalogServers.length} server(s) this config does not define:`)
    out(`  ${orphans.join(", ")}`)
    out("")
    out("Run `tcc init` (or add them to the config) before rebuilding batches.")
    out("Pass --force if you really mean to write batches pointing at nothing.")
    process.exitCode = 1
    return
  }

  const index = toolIndex(cache)
  const auto = autoGroups(cache)
  const merged: Record<string, GroupConfig> = { ...auto }
  const rewritten: string[] = []
  for (const [id, existing] of Object.entries(cfg.groups || {})) {
    const base = auto[id] || {}
    merged[id] = {
      ...base,
      ...existing,
      title: existing.title || base.title || titleFor(id),
      description: existing.description || base.description,
    }
    if (!auto[id]) rewritten.push(id)
  }

  let cov = coverage(merged, cache, index)
  let catchAll: GroupConfig | null = null
  if (cov.unbatched.length) {
    const refs = cov.unbatched
    catchAll = {
      title: "Other",
      description: clampWords(`Unbatched tools: ${refs.map((r) => r.split("::")[1]).slice(0, 6).join(", ")}.`),
      tools: refs,
    }
    merged.other = { ...(merged.other || {}), ...catchAll }
    cov = coverage(merged, cache, index)
  }

  cfg.groups = merged
  saveConfig(cfg, { backup: true })

  out(`${Object.keys(merged).length} batches covering ${cov.batched} of ${cov.total} tools — ${configPath(dir)}`)
  out("")
  for (const [id, group] of Object.entries(merged)) {
    const count = toolsInGroup(group, cache, index).length
    out(`  see_tools_${id}`)
    out(`    ${(group.title || titleFor(id)).padEnd(20)} ${String(count).padStart(4)} tools  ~${toolsInGroup(group, cache, index).reduce((n, t) => n + (t.tokens || 0), 0)} tokens`)
    out(`    ${group.description}`)
  }
  out("")
  const dup = dedupe(cache)
  out(`${dedupe(cache).unique} unique schemas; ${dup.duplicateTokens} tokens are the same schema served twice`)
  if (catchAll) out(`created an "other" batch for ${catchAll.tools?.length} tool(s) no batch claimed`)
  if (rewritten.length) out(`kept ${rewritten.length} hand-written batch(es) with no tools in the catalog: ${rewritten.join(", ")}`)
  if (cov.duplicated.length) {
    out(`${cov.duplicated.length} tool(s) sit in more than one batch:`)
    for (const dupTool of cov.duplicated.slice(0, 10)) out(`  ${dupTool.tool} → ${dupTool.groups.join(", ")}`)
  }
}

function cmdGroups(args: CliArgs): void {
  const dir = resolveConfigDir(str(args.config))
  const cfg = loadConfig(dir)
  const cache = readCache(cfg.cachePath || defaultCachePath())
  const groups: Record<string, GroupConfig> = Object.keys(cfg.groups || {}).length ? cfg.groups : autoGroups(cache || { servers: {} })
  const index = toolIndex(cache || {})
  const policy = persistPolicy(cfg.rawOptions || {})
  const exposed = Object.entries(groups)
    .filter(([, g]) => g.expose)
    .map(([id]) => id)
  out(`${Object.keys(groups).length} batches (persist ${policy.mode}${policy.budget ? `, budget ${policy.budget}` : ""})`)
  for (const [id, group] of Object.entries(groups)) {
    const members = index.size ? toolsInGroup(group, cache, index) : []
    const count = members.length
    const tokens = members.reduce((n, t) => n + (t.tokens || 0), 0)
    const kind = group.expose ? `live (${id}__<tool>)` : `see_tools_${id}`
    // The token cost is what the agent is deciding about: opening this batch spends
    // these tokens from the context budget. Without it the index says how many tools
    // a batch holds but not what it costs to look, which is the only number a model
    // weighing "should I open this?" can act on.
    const cost = tokens ? `~${String(tokens).padStart(5)} tok` : "        ?"
    out(`  ${kind.padEnd(24)} ${String(count).padStart(4)} tools  ${cost}  ${(group.title || titleFor(id)).padEnd(18)} ${group.description}`)
  }
  if (exposed.length) {
    out("")
    out(`pass-through batches, always advertised: ${exposed.join(", ")}`)
  }
  if (index.size) {
    const cov = coverage(groups, cache, index)
    out("")
    out(`${cov.batched} of ${cov.total} catalogued tools are batched`)
    if (cov.unbatched.length) out(`unbatched (${cov.unbatched.length}): ${cov.unbatched.slice(0, 12).join(", ")} — run \`tcc batch\``)
  }
}

/** Pass-through: mark a batch so its tools are advertised as real tools from
 *  the first request of every session, instead of hiding behind a fetch. */
function cmdExpose(args: CliArgs): void {
  const dir = resolveConfigDir(str(args.config))
  const cfg = loadConfig(dir)
  const wanted = args._[1]
  const groups = cfg.groups || {}
  if (!wanted) {
    const live = Object.entries(groups)
      .filter(([, g]) => g.expose)
      .map(([id]) => id)
    out(live.length ? `pass-through batches: ${live.join(", ")}` : "no pass-through batches")
    out("usage: tcc expose <batch> [--off] [--config DIR]")
    return
  }
  const found = findGroup(groups, wanted)
  if (!found) {
    out(`unknown batch "${wanted}". Available: ${Object.keys(groups).join(", ") || "(none)"}`)
    process.exitCode = 1
    return
  }
  const on = args.off ? false : true
  if (on) groups[found.id] = { ...found.group, expose: true }
