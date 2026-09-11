// Config: where the compactor keeps its server list, its groups and its knobs.
//
// One file, human-editable, and the same file the CLI, the server and a control
// request all read — so "the agent edited its own group description" is a real
// state change, not a note in a log.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

export const CONFIG_NAME = "tcc.config.json"

/** What `dynamic: true` meant before `persist` existed: expose a fetched batch,
 *  but only while it stays cheap. Kept so an existing config keeps behaving the
 *  way it was written. */
export const LEGACY_DYNAMIC_BUDGET = 4_000

export const PERSIST_MODES = ["off", "auto", "agent"]

/** How a fetched batch's schemas come back to live in the harness's tool list.
 *
 *  - `off`   — never; the agent calls `see_tools_<group>` then `call_tool`.
 *  - `auto`  — every batch the agent fetches is registered for the rest of the
 *              session, so later calls hit it directly.
 *  - `agent` — only when the agent asks (`persist: true`, or `persist_group`).
 *
 *  `persistBudget` caps `auto` in tokens; `0` means no cap. The policy is read
 *  from the options the *file* actually contains, so an old config that only
 *  says `dynamic: true` keeps its old budget instead of silently losing it. */
export function persistPolicy(options = {}, { legacyBudget = LEGACY_DYNAMIC_BUDGET } = {}) {
  const o = options || {}
  const tokens = (value, fallback) => {
    const n = Number(value ?? fallback)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  if (o.persist !== undefined && o.persist !== null) {
    const mode = PERSIST_MODES.includes(o.persist) ? o.persist : "auto"
    return { mode, budget: tokens(o.persistBudget, 0), source: "persist" }
  }
  if (o.dynamic === false) return { mode: "off", budget: 0, source: "dynamic" }
  if (o.dynamic === "always") return { mode: "auto", budget: 0, source: "dynamic" }
  if (o.dynamic === true || o.dynamicBudget !== undefined) {
    return { mode: "auto", budget: tokens(o.dynamicBudget, legacyBudget), source: "dynamic" }
  }
  return { mode: "auto", budget: 0, source: "default" }
}

export function expandHome(p) {
  if (!p) return p
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

/** Config dir resolution, in order: explicit flag, $TCC_CONFIG_DIR, the current
 *  directory if it already holds a config, then the XDG home. */
export function resolveConfigDir(explicit) {
  if (explicit) return path.resolve(expandHome(explicit))
  if (process.env.TCC_CONFIG_DIR) return path.resolve(expandHome(process.env.TCC_CONFIG_DIR))
  if (existsSync(path.resolve(CONFIG_NAME))) return process.cwd()
  return expandHome("~/.config/tool-call-compactor")
}

export function configPath(dir) {
  return path.join(dir, CONFIG_NAME)
}

export function defaultConfig() {
  return {
    $schema: "https://github.com/ronisaguey-ux/tool-call-compactor",
    mcp: {},
    groups: {},
    options: {
      idleMs: 300_000,
      timeoutMs: 60_000,
      retries: 2,
      cacheTtlMs: 86_400_000,
      persist: "auto",
      persistBudget: 0,
      compress: true,
      maxText: 10_000,
      control: { enabled: true, host: "127.0.0.1", port: 4750, token: null },
    },
  }
}

export function loadConfig(dir) {
  const file = configPath(dir)
  if (!existsSync(file)) return { ...defaultConfig(), dir, file, exists: false, rawOptions: {} }
  const cfg = JSON.parse(readFileSync(file, "utf8"))
  const base = defaultConfig()
  return {
    ...base,
    ...cfg,
    options: { ...base.options, ...(cfg.options || {}), control: { ...base.options.control, ...(cfg.options?.control || {}) } },
    // The options as written, before defaults filled the gaps — the persist
    // policy needs to know whether `persist` was actually chosen, or whether it
    // is a default sitting on top of a legacy `dynamic`.
    rawOptions: cfg.options || {},
    dir,
    file,
    exists: true,
  }
}

export function saveConfig(cfg, { backup = false } = {}) {
  mkdirSync(cfg.dir, { recursive: true })
  if (backup && existsSync(cfg.file)) {
    copyFileSync(cfg.file, `${cfg.file}.bak`)
  }
  const out = {
    $schema: cfg.$schema || defaultConfig().$schema,
    mcp: cfg.mcp || {},
    groups: cfg.groups || {},
    options: cfg.options || defaultConfig().options,
  }
  writeFileSync(cfg.file, JSON.stringify(out, null, 2) + "\n", "utf8")
  return cfg.file
}
