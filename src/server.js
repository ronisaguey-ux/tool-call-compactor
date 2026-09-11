// The compactor MCP server.
//
// It advertises a handful of tiny tools and, behind them, every tool of every
// configured MCP server. The agent sees thirty words per group instead of a
// thousand words per server, and pays for the real schemas only when a group is
// actually needed.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import http from "node:http"
import {
  clampWords,
  describeLine,
  findGroup,
  groupIdForServer,
  slug,
  titleFor,
  toolsInGroup,
  toolIndex,
  wordCount,
  MAX_WORDS,
} from "./groups.js"
import { compressResult, clampSchema, textBytes } from "./compress.js"
import { estimateTokens } from "./catalog.js"
import { reportLines } from "./metrics.js"
import { saveConfig } from "./config.js"

export const VERSION = "0.1.0"

/** Dynamic registration budget. Registering a group's real tools makes later
 *  calls frictionless, but it puts those schemas back in the prefix for the rest
 *  of the session — so only groups small enough to be worth it get exposed. */
export const DYNAMIC_TOKEN_BUDGET = 4_000

const FETCH_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", description: "Return only this tool's full schema instead of the whole group." },
    names_only: { type: "boolean", description: "Return just tool names and one-line summaries." },
  },
  additionalProperties: false,
}

const CORE_TOOLS = [
  {
    name: "list_groups",
    description: "List every tool group with its description and size. Start here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_tools",
    description: "Search every hidden tool by name or description and return matches with their group.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match against tool names, descriptions and servers." },
        limit: { type: "number", description: "Maximum matches to return (default 20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "call_tool",
    description: "Execute a tool from any server. Give server and tool, or a single server::tool string.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Upstream server name, e.g. github." },
        tool: { type: "string", description: "Tool name, or server::tool when server is omitted." },
        arguments: { type: "object", description: "Arguments object matching the tool's schema." },
        compress: { type: "boolean", description: "Truncate a very large result (default true)." },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_group",
    description: "Retitle a batch or rewrite its description in thirty words or fewer. Renames see_tools_<id> when the title changes.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Batch id or title from list_groups." },
        title: { type: "string", description: "New short title; sets the see_tools_<id> name." },
        description: { type: "string", description: "New description, thirty words maximum." },
      },
      required: ["group"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_group",
    description: "Fetch every tool schema in a group. Prefer see_tools_<group> when it exists.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Group id from list_groups." },
        ...FETCH_SCHEMA.properties,
      },
      required: ["group"],
      additionalProperties: false,
    },
  },
]

const INSTRUCTIONS =
  "Tools are compacted into groups to save context. Call list_groups for the index, " +
  "see_tools_<group> to fetch only the schemas you need, then call_tool to execute. " +
  "Do not fetch a group you are not about to use."

export class Compactor {
  constructor({ config, pool, catalog, groups, metrics, log = () => {} }) {
    this.config = config
    this.options = config.options
    this.pool = pool
    this.catalog = catalog
    this.groups = groups
    this.metrics = metrics
    this.log = log
    this.index = toolIndex(catalog)
    this.dynamic = new Map() // exposed name -> { group, server, tool }
    this.exposedGroups = new Set()
    this.advertisedRevision = 0
    this.lastRecordedRevision = -1
    this.startedAt = Date.now()
    this.mcp = new Server(
      { name: "tool-call-compactor", version: VERSION },
      { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
    )
    this.registerHandlers()
  }

  // ---------------------------------------------------------------- tool list

  groupToolCount(id) {
    const group = this.groups[id]
    if (!group) return 0
    if (this.index.size) return toolsInGroup(group, this.catalog, this.index).length
    return group.declaredCount || 0
  }

  coreToolList() {
    return CORE_TOOLS.map((t) => ({ ...t }))
  }

  groupToolList() {
    const out = []
    for (const [id, group] of Object.entries(this.groups)) {
      const count = this.groupToolCount(id)
      const title = group.title || titleFor(id)
      out.push({
        name: `see_tools_${id}`,
        description: `${title}: ${group.description} — fetch these ${count || ""} tool schemas.`.replace(/\s+/g, " ").trim(),
        inputSchema: { type: "object", properties: { ...FETCH_SCHEMA.properties }, additionalProperties: false },
      })
    }
    return out
  }

  dynamicToolList() {
    const out = []
    for (const [exposed, entry] of this.dynamic) {
      const tool = this.index.get(`${entry.server}::${entry.tool}`)
      out.push({
        name: exposed,
        description: tool?.description || `${entry.tool} on ${entry.server}.`,
        inputSchema: clampSchema(tool?.inputSchema || { type: "object", properties: {} }),
        ...(tool?.annotations ? { annotations: tool.annotations } : {}),
      })
    }
    return out
  }

  toolList() {
    return [...this.coreToolList(), ...this.groupToolList(), ...this.dynamicToolList()]
  }

  /** Record what the harness was actually sent. Called from the list-tools
   *  handler, so the number in the report is the number that went on the wire. */
  recordAdvertised() {
    this.lastRecordedRevision = this.advertisedRevision
    const tools = this.toolList()
    const tokens = tools.reduce((n, t) => n + estimateTokens(t), 0)
    let hiddenTools = 0
    let hiddenTokens = 0
    for (const [key, tool] of this.index) {
      const server = tool.server
      const exposedName = [...this.dynamic.entries()].find(([, e]) => `${e.server}::${e.tool}` === key)?.[0]
      if (exposedName) continue
      hiddenTools += 1
      hiddenTokens += tool.tokens || estimateTokens(tool)
    }
    this.metrics?.record("advertised", {
      tools: tools.length,
      tokens,
      bytes: JSON.stringify(tools).length,
      hiddenTools,
      hiddenTokens,
      periodStart: this.startedAt,
      servers: this.pool.names().length,
    })
    return { tools: tools.length, tokens, hiddenTools, hiddenTokens }
  }

  /** After a group's schemas have been fetched, expose its real tools natively —
   *  but only when the client can refresh its tool list, and only for groups
   *  small enough that re-adding them does not undo the saving. */
  async maybeExpose(groupId, tools) {
    if (!this.options.dynamic || this.exposedGroups.has(groupId)) return { exposed: 0, reason: "off" }
    // `true` means the default policy — register a batch only while its schemas
    // stay cheap. "always" overrides that and registers whatever was fetched.
    if (this.options.dynamic !== "always") {
      const cost = tools.reduce((n, t) => n + (t.tokens || estimateTokens(t)), 0)
      if (cost > (this.options.dynamicBudget ?? DYNAMIC_TOKEN_BUDGET)) {
        return { exposed: 0, reason: "too-large", cost }
      }
    }
    // There is no client capability to check: tools.listChanged is something a
    // *server* announces, and clients never declare it. A client that ignores
    // the notification simply never sees the extra tools and keeps using
    // call_tool, which still works — so announcing is always safe.
    const counts = new Map()
    for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1)
    let added = 0
    for (const tool of tools) {
      const exposed = counts.get(tool.name) > 1 ? `${groupId}__${tool.server}__${tool.name}` : `${groupId}__${tool.name}`
      if (this.dynamic.has(exposed)) continue
      this.dynamic.set(exposed, { group: groupId, server: tool.server, tool: tool.name })
      added += 1
    }
    this.exposedGroups.add(groupId)
    if (added) {
      this.advertisedRevision += 1
      try {
        await this.mcp.sendToolListChanged()
      } catch (err) {
        this.log(`tool list changed notification failed: ${err.message}`)
      }
      this.recordAdvertised()
    }
    return { exposed: added, reason: "registered" }
  }

  // ----------------------------------------------------------------- handlers

  registerHandlers() {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      if (this.lastRecordedRevision !== this.advertisedRevision) this.recordAdvertised()
      return { tools: this.toolList() }
    })
    this.mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      try {
        return await this.dispatch(name, args || {})
      } catch (err) {
        const message = err?.message || String(err)
        this.log(`tool ${name} failed: ${message}`)
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true }
      }
    })
  }

  async dispatch(name, args) {
    const entry = this.dynamic.get(name)
    if (entry) return this.invokeDynamic(entry, args)
    switch (name) {
      case "list_groups":
        return this.tListGroups()
      case "search_tools":
        return this.tSearchTools(args)
      case "call_tool":
      case "run_tool":
        return this.tCallTool(args)
      case "describe_group":
        return this.tDescribeGroup(args)
      case "fetch_group":
        return this.tFetchGroup(args.group, args)
      default: {
        // see_tools_<group> is the advertised name; see_tool_<group> is accepted
        // too, because that is the spelling everyone types first.
        const scoped = name.match(/^see_tools?_(.+)$/)
        if (scoped) return this.tFetchGroup(scoped[1], args)
        throw new Error(`unknown tool: ${name}`)
      }
    }
  }

  text(body) {
    return { content: [{ type: "text", text: body }] }
  }

  groupLine(id) {
    const group = this.groups[id]
    const count = this.groupToolCount(id)
    return `${describeLine(id, group, count)}${group.servers?.length ? ` [${group.servers.join(", ")}]` : ""}`
  }

  tListGroups() {
    const ids = Object.keys(this.groups)
    if (!ids.length) {
      return this.text(
        "No groups are configured and no servers were detected. Add servers to tcc.config.json, then run `tcc init`.",
      )
    }
    const hidden = this.index.size
    const lines = [
      `${ids.length} groups, ${hidden} tools hidden behind them.`,
      "",
      ...ids.map((id) => this.groupLine(id)),
      "",
      "Fetch one with see_tools_<group>, or call_tool directly if you already know the tool.",
    ]
    return this.text(lines.join("\n"))
  }

  scoreTool(tool, groupId, query) {
    const name = tool.name.toLowerCase()
    const desc = (tool.description || "").toLowerCase()
    const server = tool.server.toLowerCase()
    let score = 0
    if (name === query) score += 200
    else if (name.includes(query)) score += 60
    if (groupId.includes(query)) score += 25
    for (const word of query.split(/[\s_]+/).filter((w) => w.length > 1)) {
      if (name.includes(word)) score += 14
      if (desc.includes(word)) score += 5
      if (server.includes(word)) score += 7
      if (groupId.includes(word)) score += 4
    }
    return score
  }

  tSearchTools({ query, limit = 20 }) {
    const q = String(query || "").trim().toLowerCase()
    if (!q) throw new Error("search_tools needs a query")
    const groupOf = new Map()
    for (const [id, group] of Object.entries(this.groups)) {
      for (const tool of toolsInGroup(group, this.catalog, this.index)) groupOf.set(`${tool.server}::${tool.name}`, id)
      for (const server of group.servers || []) groupOf.set(`server::${server}`, id)
    }
    const hits = []
    for (const [key, tool] of this.index) {
      const groupId = groupOf.get(key) || groupOf.get(`server::${tool.server}`) || groupIdForServer(tool.server)
      const score = this.scoreTool(tool, groupId, q)
      if (score > 0) hits.push({ tool, groupId, score })
    }
    hits.sort((a, b) => b.score - a.score)
    const top = hits.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
    this.metrics?.record("search", { query: q, results: top.length, scanned: this.index.size })
    if (!top.length) {
      return this.text(`No tool matched "${query}". ${this.index.size} tools are indexed; try list_groups.`)
    }
    const lines = top.map(({ tool, groupId }) => {
      const summary = clampWords(tool.description, 18)
      return `${tool.server}::${tool.name}  [${groupId}]${summary ? ` — ${summary}` : ""}`
    })
    return this.text(
      [`${top.length} of ${hits.length} matches for "${query}":`, "", ...lines, "", "Fetch a group with see_tool_<group>, then call_tool."].join(
        "\n",
      ),
    )
  }

  async tFetchGroup(rawId, { tool, names_only } = {}) {
    const found = findGroup(this.groups, rawId)
    if (!found) {
      const ids = Object.keys(this.groups)
      return this.text(`Unknown group "${rawId}". Available: ${ids.join(", ") || "(none)"}`)
    }
    const { id, group } = found
    const tools = await this.toolsForGroup(id, group)
    if (!tools.length) {
      const servers = (group.servers || []).join(", ") || "none"
      return this.text(
        `Group "${id}" has no readable tools. Servers: ${servers}. ` +
          `Run \`tcc scan\` to refresh the catalog, or check those servers are reachable.`,
      )
    }
    const totalTokens = tools.reduce((n, t) => n + (t.tokens || estimateTokens(t)), 0)
    this.metrics?.record("fetch", {
      group: id,
      tools: tools.length,
      bytes: JSON.stringify(tools).length,
      tokens: totalTokens,
      namesOnly: !!names_only,
    })
    const exposed = names_only ? { exposed: 0, reason: "names-only" } : await this.maybeExpose(id, tools)
    const header = [
      `# ${group.title || titleFor(id)} [${id}] — ${tools.length} tools, ~${totalTokens} tokens of schema`,
      group.description,
      group.servers?.length ? `Servers: ${group.servers.join(", ")}` : null,
      exposed.exposed
        ? `Registered ${exposed.exposed} tools natively — call them as ${id}__<tool> from now on.`
        : `Execute with call_tool {server, tool, arguments}.`,
      "",
    ]
      .filter((line) => line !== null)

    if (tool) {
      const wanted = String(tool).toLowerCase()
      const match = tools.find((t) => t.name.toLowerCase() === wanted) || tools.find((t) => t.name.toLowerCase().includes(wanted))
      if (!match) {
        return this.text(`${header.join("\n")}\nNo tool named "${tool}" in ${id}. Available: ${tools.map((t) => t.name).join(", ")}`)
      }
      return this.text(
        [
          `# ${match.name} (${match.server})`,
          match.description || "",
          JSON.stringify(clampSchema(match.inputSchema), null, 1),
        ].join("\n"),
      )
    }

    const body = tools.map((t) => {
      const summary = names_only ? clampWords(t.description, 15) : t.description
      const schema = names_only ? "" : `\n${JSON.stringify(clampSchema(t.inputSchema))}`
      return `## ${t.name} (${t.server})\n${summary || "(no description)"}${schema}`
    })
    return this.text([...header, ...body].join("\n"))
  }

  async toolsForGroup(id, group) {
    const known = toolsInGroup(group, this.catalog, this.index)
    if (known.length) return known
    // No snapshot covers this group yet — ask the servers directly.
    const out = []
    for (const server of group.servers || []) {
      if (!this.pool.has(server)) continue
      try {
        const live = await this.pool.get(server).listTools()
        for (const t of live) {
          out.push({
            server,
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema || { type: "object", properties: {} },
            tokens: estimateTokens(t),
          })
        }
      } catch (err) {
        this.log(`live tool listing failed for ${server}: ${err.message}`)
      }
    }
    return out
  }

  async invokeDynamic(entry, args) {
    return this.execute(entry.server, entry.tool, args)
  }

  async tCallTool({ server, tool, arguments: toolArgs, compress }) {
    if (!tool) throw new Error("call_tool needs a tool name")
    let srv = server
    let name = String(tool)
    if (!srv && name.includes("::")) {
      const [a, b] = name.split("::")
      srv = a
      name = b
    }
    if (!srv) {
      const owners = [...this.index.values()].filter((t) => t.name === name).map((t) => t.server)
      if (owners.length === 1) srv = owners[0]
      else if (owners.length > 1) throw new Error(`"${name}" exists on ${owners.join(", ")} — pass server explicitly`)
      else throw new Error(`unknown tool "${name}". Use search_tools to find it.`)
    }
    return this.execute(srv, name, toolArgs || {}, compress)
  }

  async execute(server, tool, args, compress = true) {
    if (!this.pool.has(server)) throw new Error(`unknown server "${server}". Known: ${this.pool.names().join(", ")}`)
    const started = Date.now()
    const result = await this.pool.get(server).callTool(tool, args)
    const before = textBytes(result)
    const useCompress = this.options.compress !== false && compress !== false
    const { result: out, compressed } = useCompress
      ? compressResult(result, { maxText: this.options.maxText })
      : { result, compressed: false }
    this.metrics?.record("call", {
      server,
      tool,
      bytes: before,
      outBytes: textBytes(out),
      compressed,
      isError: !!out.isError,
      ms: Date.now() - started,
    })
    return out
  }

  tDescribeGroup({ group, title, description }) {
    const found = findGroup(this.groups, group)
    if (!found) return this.text(`Unknown batch "${group}". Available: ${Object.keys(this.groups).join(", ")}`)
    if (!title && !description) throw new Error("describe_group needs a title or a description")
    const notes = []
    let id = found.id

    if (title) {
      const clean = clampWords(title, 8)
      this.groups[id].title = clean
      const renamed = slug(clean)
      if (renamed && renamed !== id) {
        if (this.groups[renamed]) {
          notes.push(`title set, but "${renamed}" already exists so see_tools_${id} keeps its name`)
        } else {
          this.groups[renamed] = this.groups[id]
          delete this.groups[id]
          for (const [exposed, entry] of [...this.dynamic]) {
            if (entry.group === id) this.dynamic.delete(exposed)
          }
          this.exposedGroups.delete(id)
          this.config.groups = this.config.groups || {}
          delete this.config.groups[id]
          notes.push(`renamed see_tools_${id} → see_tools_${renamed}`)
          id = renamed
        }
      }
    }

    if (description) {
      const before = wordCount(description)
      const text = clampWords(description, MAX_WORDS)
      this.groups[id].description = text
      notes.push(`${Math.min(before, MAX_WORDS)} of ${MAX_WORDS} words${before > MAX_WORDS ? `, trimmed from ${before}` : ""}`)
    }

    this.config.groups = this.config.groups || {}
    this.config.groups[id] = { ...(this.config.groups[id] || {}), ...this.groups[id] }
    let saved = null
    try {
      saved = saveConfig(this.config)
    } catch (err) {
      this.log(`could not persist batch: ${err.message}`)
    }
    this.advertisedRevision += 1
    Promise.resolve(this.mcp.sendToolListChanged?.()).catch((err) =>
      this.log(`tool list changed notification failed: ${err.message}`),
    )
    this.recordAdvertised()
    return this.text(
      `Updated "${id}" (${this.groups[id].title || titleFor(id)}): ${this.groups[id].description}\n` +
        `${notes.join("; ")}${saved ? `; saved to ${saved}` : "; not persisted"}`,
    )
  }

  // ------------------------------------------------------------------ control

  /** A localhost control port so `tcc report` and `tcc refresh` work against a
   *  server that is already running inside a harness. */
  startControl() {
    const control = this.options.control || {}
    if (control.enabled === false) return null
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`)
      const token = control.token
      if (token && req.headers["x-tcc-token"] !== token) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "unauthorized" }))
        return
      }
      const send = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" })
        res.end(JSON.stringify(body, null, 2))
      }
      if (url.pathname === "/healthz") return send(200, { ok: true, uptimeMs: Date.now() - this.startedAt })
      if (url.pathname === "/stats") {
        return send(200, {
          uptimeMs: Date.now() - this.startedAt,
          groups: Object.keys(this.groups).length,
          indexedTools: this.index.size,
          exposed: [...this.dynamic.keys()],
          upstreams: this.pool.stats(),
          advertised: this.toolList().length,
        })
      }
      if (url.pathname === "/groups") return send(200, this.groups)
      if (url.pathname === "/report") {
        return send(200, { lines: reportLines(this.metrics?.read() || []) })
      }
      return send(404, { error: "not found", paths: ["/healthz", "/stats", "/groups", "/report"] })
    })
    server.on("error", (err) => this.log(`control port unavailable: ${err.message}`))
    server.listen(control.port ?? 4750, control.host || "127.0.0.1", () => {
      this.log(`control listening on http://${control.host || "127.0.0.1"}:${control.port ?? 4750}`)
    })
    this.control = server
    return server
  }

  async serve(transport = new StdioServerTransport()) {
    this.recordAdvertised()
    await this.mcp.connect(transport)
    this.startControl()
    this.log(`serving ${this.toolList().length} tools for ${this.pool.names().length} upstreams`)
  }

  async shutdown() {
    this.pool.closeAll()
    try {
      this.control?.close()
    } catch {
      // shutting down anyway
    }
  }
}
