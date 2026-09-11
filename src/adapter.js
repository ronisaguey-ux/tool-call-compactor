// Harness adapters: find the MCP servers a machine already has configured.
//
// Every agentic harness keeps the same information in a different file under a
// different key. Reading them all is what makes `tcc init` a one-liner instead
// of a copy-paste exercise — and what lets one compactor serve every harness on
// the box at once.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { expandHome } from "./config.js"

const home = os.homedir()

/** Each entry: the config file(s) to probe, which key holds the servers, and how
 *  to write back. `enabledKey` marks harnesses that carry a disable flag. */
export const HARNESSES = {
  opencode: {
    label: "opencode",
    paths: ["~/.config/opencode/opencode.json"],
    key: "mcp",
    enabledKey: "enabled",
    /* opencode marks disabled servers with `enabled: false` (and it is not
     * always the first key, so we read the object, never the text). */
    disabled: (spec) => spec.enabled === false,
    clients: ["opencode"],
  },
  "claude-code": {
    label: "Claude Code",
    paths: ["~/.claude.json", "~/.config/claude/claude.json"],
    key: "mcpServers",
    clients: ["claude-code"],
  },
  "claude-desktop": {
    label: "Claude Desktop",
    paths: ["~/.config/Claude/claude_desktop_config.json", "~/Library/Application Support/Claude/claude_desktop_config.json"],
    key: "mcpServers",
    clients: ["claude-desktop"],
  },
  cursor: {
    label: "Cursor",
    paths: ["~/.cursor/mcp.json", "~/.config/Cursor/User/mcp.json"],
    key: "mcpServers",
    clients: ["cursor"],
  },
  vscode: {
    label: "VS Code",
    paths: ["~/.config/Code/User/mcp.json", "~/Library/Application Support/Code/User/mcp.json"],
    key: "servers",
    clients: ["vscode"],
  },
  windsurf: {
    label: "Windsurf",
    paths: ["~/.codeium/windsurf/mcp_config.json"],
    key: "mcpServers",
    clients: ["windsurf"],
  },
  codex: {
    label: "Codex",
    paths: ["~/.codex/config.toml"],
    key: "mcp_servers",
    format: "toml",
    clients: ["codex"],
  },
  hermes: {
    label: "Hermes",
    paths: ["~/.config/hermes/mcp.json", "~/.hermes/mcp.json", "~/.config/hermes/config.json"],
    key: "mcpServers",
    altKeys: ["mcp", "servers"],
    clients: ["hermes"],
  },
  cline: {
    label: "Cline",
    paths: ["~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"],
    key: "mcpServers",
    clients: ["cline"],
  },
}

/** Substitute ${VAR} and $VAR from the environment, leaving unknown names
 *  intact so a missing variable is visible rather than silently empty. */
export function substituteEnv(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
      const name = a || b
      return process.env[name] !== undefined ? process.env[name] : m
    })
  }
  if (Array.isArray(value)) return value.map(substituteEnv)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]))
  }
  return value
}

/** Minimal TOML reader covering what an MCP config actually uses: `[table]` and
 *  `[table.sub]` headers, `key = "str"`, `key = 123`, `key = true`, arrays of
 *  strings, and `{ inline = "tables" }`. Not a general TOML parser — Codex's
 *  config.toml is the only caller and this reads exactly the shape it writes. */
export function parseToml(text) {
  const root = {}
  let cursor = root
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const comment = findComment(line)
    if (comment >= 0) line = line.slice(0, comment)
    line = line.trim()
    if (!line) continue
    if (line.startsWith("[[")) continue // array-of-tables: not used by mcp_servers
    if (line.startsWith("[")) {
      const name = line.replace(/^\[+|\]+$/g, "").trim()
      cursor = root
      for (const part of splitKey(name)) {
        if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {}
        cursor = cursor[part]
      }
      continue
    }
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, "")
    let raw = line.slice(eq + 1).trim()
    // Multi-line array: keep pulling lines until brackets balance.
    while (unbalanced(raw) && i + 1 < lines.length) {
      i += 1
      raw += " " + lines[i].trim()
    }
    cursor[key] = parseTomlValue(raw)
  }
  return root
}

function findComment(line) {
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr
    else if (c === "#" && !inStr) return i
  }
  return -1
}

function unbalanced(text) {
  let depth = 0
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' && text[i - 1] !== "\\") inStr = !inStr
    else if (!inStr && (c === "[" || c === "{")) depth++
    else if (!inStr && (c === "]" || c === "}")) depth--
  }
  return depth > 0
}

function splitKey(name) {
  return name.split(".").map((p) => p.trim().replace(/^"|"$/g, ""))
}

function parseTomlValue(raw) {
  raw = raw.trim()
  if (raw.startsWith('"')) return raw.replace(/^"|"$/g, "")
  if (raw.startsWith("'")) return raw.replace(/^'|'$/g, "")
  if (raw === "true") return true
  if (raw === "false") return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (raw.startsWith("[")) {
    const inner = raw.slice(1, -1)
    return splitTopLevel(inner).map((v) => parseTomlValue(v)).filter((v) => v !== "")
  }
  if (raw.startsWith("{")) {
    const out = {}
    for (const pair of splitTopLevel(raw.slice(1, -1))) {
      const eq = pair.indexOf("=")
      if (eq < 0) continue
      out[pair.slice(0, eq).trim().replace(/^"|"$/g, "")] = parseTomlValue(pair.slice(eq + 1))
    }
    return out
  }
  return raw
}

function splitTopLevel(text) {
  const out = []
  let depth = 0
  let inStr = false
  let current = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' && text[i - 1] !== "\\") inStr = !inStr
    if (!inStr) {
      if (c === "[" || c === "{") depth++
      else if (c === "]" || c === "}") depth--
      else if (c === "," && depth === 0) {
        out.push(current.trim())
        current = ""
        continue
      }
    }
    current += c
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export function resolvePath(p) {
  return path.resolve(expandHome(p))
}

/** Read one harness config. Returns { found, path, servers, raw } — `found` is
 *  about the file, not about it containing servers.
 *
 *  `includeDisabled` also picks up servers the harness has switched off. They
 *  are usually the most expensive ones — a 286-tool engine server switched off
 *  to save context is exactly what a compactor can afford to carry. */
export function readHarness(name, { includeDisabled = false } = {}) {
  const spec = HARNESSES[name]
  if (!spec) throw new Error(`unknown harness: ${name}`)
  for (const candidate of spec.paths) {
    const file = resolvePath(candidate)
    if (!existsSync(file)) continue
    let raw
    try {
      raw = spec.format === "toml" ? parseToml(readFileSync(file, "utf8")) : JSON.parse(readFileSync(file, "utf8"))
    } catch (err) {
      return { found: true, path: file, servers: {}, error: `could not parse: ${err.message}` }
    }
    const keys = [spec.key, ...(spec.altKeys || [])]
    let container = null
    for (const key of keys) {
      if (raw && typeof raw[key] === "object" && raw[key]) {
        container = raw[key]
        break
      }
    }
    if (!container) continue
    const servers = {}
    const disabled = []
    for (const [serverName, serverSpec] of Object.entries(container)) {
      if (!serverSpec || typeof serverSpec !== "object") continue
      if (spec.disabled && spec.disabled(serverSpec)) {
        disabled.push(serverName)
        if (!includeDisabled) continue
      }
      const clean = { ...serverSpec }
      delete clean.enabled
      servers[serverName] = substituteEnv(clean)
    }
    return { found: true, path: file, servers, disabled, raw }
  }
  return { found: false, path: resolvePath(spec.paths[0]), servers: {} }
}

/** Every harness on this machine, merged. First definition of a server name
 *  wins, so ordering here is the precedence order. */
export function detectHarnesses({ only, includeDisabled = false } = {}) {
  const names = only && only.length ? only : Object.keys(HARNESSES)
  const merged = {}
  const sources = {}
  const report = []
  for (const name of names) {
    const result = readHarness(name, { includeDisabled })
    report.push({ harness: name, label: HARNESSES[name].label, ...result, count: Object.keys(result.servers).length })
    for (const [serverName, spec] of Object.entries(result.servers)) {
      if (merged[serverName]) continue
      merged[serverName] = spec
      sources[serverName] = name
    }
  }
  return { servers: merged, sources, report }
}

export function compactorSpec({ harness = "opencode", command = "node", args = [] } = {}) {
  const spec = { type: "stdio", command, args, enabled: true }
  if (harness === "codex") return { command, args }
  return spec
}

/** Write a compactor entry into a harness config, replacing the servers it now
 *  fronts. Returns { path, removed, wrote } — never writes without a backup. */
export function installIntoHarness(name, { serverName = "compactor", command, args, removeServers = [] } = {}) {
  const spec = HARNESSES[name]
  if (!spec) throw new Error(`unknown harness: ${name}`)
  if (spec.format === "toml") {
    return { path: resolvePath(spec.paths[0]), unsupported: true, toml: true }
  }
  let file = null
  for (const candidate of spec.paths) {
    if (existsSync(resolvePath(candidate))) {
      file = resolvePath(candidate)
      break
    }
  }
  if (!file) file = resolvePath(spec.paths[0])
  let raw = {}
  if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf8"))
  const key = raw[spec.key] ? spec.key : (spec.altKeys || []).find((k) => raw[k]) || spec.key
  raw[key] = raw[key] || {}
  let removed = 0
  for (const victim of removeServers) {
    if (raw[key][victim]) {
      delete raw[key][victim]
      removed += 1
    }
  }
  raw[key][serverName] = spec.enabledKey ? { type: "local", command: [command, ...args], enabled: true } : { command, args }
  mkdirSync(path.dirname(file), { recursive: true })
  if (existsSync(file)) copyFileSync(file, `${file}.bak-tcc`)
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", "utf8")
  return { path: file, removed, wrote: serverName }
}
