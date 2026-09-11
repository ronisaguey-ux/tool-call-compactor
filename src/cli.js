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
import { autoGroups, clampWords, coverage, mergeGroups, titleFor, toolsInGroup, toolIndex } from "./groups.js"
import { Metrics, reportLines } from "./metrics.js"
import { Compactor } from "./server.js"
import { HARNESSES, detectHarnesses, installIntoHarness, readHarness } from "./adapter.js"
import { defaultConfig, loadConfig, configPath, resolveConfigDir, saveConfig } from "./config.js"

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

async function cmdScan(args) {
  const dir = resolveConfigDir(args.config)
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
function cmdBatch(args) {
  const dir = resolveConfigDir(args.config)
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
  const merged = { ...auto }
  const rewritten = []
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
  let catchAll = null
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
  if (catchAll) out(`created an "other" batch for ${catchAll.tools.length} tool(s) no batch claimed`)
  if (rewritten.length) out(`kept ${rewritten.length} hand-written batch(es) with no tools in the catalog: ${rewritten.join(", ")}`)
  if (cov.duplicated.length) {
    out(`${cov.duplicated.length} tool(s) sit in more than one batch:`)
    for (const dupTool of cov.duplicated.slice(0, 10)) out(`  ${dupTool.tool} → ${dupTool.groups.join(", ")}`)
  }
}

function cmdGroups(args) {
  const dir = resolveConfigDir(args.config)
  const cfg = loadConfig(dir)
  const cache = readCache(cfg.cachePath || defaultCachePath())
  const groups = Object.keys(cfg.groups || {}).length ? cfg.groups : autoGroups(cache || { servers: {} })
  const index = toolIndex(cache || {})
  out(`${Object.keys(groups).length} batches`)
  for (const [id, group] of Object.entries(groups)) {
    const count = index.size ? toolsInGroup(group, cache, index).length : 0
    out(`  see_tools_${id.padEnd(16)} ${String(count).padStart(4)} tools  ${(group.title || titleFor(id)).padEnd(18)} ${group.description}`)
  }
  if (index.size) {
    const cov = coverage(groups, cache, index)
    out("")
    out(`${cov.batched} of ${cov.total} catalogued tools are batched`)
    if (cov.unbatched.length) out(`unbatched (${cov.unbatched.length}): ${cov.unbatched.slice(0, 12).join(", ")} — run \`tcc batch\``)
  }
}

function cmdReport(args) {
  const dir = resolveConfigDir(args.config)
  const cfg = loadConfig(dir)
  const metrics = new Metrics(path.join(dir, "metrics.jsonl"))
  const windowMs = args.days ? Number(args.days) * 86_400_000 : 0
  const lines = reportLines(metrics.read(), { windowMs })
  out(lines.join("\n"))
}

async function cmdServe(args) {
  const dir = resolveConfigDir(args.config)
  const cfg = loadConfig(dir)
  const workdir = args.workdir ? path.resolve(args.workdir) : process.cwd()
  const pool = buildPool(cfg, { log: (m) => err(`[tcc] ${m}`), workdir })

  let catalog = readCache(args.cache || defaultCachePath())
  let groups = Object.keys(cfg.groups || {}).length ? cfg.groups : null

  if (!catalog || !groups) {
    err("[tcc] no cached catalog — snapshotting upstreams before serving")
    catalog = await snapshot(pool, {
      log: (m) => err(`[tcc] ${m}`),
      concurrency: 6,
      onResult: (name, entry) => err(`[tcc]   ${entry.ok ? "ok  " : "FAIL"} ${name} (${entry.tools?.length || 0} tools)`),
    })
    writeCache(catalog, args.cache || defaultCachePath())
    groups = groups || autoGroups(catalog)
  }

  const metrics = new Metrics(path.join(dir, "metrics.jsonl"))
  const compactor = new Compactor({ config: cfg, pool, catalog, groups, metrics, log: (m) => err(`[tcc] ${m}`) })
  const shutdown = async () => {
    await compactor.shutdown()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  await compactor.serve()
}

async function cmdBootstrap(args) {
  const dir = resolveConfigDir(args.config)
  const harness = args.harness || "opencode"
  const cfg = loadConfig(dir)
  const detected = detectHarnesses({ only: [harness] })
  const servers = Object.fromEntries(Object.entries(detected.servers).filter(([name]) => name !== "compactor"))
  const count = Object.keys(servers).length
  if (!count) {
    out(`no MCP servers found in ${HARNESSES[harness]?.label || harness} — nothing to compact`)
    return
  }
  cfg.mcp = servers
  const pool = buildPool(cfg, { log: (m) => err(`  ${m}`) })
  err("snapshotting tools…")
  const catalog = await snapshot(pool, {
    log: (m) => err(`  ! ${m}`),
    onResult: (name, entry) => err(`  ${entry.ok ? "✓" : "✗"} ${name.padEnd(24)} ${entry.ok ? `${entry.tools.length} tools` : entry.error}`),
  })
  pool.closeAll()
  writeCache(catalog, cfg.cachePath || defaultCachePath())
  cfg.groups = autoGroups(catalog)
  if (args.builtins) cfg.builtins = { enabled: true, tools: DEFAULT_BUILTINS, workdir: process.cwd() }
  saveConfig(cfg, { backup: true })

  const cliPath = path.resolve(new URL("../bin/tcc.js", import.meta.url).pathname)
  const result = installIntoHarness(harness, {
    command: "node",
    args: [cliPath, "serve", "--config", dir],
    removeServers: Object.keys(servers),
  })
  const { tools, tokens } = totals(catalog)
  out("")
  out(`compacted ${count} servers (${tools} tools, ~${tokens} tokens) into ${Object.keys(cfg.groups).length} groups`)
  if (result.toml) {
    out("")
    out(`${HARNESSES[harness].label} uses TOML — add this to ${result.path}:`)
    out("")
    out("  [mcp_servers.compactor]")
    out('  command = "node"')
    out(`  args = ["${cliPath}", "serve", "--config", "${dir}"]`)
  } else {
    out(`wrote ${result.path} (backup: ${result.path}.bak-tcc)`)
    out(`  removed ${result.removed} server definitions, added "compactor"`)
  }
  out("")
  out(`config: ${configPath(dir)}`)
  out("Restart the harness so it picks up the new tool list.")
}

function cmdInstall(args) {
  const dir = resolveConfigDir(args.config)
  const cfg = loadConfig(dir)
  const harness = args.harness
  if (!harness) {
    out(`--harness is required. Known: ${Object.keys(HARNESSES).join(", ")}`)
    process.exitCode = 1
    return
  }
  const cliPath = path.resolve(new URL("../bin/tcc.js", import.meta.url).pathname)
  const remove = args.remove === undefined ? Object.keys(cfg.mcp || {}) : args.remove === true ? [] : String(args.remove).split(",").map((s) => s.trim())
  const result = installIntoHarness(harness, {
    command: args.command || "node",
    args: [cliPath, "serve", "--config", dir],
    serverName: args.serverName || "compactor",
    removeServers: remove,
  })
  if (result.toml) {
    out(`Add this to ${result.path}:`)
    out("")
    out("  [mcp_servers.compactor]")
    out(`  command = "${args.command || "node"}"`)
    out(`  args = ["${cliPath}", "serve", "--config", "${dir}"]`)
    return
  }
  out(`wrote ${result.path} (backup: ${result.path}.bak-tcc)`)
  out(`removed ${result.removed} server definitions, added "${result.wrote}"`)
  out("")
  out("Restart the harness so it picks up the new tool list.")
}

/** Prove the built-ins work: run each one against a scratch directory and check
 *  the observable result, not that a function returned. */
async function cmdSelftest() {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcc-selftest-"))
  const up = new BuiltinUpstream({ cwd: dir, tools: Object.keys(BUILTINS) })
  const fails = []
  const check = (name, condition, detail = "") => {
    out(`${condition ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
    if (!condition) fails.push(name)
  }
  const text = (r) => r.content.map((c) => c.text || "").join("\n")

  let r = await up.callTool("write", { filePath: "src/hello.txt", content: "alpha\nbeta\ngamma\n" })
  check("write creates parent directories", existsSync(path.join(dir, "src/hello.txt")), text(r))

  r = await up.callTool("read", { filePath: "src/hello.txt", offset: 2, limit: 2 })
  check("read returns numbered lines", /2→beta/.test(text(r)), text(r).split("\n")[1])

  r = await up.callTool("edit", { filePath: "src/hello.txt", oldString: "beta", newString: "BETA" })
  check("edit replaces text", fs.readFileSync(path.join(dir, "src/hello.txt"), "utf8").includes("BETA"), text(r))

  r = await up.callTool("edit", { filePath: "src/hello.txt", oldString: "zzz", newString: "x" })
  check("edit fails when oldString is absent", r.isError === true)

  r = await up.callTool("glob", { pattern: "**/*.txt" })
  check("glob finds the file", text(r).includes("hello.txt"), text(r))

  r = await up.callTool("grep", { pattern: "BETA", path: "src" })
  check("grep finds the line", /hello\.txt:2/.test(text(r)), text(r))

  r = await up.callTool("bash", { command: "echo $((6*7))" })
  check("bash runs and returns stdout", text(r).includes("42"), text(r))

  r = await up.callTool("bash", { command: "exit 3" })
  check("bash reports a failing exit code", r.isError === true && /exit 3/.test(text(r)))

  const http = await import("node:http")
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<html><body><h1>Hello</h1><script>bad()</script><p>fetch works</p></body></html>")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  r = await up.callTool("webfetch", { url: `http://127.0.0.1:${port}/page` })
  check("webfetch fetches and strips HTML", /fetch works/.test(text(r)) && !/<script>/.test(text(r)), text(r).split("\n")[0])
  server.close()

  fs.rmSync(dir, { recursive: true, force: true })
  out("")
  out(fails.length ? `${fails.length} failing: ${fails.join(", ")}` : `all ${Object.keys(BUILTINS).length} built-ins work`)
  if (fails.length) process.exitCode = 1
}

function cmdSnippet(args) {
  const dir = resolveConfigDir(args.config)
  const cliPath = path.resolve(new URL("../bin/tcc.js", import.meta.url).pathname)
  const harness = args.harness || "opencode"
  const spec = HARNESSES[harness]
  if (!spec) {
    out(`unknown harness "${harness}". Known: ${Object.keys(HARNESSES).join(", ")}`)
    process.exitCode = 1
    return
  }
  out(`# ${spec.label} — ${spec.paths[0]}`)
  out("")
  if (spec.key === "mcp") {
    out(JSON.stringify({ mcp: { compactor: { type: "local", command: ["node", cliPath, "serve", "--config", dir], enabled: true } } }, null, 2))
  } else if (spec.format === "toml") {
    out("[mcp_servers.compactor]")
    out('command = "node"')
    out(`args = ["${cliPath}", "serve", "--config", "${dir}"]`)
  } else {
    out(JSON.stringify({ [spec.key]: { compactor: { command: "node", args: [cliPath, "serve", "--config", dir] } } }, null, 2))
  }
}

function cmdHarnesses() {
  const detected = detectHarnesses()
  for (const row of detected.report) {
    out(`${row.label.padEnd(16)} ${row.found ? "found" : "absent"}  ${String(row.count).padStart(3)} servers  ${row.path}`)
  }
}

const HELP = `tool-call-compactor — keep tool schemas out of the prompt until they are needed

  tcc init [--harness a,b] [--builtins] [--include-disabled] [--config DIR]
                                                         detect servers, snapshot, write batches
  tcc bootstrap [--harness NAME] [--builtins]            init + install, in one step
  tcc install --harness NAME [--remove a,b] [--config DIR]
  tcc snippet --harness NAME                             print the config fragment instead
  tcc scan [--config DIR]                                re-snapshot and show the grouping
  tcc batch [--config DIR]                               rebuild batches, keeping your titles
  tcc groups [--config DIR]                              print the advertised index
  tcc report [--config DIR] [--days N]                   what it saved, from real metrics
  tcc serve [--config DIR] [--workdir PATH]              run the MCP server (a harness runs this)
  tcc selftest                                           exercise the built-in tools
  tcc harnesses                                          show detected harness configs

Harnesses: ${Object.keys(HARNESSES).join(", ")}
`

export async function main(argv) {
  const args = parseArgs(argv)
  const command = args._[0] || "help"
  switch (command) {
    case "init":
      return cmdInit(args)
    case "bootstrap":
      return cmdBootstrap(args)
    case "install":
      return cmdInstall(args)
    case "snippet":
      return cmdSnippet(args)
    case "scan":
      return cmdScan(args)
    case "batch":
      return cmdBatch(args)
    case "groups":
      return cmdGroups(args)
    case "report":
      return cmdReport(args)
    case "serve":
      return cmdServe(args)
    case "selftest":
      return cmdSelftest(args)
    case "harnesses":
      return cmdHarnesses(args)
    case "help":
    case "--help":
    case "-h":
      out(HELP)
      return
    default:
      err(`unknown command: ${command}`)
      out(HELP)
      process.exitCode = 1
  }
}
