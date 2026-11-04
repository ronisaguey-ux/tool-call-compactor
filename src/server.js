// The compactor MCP server.
//
// It advertises a handful of tiny tools and, behind them, every tool of every
// configured MCP server. The agent sees one description per batch instead of a
// thousand words per server, and pays for the real schemas only when a batch is
// actually needed. It also ships the briefing (`instructionsFor`) that tells the
// agent the tools are not in its tool list and how to reach them — without it the
// index is a room with no door.

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
  outsideRecommended,
  WORDS_RECOMMENDED,
} from "./groups.js"
import { compressResult, clampSchema, textBytes } from "./compress.js"
import { estimateTokens } from "./catalog.js"
import { reportLines } from "./metrics.js"
import { saveConfig, persistPolicy, LEGACY_DYNAMIC_BUDGET } from "./config.js"

export const VERSION = "0.1.0"

/** Registration budget. Registering a group's real tools makes later calls
 *  frictionless, but it puts those schemas back in the prefix for the rest of
 *  the session — so the default policy only registers what stays cheap. Set
 *  `options.persistBudget` to change it, or `0` for no cap at all. */
export const DYNAMIC_TOKEN_BUDGET = LEGACY_DYNAMIC_BUDGET

const FETCH_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", description: "Return only this tool's full schema instead of the whole group." },
    names_only: { type: "boolean", description: "Return just tool names and one-line summaries." },
    persist: { type: "boolean", description: "Register this batch's tools in the tool list for the rest of the session (true), or drop them (false)." },
  },
  additionalProperties: false,
}

const CORE_TOOLS = [
  {
    name: "list_groups",
    description:
      "The index: every batch with its description, its size, and the names of the tools inside it. Start here. " +
      "Pass a group to see one batch's tools in full.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Optional. Show this one batch's tools in full instead of the index." },
      },
      additionalProperties: false,
    },
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
    description:
      "Rewrite a batch's description (or retitle it) so the index matches what is really inside. " +
      `${WORDS_RECOMMENDED[0]}–${WORDS_RECOMMENDED[1]} words measures best; there is no hard limit. ` +
      "Renames see_tools_<id> when the title changes.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Batch id or title from list_groups." },
        title: { type: "string", description: "New short title; sets the see_tools_<id> name." },
        description: {
          type: "string",
          description: `New description. Name the capabilities an agent would not guess from the title; ${WORDS_RECOMMENDED[0]}–${WORDS_RECOMMENDED[1]} words is the sweet spot.`,
        },
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
  {
    name: "persist_group",
    description:
      "Keep a batch's tools in the tool list for the rest of the session, or drop them. Call with no `persist` to just ask.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Batch id or title from list_groups." },
        persist: { type: "boolean", description: "true keeps the batch's tools live; false drops them again." },
        permanent: { type: "boolean", description: "Also write it to the config, so it applies to every future session." },
      },
      required: ["group"],
      additionalProperties: false,
    },
  },
]

/** The briefing the harness splices into the session's system prompt. This is
 *  the whole interface contract: an agent that never learns the tools are not in
 *  its tool list will simply fail to find them, and the index looks like a
 *  broken tool set rather than a fast one. It rides in the cached prefix, so it
 *  is written to be read once and obeyed, not skimmed. */
function instructionsFor(policy, { batches = 0, tools = 0, servers = 0 } = {}) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const lines = [
    "TOOL ACCESS — HOW THIS WORKSPACE IS WIRED",
    "",
    `Your tool list is compacted. It carries ${plural(batches, "batch", "batches")}, not the ` +
      `${plural(tools, "tool", "tools")} across ${plural(servers, "server", "servers")} that they stand for. ` +
      "Every one of those tools still runs. None of them are in your tool list. You reach them through this server.",
    "",
    "FINDING A TOOL — in this order:",
    "1. list_groups — the index. Each batch shows its title, its description, and the names of the tools " +
      "inside it. Call it first whenever you are unsure where something lives.",
    `2. search_tools {query} — matches all ${tools} hidden tools by name, description and server. Call it the ` +
      "moment the index does not obviously cover what you need, and always before you report to the user that " +
      "a tool does not exist. A miss here is the only evidence that something is genuinely absent.",
    "3. see_tools_<batch> — the full JSON schemas for one batch. Call it when you are about to use one of its " +
      "tools, and not before.",
    "",
    "RUNNING A TOOL: call_tool {server, tool, arguments}, with arguments built from the schema " +
      "see_tools_<batch> returned. Do not guess parameter names — the schema is one call away.",
    "",
    "DO NOT:",
    "• fetch a batch to browse it. A fetch returns every schema in the batch and stays in your history for the " +
      "rest of the session. It is the most expensive call you can make here.",
    "• guess a tool name and call it. One search_tools costs a line; one wrong call_tool costs a turn.",
    "• read a missing entry as a missing tool. Everything the user configured is reachable through the index.",
    "• pre-fetch batches \"to be safe\" before starting. Open the one batch the task actually needs.",
    "",
    "MAINTAINING THE INDEX: if a batch's description does not match what you find inside it, call " +
      `describe_group and rewrite it — the wording you leave is what you read next session. ` +
      `${WORDS_RECOMMENDED[0]}–${WORDS_RECOMMENDED[1]} words measures best; there is no hard limit.`,
    "",
  ]
  if (policy.mode === "agent") {
    lines.push(
      "PERSISTENCE: fetched schemas stay out of your tool list unless you ask for them. Call persist_group " +
        "{group, persist: true} for a batch you will keep using this session — its tools then register, and " +
        "later calls skip the fetch.",
    )
  } else if (policy.mode === "auto") {
    lines.push(
      "PERSISTENCE: a fetched batch joins your tool list for the rest of the session" +
        (policy.budget ? ` while it stays under ${policy.budget} tokens` : "") +
        "; larger batches stay fetch-only and go through call_tool.",
    )
  } else {
    lines.push("PERSISTENCE: fetched schemas never enter your tool list. Fetch, then call_tool.")
  }
  return lines.join("\n")
}

export class Compactor {
  constructor({ config, pool, catalog, groups, metrics, rawOptions, log = () => {} }) {
    this.config = config
    this.options = config.options
    // The policy is read from the options the file actually contains, so a
    // config that predates `persist` keeps the budget it was written with.
    this.policy = persistPolicy(rawOptions ?? config.rawOptions ?? config.options)
    this.pool = pool
    this.catalog = catalog
    this.groups = groups
    this.metrics = metrics
    this.log = log
    this.index = toolIndex(catalog)
    this.dynamic = new Map() // exposed name -> { group, server, tool }
    this.exposedByKey = new Map() // "server::tool" -> exposed name
    this.registered = new Set() // batches whose tools are in the tool list now
    this.pinned = new Set() // batches kept live by the persist policy
    this.advertisedRevision = 0
    this.lastRecordedRevision = -1
    this.startedAt = Date.now()
    // The briefing counts what the agent cannot see, so it has to be computed
    // before the Server exists — `exposedByKey` is not filled in until
    // syncExposed runs below.
    const exposedGroups = Object.values(this.groups).filter((group) => group.expose)
    const exposedTools = exposedGroups.reduce(
      (n, group) => n + toolsInGroup(group, this.catalog, this.index).length,
      0,
    )
    this.mcp = new Server(
      { name: "tool-call-compactor", version: VERSION },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: instructionsFor(this.policy, {
          batches: Object.keys(this.groups).length - exposedGroups.length,
          tools: Math.max(0, this.index.size - exposedTools),
          // Counted from the index, not the config: an agent asking "how many
          // servers are behind this" cares about what is reachable.
          servers: new Set([...this.index.values()].map((tool) => tool.server)).size,
        }),
      },
    )
    this.registerHandlers()
    // Pass-through batches are live from here on, before any request arrives —
    // that is what keeps the advertised tool list identical on request one.
    this.syncExposed()
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

  /** A batch marked `expose: true` is pass-through: its tools are advertised as
   *  real tools from the very first request instead of hiding behind a fetch.
   *  Registering at boot rather than on demand is the point — the tool list is
   *  then byte-identical on every request, which is what a provider's prefix
   *  cache needs to keep hitting. */
  syncExposed() {
    for (const [id, group] of Object.entries(this.groups)) {
      if (!group?.expose || this.registered.has(id)) continue
      const tools = this.index.size ? toolsInGroup(group, this.catalog, this.index) : []
      if (!tools.length) {
        this.log(`batch "${id}" is expose:true but has no catalogued tools — run \`tcc scan\` to snapshot them`)
        continue
      }
      this.registerGroup(id, tools)
    }
  }

  /** The name a batch's tool takes once it is registered. Two servers can share
   *  a tool name, and MCP names must be unique, so the server is folded in for
   *  the ones that clash. */
  exposedName(groupId, tool, counts) {
    return counts?.get(tool.name) > 1 ? `${groupId}__${tool.server}__${tool.name}` : `${groupId}__${tool.name}`
  }

  registerGroup(id, tools) {
    const counts = new Map()
    for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1)
    let added = 0
    for (const tool of tools) {
      const exposed = this.exposedName(id, tool, counts)
      if (this.dynamic.has(exposed)) continue
      this.dynamic.set(exposed, { group: id, server: tool.server, tool: tool.name })
      this.exposedByKey.set(`${tool.server}::${tool.name}`, exposed)
      added += 1
    }
    if (added) this.registered.add(id)
    return added
  }

  groupToolList() {
    const out = []
    for (const [id, group] of Object.entries(this.groups)) {
      if (this.registered.has(id)) continue // already live as real tools; a fetch tool would be dead weight
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
    this.syncExposed()
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
      if (this.exposedByKey.has(key)) continue
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

  /** Announce a changed tool list. There is no client capability to check:
   *  tools.listChanged is something a *server* announces, and clients never
   *  declare it. A client that ignores the notification simply never sees the
   *  extra tools and keeps using call_tool, which still works — so announcing is
   *  always safe. */
  async notifyToolList() {
    this.advertisedRevision += 1
    try {
      await this.mcp.sendToolListChanged()
    } catch (err) {
      this.log(`tool list changed notification failed: ${err.message}`)
    }
    this.recordAdvertised()
  }

  /** The persist policy, applied to one fetched batch: does its schema come back
   *  to live in the tool list for the rest of the session?
   *
   *  - `off`   — never; the agent keeps going through call_tool.
   *  - `auto`  — yes, while the batch stays inside `persistBudget`.
   *  - `agent` — only when the agent asked (`persist: true` / `persist_group`).
   *
   *  An explicit request outranks the budget: the agent has seen the cost and
   *  decided. `persist: false` is an explicit un-registration. */
  async maybeExpose(groupId, tools, { persist } = {}) {
    if (persist === false) return this.unregisterGroup(groupId)
    if (this.registered.has(groupId)) return { exposed: 0, reason: "already" }
    const asked = persist === true || this.pinned.has(groupId)
    if (this.policy.mode === "off") return { exposed: 0, reason: "persist-off" }
    if (this.policy.mode === "agent" && !asked) return { exposed: 0, reason: "agent-decides" }
    const cost = tools.reduce((n, t) => n + (t.tokens || estimateTokens(t)), 0)
    if (!asked && this.policy.budget > 0 && cost > this.policy.budget) {
      return { exposed: 0, reason: "over-budget", cost, budget: this.policy.budget }
    }
    const added = this.registerGroup(groupId, tools)
    // `pinned` means "kept live by this session" as opposed to a batch the
    // config marks `expose: true`, which is live in every session.
    this.pinned.add(groupId)
    if (added) await this.notifyToolList()
    return { exposed: added, reason: "registered", cost }
  }

  async unregisterGroup(groupId) {
    let removed = 0
    for (const [exposed, entry] of [...this.dynamic]) {
      if (entry.group !== groupId) continue
      this.dynamic.delete(exposed)
      this.exposedByKey.delete(`${entry.server}::${entry.tool}`)
      removed += 1
    }
    this.registered.delete(groupId)
    this.pinned.delete(groupId)
    if (removed) await this.notifyToolList()
    return { exposed: 0, removed, reason: "unregistered" }
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
        return this.tListGroups(args)
      case "search_tools":
        return this.tSearchTools(args)
      case "call_tool":
      case "run_tool":
        return this.tCallTool(args)
      case "describe_group":
        return this.tDescribeGroup(args)
      case "persist_group":
      case "pin_group":
        return this.tPersistGroup(args)
      case "fetch_group":
        return this.tFetchGroup(args.group, args)
      default: {
        // Checked before see_tools_<group>, which would otherwise read the
        // "persistent_" part as a batch id.
        const persistent = name.match(/^see_tools?_persistent?_(.+)$/)
        if (persistent) return this.tPersistGroup({ ...args, group: persistent[1], persist: args.persist ?? true })
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
    const status = !this.registered.has(id) ? "" : this.pinned.has(id) ? " [pinned live]" : " [live]"
    return `${describeLine(id, group, count)}${status}${group.servers?.length ? ` [${group.servers.join(", ")}]` : ""}`
  }

  /** The names inside a batch. This is the recall fix: a description is prose and
   *  can miss a capability the agent needed, but a name is the exact word it is
   *  looking for. Names belong here rather than in the prefix — a tool result is
   *  history and costs nothing per request. */
  toolNames(id) {
    const group = this.groups[id]
    if (!group) return []
    return toolsInGroup(group, this.catalog, this.index)
      .map((tool) => tool.name)
      .sort()
  }

  namesLine(id, limit = 14) {
    const names = this.toolNames(id)
    if (!names.length) return null
    const shown = names.slice(0, limit)
    const more = names.length - shown.length
    return `        ${shown.join(", ")}${more > 0 ? `, +${more} more — list_groups {group: "${id}"}` : ""}`
  }

  tGroupDetail(rawId) {
    const found = findGroup(this.groups, rawId)
    if (!found) {
      const ids = Object.keys(this.groups)
      return this.text(`Unknown batch "${rawId}". Available: ${ids.join(", ") || "(none)"}`)
    }
    const { id, group } = found
    const tools = toolsInGroup(group, this.catalog, this.index)
    const words = wordCount(group.description || "")
    const lines = [
      `"${id}" — ${group.title}`,
      group.description || "(no description yet)",
      `${tools.length} tool${tools.length === 1 ? "" : "s"}` +
        (group.expose ? " · pass-through, already in your tool list" : "") +
        (group.servers?.length ? ` · servers: ${group.servers.join(", ")}` : ""),
      "",
      ...tools.map((t) => `  ${t.server}::${t.name}${t.description ? ` — ${clampWords(t.description, 14)}` : ""}`),
      "",
      group.expose
        ? `These are live as ${id}__<tool>; call them directly.`
        : `Fetch the schemas with see_tools_${id}, then run one with call_tool.`,
      outsideRecommended(words)
        ? `This description is ${words} words; ${WORDS_RECOMMENDED[0]}–${WORDS_RECOMMENDED[1]} measures best. describe_group can rewrite it.`
        : null,
    ].filter((line) => line !== null)
    return this.text(lines.join("\n"))
  }

  tListGroups({ group } = {}) {
    if (group) return this.tGroupDetail(group)
    const ids = Object.keys(this.groups)
    if (!ids.length) {
      return this.text(
        "No groups are configured and no servers were detected. Add servers to tcc.config.json, then run `tcc init`.",
      )
    }
    const live = [...this.registered]
    const hidden = [...this.index.keys()].filter((key) => !this.exposedByKey.has(key)).length
    const lines = [
      `${ids.length} batches, ${hidden} tools hidden behind them. Each batch lists its tools.`,
      "",
      ...ids.flatMap((id) => [this.groupLine(id), this.namesLine(id)]).filter((line) => line !== null),
      "",
      "Fetch one batch's schemas with see_tools_<group>, then run a tool with call_tool. If the index does",
      "not obviously cover what you need, search_tools {query} scans all of it before you conclude anything.",
      live.length ? `Live batches (tools already in your tool list): ${live.join(", ")}.` : null,
      this.policy.mode === "agent"
        ? "A fetched batch stays fetch-only until you call persist_group {group, persist: true}."
        : this.policy.mode === "off"
          ? "persist is off: fetched schemas are never added to your tool list; use call_tool."
          : `Fetched batches stay live for the session${this.policy.budget ? ` while under ${this.policy.budget} tokens` : ""}.`,
    ].filter((line) => line !== null)
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

  async tFetchGroup(rawId, { tool, names_only, persist } = {}) {
    const found = findGroup(this.groups, rawId)
    if (!found) {
      const ids = Object.keys(this.groups)
      return this.text(`Unknown group "${rawId}". Available: ${ids.join(", ") || "(none)"}`)
    }
    const { id, group } = found
    const wasLive = this.registered.has(id)
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
      persisted: wasLive || this.registered.has(id),
    })
    const exposed = names_only ? { exposed: 0, reason: "names-only" } : await this.maybeExpose(id, tools, { persist })
    const liveNow = this.registered.has(id)
    const header = [
      `# ${group.title || titleFor(id)} [${id}] — ${tools.length} tools, ~${totalTokens} tokens of schema`,
