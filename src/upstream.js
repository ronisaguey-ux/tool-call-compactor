// Upstream MCP servers, connected lazily and shut down when idle.
//
// An upstream is a child process (stdio) or an HTTP endpoint. Nothing is spawned
// until a tool from that server is actually needed, and a connection that has
// been quiet for IDLE_MS is closed — so a session that only touches GitHub never
// pays for a browser server running in the background.

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export const DEFAULT_IDLE_MS = 5 * 60 * 1000
export const DEFAULT_TIMEOUT_MS = 60_000

/** Accepts opencode-style (`type`/`command`/`environment`/`url`/`headers`),
 *  Claude-Desktop-style (`command`/`args`/`env`) and mcmcp-style specs alike. */
export function normalizeSpec(spec) {
  if (spec.url || spec.type === "remote" || spec.transport === "http" || spec.transport === "sse") {
    return { kind: "http", url: spec.url, headers: spec.headers || {} }
  }
  const command = Array.isArray(spec.command) ? spec.command : [spec.command, ...(spec.args || [])]
  if (!command[0]) throw new Error("upstream spec has neither url nor command")
  const env = spec.environment || spec.env || {}
  return {
    kind: "stdio",
    command: command[0],
    args: command.slice(1),
    env: { ...process.env, ...env },
    cwd: spec.cwd,
  }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)
    }),
  ])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Upstream {
  constructor(name, spec, opts = {}) {
    this.name = name
    this.spec = normalizeSpec(spec)
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = opts.retries ?? 2
    this.log = opts.log ?? (() => {})
    this.client = null
    this.connecting = null
    this.idleTimer = null
    this.tools = null // cached tools/list for this connection
    this.stats = { calls: 0, errors: 0, spawns: 0, lastUsed: 0 }
  }

  async connect() {
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const transport =
        this.spec.kind === "http"
          ? new StreamableHTTPClientTransport(new URL(this.spec.url), {
              requestInit: { headers: this.spec.headers },
            })
          : new StdioClientTransport({
              command: this.spec.command,
              args: this.spec.args,
              env: this.spec.env,
              cwd: this.spec.cwd,
              stderr: "ignore",
            })
      const client = new Client({ name: "tool-call-compactor", version: "0.1.0" }, { capabilities: {} })
      await client.connect(transport)
      this.client = client
      this.stats.spawns += 1
      this.log(`upstream connected: ${this.name}`)
      return client
    })()
    try {
      return await this.connecting
    } catch (err) {
      this.client = null
      throw err
    } finally {
      this.connecting = null
    }
  }

  touch() {
    this.stats.lastUsed = Date.now()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.idleMs > 0) {
      this.idleTimer = setTimeout(() => this.close("idle"), this.idleMs)
      this.idleTimer.unref?.()
    }
  }

  async listTools() {
    const client = await this.connect()
    this.touch()
    if (this.tools) return this.tools
    const res = await withTimeout(client.listTools(), this.timeoutMs, `${this.name} tools/list`)
    this.tools = res.tools || []
    return this.tools
  }

  /** Calls a tool, retrying only transport-level failures — never a tool that
   *  reported an error of its own, which would just repeat the same failure. */
  async callTool(tool, args) {
    let lastErr
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const client = await this.connect()
        this.touch()
        this.stats.calls += 1
        return await withTimeout(
          client.callTool({ name: tool, arguments: args || {} }),
          this.timeoutMs,
          `${this.name}.${tool}`,
        )
      } catch (err) {
        lastErr = err
        this.stats.errors += 1
        this.client = null // force a fresh connection on the next attempt
        if (attempt < this.retries) await sleep(150 * 2 ** attempt + Math.random() * 100)
      }
    }
    throw lastErr
  }

  close(reason = "closed") {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const client = this.client
    this.client = null
    this.tools = null
    if (client) {
      this.log(`upstream closed (${reason}): ${this.name}`)
      Promise.resolve(client.close()).catch(() => {})
    }
  }
}

export class UpstreamPool {
  constructor(servers = {}, opts = {}) {
    this.opts = opts
    this.map = new Map()
    for (const [name, spec] of Object.entries(servers)) this.map.set(name, new Upstream(name, spec, opts))
  }

  get(name) {
    const up = this.map.get(name)
    if (!up) throw new Error(`unknown upstream: ${name}`)
    return up
  }

  has(name) {
    return this.map.has(name)
  }

  names() {
    return [...this.map.keys()]
  }

  closeAll() {
    for (const up of this.map.values()) up.close("shutdown")
  }

  stats() {
    return Object.fromEntries([...this.map].map(([n, u]) => [n, { ...u.stats, connected: !!u.client }]))
  }
}
