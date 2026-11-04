// Upstream MCP servers, connected lazily and shut down when idle.
//
// An upstream is a child process (stdio) or an HTTP endpoint. Nothing is spawned
// until a tool from that server is actually needed, and a connection that has
// been quiet for IDLE_MS is closed — so a session that only touches GitHub never
// pays for a browser server running in the background.

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type {
  Logger,
  McpCallToolResult,
  McpServerConfig,
  McpToolSchema,
  ProviderRecordMap,
  UpstreamLike,
  UpstreamStats,
} from "./types.js"

export const DEFAULT_IDLE_MS = 5 * 60 * 1000
export const DEFAULT_TIMEOUT_MS = 60_000

export interface HttpTarget {
  kind: "http"
  url: string
  headers: Record<string, string>
}

export interface StdioTarget {
  kind: "stdio"
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}

export type UpstreamTarget = HttpTarget | StdioTarget

export interface UpstreamOptions {
  idleMs?: number
  timeoutMs?: number
  retries?: number
  log?: Logger
}

/** Accepts opencode-style (`type`/`command`/`environment`/`url`/`headers`),
 *  Claude-Desktop-style (`command`/`args`/`env`) and mcmcp-style specs alike. */
export function normalizeSpec(spec: McpServerConfig): UpstreamTarget {
  if (spec.url || spec.type === "remote" || spec.transport === "http" || spec.transport === "sse") {
    // A remote spec without a url is a broken config; normalizeSpec only promises
    // that a *command* exists, so the transport gets what the file said.
    return { kind: "http", url: spec.url as string, headers: spec.headers || {} }
  }
  let command: unknown[] = []
  if (Array.isArray(spec.command)) {
    command = spec.command
  } else if (typeof spec.command === "string") {
    command = (spec.args && Array.isArray(spec.args) && spec.args.length > 0)
      ? [spec.command, ...spec.args]
      : spec.command.trim().split(/\s+/)
  } else if (Array.isArray(spec.args)) {
    command = spec.args
  }
  if (!command[0]) throw new Error("upstream spec has neither url nor command")
  const env = spec.environment || spec.env || {}
  return {
    kind: "stdio",
    command: command[0] as string,
    args: command.slice(1) as string[],
    env: { ...process.env, ...env },
    cwd: spec.cwd,
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)
    }),
  ])
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class Upstream implements UpstreamLike {
  name: string
  spec: UpstreamTarget
  idleMs: number
  timeoutMs: number
  retries: number
  log: Logger
  client: Client | null
  connecting: Promise<Client> | null
  idleTimer: NodeJS.Timeout | null
  /** cached tools/list for this connection */
  tools: McpToolSchema[] | null
  stats: UpstreamStats

  constructor(name: string, spec: McpServerConfig, opts: UpstreamOptions = {}) {
    this.name = name
    this.spec = normalizeSpec(spec)
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = opts.retries ?? 2
    this.log = opts.log ?? (() => {})
    this.client = null
    this.connecting = null
    this.idleTimer = null
    this.tools = null
    this.stats = { calls: 0, errors: 0, spawns: 0, lastUsed: 0 }
  }

  async connect(): Promise<Client> {
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
              // process.env is spread in so a child inherits the machine it was
              // configured on; the SDK only wants the string half of it.
              env: this.spec.env as Record<string, string>,
              cwd: this.spec.cwd,
              stderr: "ignore",
            })
      const client = new Client({ name: "tool-call-compactor", version: "0.1.0" }, { capabilities: {} })
      await withTimeout(client.connect(transport), this.timeoutMs, `${this.name} connect`)
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

  touch(): void {
    this.stats.lastUsed = Date.now()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.idleMs > 0) {
      this.idleTimer = setTimeout(() => this.close("idle"), this.idleMs)
      this.idleTimer.unref?.()
    }
  }

  async listTools(): Promise<McpToolSchema[]> {
    const client = await this.connect()
    this.touch()
    if (this.tools) return this.tools
    const res = await withTimeout(client.listTools(), this.timeoutMs, `${this.name} tools/list`)
    // The SDK types each schema keyword precisely; MCP carries the rest of the
    // JSON Schema verbatim, which is what `McpToolSchema` keeps.
    this.tools = ((res.tools || []) as unknown as McpToolSchema[])
    return this.tools
  }

  /** Calls a tool, retrying only transport-level failures — never a tool that
   *  reported an error of its own, which would just repeat the same failure. */
  async callTool(tool: string, args?: Record<string, unknown>): Promise<McpCallToolResult> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const client = await this.connect()
        this.touch()
        this.stats.calls += 1
        const result = await withTimeout(
          client.callTool({ name: tool, arguments: args || {} }),
          this.timeoutMs,
          `${this.name}.${tool}`,
        )
        // Content blocks are passed through as the upstream sent them.
        return result as unknown as McpCallToolResult
      } catch (err) {
        lastErr = err
        this.stats.errors += 1
        const old = this.client
        this.client = null // force a fresh connection on the next attempt
        if (old) Promise.resolve(old.close()).catch(() => {})
        if (attempt < this.retries) await sleep(150 * 2 ** attempt + Math.random() * 100)
      }
    }
    throw lastErr
  }

  close(reason = "closed"): void {
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
  opts: UpstreamOptions
  map: Map<string, UpstreamLike>

  constructor(servers: Record<string, McpServerConfig> = {}, opts: UpstreamOptions = {}) {
    this.opts = opts
    this.map = new Map<string, UpstreamLike>()
    for (const [name, spec] of Object.entries(servers)) this.map.set(name, new Upstream(name, spec, opts))
  }

  get(name: string): UpstreamLike {
    const up = this.map.get(name)
    if (!up) throw new Error(`unknown upstream: ${name}`)
    return up
  }

  has(name: string): boolean {
    return this.map.has(name)
  }

  names(): string[] {
    return [...this.map.keys()]
  }

  closeAll(): void {
    for (const up of this.map.values()) up.close("shutdown")
  }

  stats(): ProviderRecordMap {
    return Object.fromEntries([...this.map].map(([n, u]) => [n, { ...u.stats, connected: !!u.client }]))
  }
}
