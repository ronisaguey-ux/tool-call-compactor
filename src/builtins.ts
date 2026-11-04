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
import type { JsonSchema, Logger, McpCallToolResult, McpToolSchema, UpstreamStats } from "./types.js"

const MAX_OUTPUT = 30_000
const IGNORED_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"])

export function clamp(text: string, max: number = MAX_OUTPUT): string {
  if (text.length <= max) return text
  const dropped = text.length - max
  return `${text.slice(0, Math.floor(max * 0.7))}\n… [truncated ${dropped} characters] …\n${text.slice(-Math.floor(max * 0.3))}`
}

const ok = (text: string): McpCallToolResult => ({ content: [{ type: "text", text: clamp(text) }] })
const fail = (text: string): McpCallToolResult => ({ content: [{ type: "text", text }], isError: true })

/** Glob → RegExp. Supports **, *, ?, {a,b} and character classes — the subset
 *  every agent actually types. */
export function globToRegExp(pattern: string): RegExp {
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

function walk(root: string, { maxFiles = 20_000, followLinks = false }: { maxFiles?: number; followLinks?: boolean } = {}): string[] {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop() as string
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

function isProbablyText(file: string): boolean {
  try {
    const fd = readFileSync(file)
    const slice = fd.subarray(0, 8192)
    return !slice.includes(0)
  } catch {
    return false
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Everything a built-in tool is allowed to touch: the workspace it resolves
 *  relative paths against, the deadline, and any extra environment. */
export interface BuiltinContext {
  cwd: string
  timeoutMs: number
  env: NodeJS.ProcessEnv
}

export interface BuiltinTool {
  definition: McpToolSchema
  run(args: Record<string, unknown>, ctx: BuiltinContext): Promise<McpCallToolResult>
}

const schema = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: "object", properties, required })

/** The registry. Each entry is a real tool: a definition the agent reads, and a
 *  run() that does the work. */
export const BUILTINS: Record<string, BuiltinTool> = {
  bash: {
    definition: {
      name: "bash",
      description:
        "Run a shell command and return its stdout and stderr. Use for git, tests, builds, package managers and anything else the shell does.",
      inputSchema: schema({
        command: { type: "string", description: "Shell command to run." },
        workdir: { type: "string", description: "Directory to run in. Defaults to the project root." },
        timeout: { type: "number", description: "Seconds before the command is killed (default 120)." },
      }, ["command"]),
    },
    async run(args, ctx) {
      if (!args?.command) return fail("bash needs a command")
      const command = args.command as string
      const timeoutMs = Math.min(Math.max(Number(args.timeout) || 120, 1), 3600) * 1000
      const cwd = args.workdir ? path.resolve(ctx.cwd, args.workdir as string) : ctx.cwd
      return await new Promise<McpCallToolResult>((resolve) => {
        const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, ...ctx.env } })
        let stdout = ""
        let stderr = ""
        let killed = false
        const timer = setTimeout(() => {
          killed = true
          child.kill("SIGKILL")
        }, timeoutMs)
        // stdio was not redirected, so both pipes exist; the types only say
        // they might not because spawn() allows any stdio configuration.
        child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()))
        child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()))
        child.on("error", (err) => {
          clearTimeout(timer)
          resolve(fail(`could not start command: ${err.message}`))
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          const parts = [stdout.trimEnd()]
          if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`)
          if (killed) parts.push(`[killed after ${timeoutMs / 1000}s]`)
          parts.push(`[exit ${code}]`)
          const text = clamp(parts.filter(Boolean).join("\n"))
          resolve(code === 0 ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], isError: true })
        })
      })
    },
  },

  read: {
    definition: {
      name: "read",
      description: "Read a text file and return its contents with line numbers. Supports an offset and limit for large files.",
      inputSchema: schema({
        filePath: { type: "string", description: "Absolute path to the file." },
        offset: { type: "number", description: "First line to read (1-based)." },
        limit: { type: "number", description: "How many lines to read (default 2000)." },
      }, ["filePath"]),
    },
    async run(args, ctx) {
      const file = path.resolve(ctx.cwd, (args?.filePath as string) || "")
      if (!args?.filePath) return fail("read needs a filePath")
      if (!existsSync(file)) return fail(`no such file: ${file}`)
      const stat = statSync(file)
      if (stat.isDirectory()) return fail(`${file} is a directory — use glob to list files`)
      const offset = Math.max(1, Number(args.offset) || 1)
      const limit = Math.min(Math.max(Number(args.limit) || 2000, 1), 20_000)
      const lines = readFileSync(file, "utf8").split("\n")
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const width = String(offset + slice.length - 1).length
      const numbered = slice.map((line, i) => `${String(offset + i).padStart(width)}→${line}`).join("\n")
      const more = offset - 1 + limit < lines.length ? `\n… ${lines.length - (offset - 1 + limit)} more lines` : ""
      return ok(`${file} (${lines.length} lines)\n${numbered}${more}`)
    },
  },

  write: {
    definition: {
      name: "write",
      description: "Create a file or replace its entire contents. Parent directories are created automatically.",
      inputSchema: schema({
        filePath: { type: "string", description: "Absolute path to write." },
        content: { type: "string", description: "Full file contents." },
      }, ["filePath", "content"]),
    },
    async run(args, ctx) {
      if (!args?.filePath) return fail("write needs a filePath")
      const file = path.resolve(ctx.cwd, args.filePath as string)
      mkdirSync(path.dirname(file), { recursive: true })
      const content = (args.content as string | undefined) ?? ""
      writeFileSync(file, content, "utf8")
      const bytes = Buffer.byteLength(content, "utf8")
      return ok(`wrote ${file} (${bytes} bytes)`)
    },
  },

  edit: {
    definition: {
      name: "edit",
      description:
        "Replace an exact string in a file. oldString must match once, or set replaceAll. Fails rather than guessing when the text is ambiguous.",
      inputSchema: schema({
        filePath: { type: "string", description: "Absolute path to edit." },
        oldString: { type: "string", description: "Exact text to replace." },
        newString: { type: "string", description: "Replacement text." },
        replaceAll: { type: "boolean", description: "Replace every occurrence." },
      }, ["filePath", "oldString", "newString"]),
    },
    async run(args, ctx) {
      const { filePath, oldString, newString } = args || {}
      if (!filePath || typeof oldString !== "string" || typeof newString !== "string") {
        return fail("edit needs filePath, oldString and newString")
      }
      const file = path.resolve(ctx.cwd, filePath as string)
      if (!existsSync(file)) return fail(`no such file: ${file}`)
      const before = readFileSync(file, "utf8")
      const parts = before.split(oldString)
      const count = parts.length - 1
      if (count === 0) return fail(`oldString not found in ${file}`)
      if (count > 1 && !args.replaceAll) {
        return fail(`oldString appears ${count} times in ${file} — add more context or set replaceAll`)
      }
      const after = args.replaceAll ? parts.join(newString) : before.replace(oldString, newString)
      writeFileSync(file, after, "utf8")
      return ok(`edited ${file} (${args.replaceAll ? count : 1} replacement${count === 1 ? "" : "s"})`)
    },
  },

  glob: {
    definition: {
      name: "glob",
      description: "Find files by glob pattern, e.g. **/*.test.js. Returns paths sorted by most recently modified.",
      inputSchema: schema({
        pattern: { type: "string", description: "Glob pattern, ** and * supported." },
        path: { type: "string", description: "Directory to search from. Defaults to the project root." },
        limit: { type: "number", description: "Maximum paths to return (default 200)." },
      }, ["pattern"]),
    },
    async run(args, ctx) {
      if (!args?.pattern) return fail("glob needs a pattern")
      const pattern = args.pattern as string
      const root = path.resolve(ctx.cwd, (args.path as string) || ".")
      if (!existsSync(root)) return fail(`no such directory: ${root}`)
      const re = globToRegExp(pattern)
      const limit = Math.min(Number(args.limit) || 200, 5000)
      const matches: Array<{ file: string; mtime: number }> = []
      for (const file of walk(root)) {
        const rel = path.relative(root, file)
        if (re.test(rel) || re.test(path.basename(file))) {
          matches.push({ file, mtime: statSync(file).mtimeMs })
        }
      }
      matches.sort((a, b) => b.mtime - a.mtime)
      if (!matches.length) return ok(`no files matched ${pattern} under ${root}`)
      const shown = matches.slice(0, limit).map((m) => m.file)
      return ok(`${matches.length} match${matches.length === 1 ? "" : "es"}\n${shown.join("\n")}`)
    },
  },

  grep: {
    definition: {
      name: "grep",
      description: "Search file contents with a regular expression and return matching lines with file and line number.",
      inputSchema: schema({
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "File or directory to search. Defaults to the project root." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. *.ts." },
        ignoreCase: { type: "boolean", description: "Case-insensitive search." },
        maxResults: { type: "number", description: "Maximum matching lines (default 200)." },
      }, ["pattern"]),
    },
    async run(args, ctx) {
      if (!args?.pattern) return fail("grep needs a pattern")
      const pattern = args.pattern as string
      let re: RegExp
      try {
        re = new RegExp(pattern, args.ignoreCase ? "i" : "")
      } catch (err) {
        return fail(`invalid regular expression: ${(err as Error).message}`)
      }
      const target = path.resolve(ctx.cwd, (args.path as string) || ".")
      if (!existsSync(target)) return fail(`no such path: ${target}`)
      const filter = args.glob ? globToRegExp(args.glob as string) : null
      const max = Math.min(Number(args.maxResults) || 200, 5000)
      const files = statSync(target).isDirectory() ? walk(target) : [target]
      const hits: string[] = []
      for (const file of files) {
        if (filter && !filter.test(path.basename(file)) && !filter.test(path.relative(target, file))) continue
        if (!isProbablyText(file)) continue
        let content: string
        try {
          content = readFileSync(file, "utf8")
        } catch {
          continue
