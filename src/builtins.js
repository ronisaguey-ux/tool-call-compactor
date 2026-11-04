// Built-in tools, reimplemented so they can live behind a group like any MCP tool.
//
// A harness's own tools (bash, read, write, edit, glob, grep) sit in the prefix
// exactly like MCP schemas do. Nothing can remove them from the outside — but a
// harness can be told to disable them, and then these take their place, which
// means the schemas arrive only when the group is fetched.
//
// The trade is real and worth stating: relaying a tool means losing whatever the
// harness wrapped around it (its diff view, its permission prompt). That is why
// the builtins are opt-in and grouped separately from MCP servers.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

const MAX_OUTPUT = 30_000
const IGNORED_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"])

export function clamp(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text
  const dropped = text.length - max
  return `${text.slice(0, Math.floor(max * 0.7))}\n… [truncated ${dropped} characters] …\n${text.slice(-Math.floor(max * 0.3))}`
}

const ok = (text) => ({ content: [{ type: "text", text: clamp(text) }] })
const fail = (text) => ({ content: [{ type: "text", text }], isError: true })

/** Glob → RegExp. Supports **, *, ?, {a,b} and character classes — the subset
 *  every agent actually types. */
export function globToRegExp(pattern) {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 1
        if (pattern[i + 1] === "/") {
          i += 1
          re += "(?:.*/)?"
        } else re += ".*"
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else if (c === "{") {
      const end = pattern.indexOf("}", i)
      if (end < 0) re += "\\{"
      else {
        re += "(?:" + pattern.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|") + ")"
        i = end
      }
    } else if (c === "[") {
      const end = pattern.indexOf("]", i)
      if (end < 0) re += "\\["
      else {
        re += pattern.slice(i, end + 1)
        i = end
      }
    } else re += /[.+^${}()|\\]/.test(c) ? "\\" + c : c
  }
  return new RegExp("^" + re + "$")
}

function walk(root, { maxFiles = 20_000, followLinks = false } = {}) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== "." && IGNORED_DIRS.has(entry.name)) continue
      if (IGNORED_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() || (followLinks && entry.isSymbolicLink())) out.push(full)
    }
  }
  return out
}

function isProbablyText(file) {
  try {
    const fd = readFileSync(file)
    const slice = fd.subarray(0, 8192)
    return !slice.includes(0)
  } catch {
    return false
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
