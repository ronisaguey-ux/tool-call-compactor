// Config: where the compactor keeps its server list, its groups and its knobs.
//
// One file, human-editable, and the same file the CLI, the server and a control
// request all read — so "the agent edited its own group description" is a real
// state change, not a note in a log.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

export const CONFIG_NAME = "tcc.config.json"

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
      dynamic: true,
      compress: true,
      maxText: 10_000,
      control: { enabled: true, host: "127.0.0.1", port: 4750, token: null },
    },
  }
}

export function loadConfig(dir) {
  const file = configPath(dir)
  if (!existsSync(file)) return { ...defaultConfig(), dir, file, exists: false }
  const cfg = JSON.parse(readFileSync(file, "utf8"))
  const base = defaultConfig()
  return {
    ...base,
    ...cfg,
    options: { ...base.options, ...(cfg.options || {}), control: { ...base.options.control, ...(cfg.options?.control || {}) } },
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
