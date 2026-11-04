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
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js"
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
import type {
  CatalogLike,
  CompactorOptions,
  GroupConfig,
  IndexedTool,
  JsonSchema,
  Logger,
  McpCallToolResult,
  McpTextContent,
  McpTextReply,
  McpToolSchema,
  PersistPolicy,
  ResolvedConfig,
  UpstreamPoolLike,
} from "./types.js"

export const VERSION = "0.1.0"

/** Registration budget. Registering a group's real tools makes later calls
 *  frictionless, but it puts those schemas back in the prefix for the rest of
 *  the session — so the default policy only registers what stays cheap. Set
 *  `options.persistBudget` to change it, or `0` for no cap at all. */
export const DYNAMIC_TOKEN_BUDGET = LEGACY_DYNAMIC_BUDGET

/** What every `see_tools_<batch>` tool accepts. */
const FETCH_PROPERTIES: Record<string, JsonSchema> = {
  tool: { type: "string", description: "Return only this tool's full schema instead of the whole group." },
  names_only: { type: "boolean", description: "Return just tool names and one-line summaries." },
  persist: { type: "boolean", description: "Register this batch's tools in the tool list for the rest of the session (true), or drop them (false)." },
}

const FETCH_SCHEMA: JsonSchema = {
  type: "object",
  properties: FETCH_PROPERTIES,
  additionalProperties: false,
}

const CORE_TOOLS: McpToolSchema[] = [
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
        ...FETCH_PROPERTIES,
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
function instructionsFor(policy: PersistPolicy, { batches = 0, tools = 0, servers = 0 }: { batches?: number; tools?: number; servers?: number } = {}): string {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
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

/** An exposed tool: the batch it belongs to and the upstream tool behind it. */
interface DynamicEntry {
  group: string
  server: string
  tool: string
}

/** What `maybeExpose` / `unregisterGroup` decided. `cost` and `budget` are set
 *  only on the refusal that has a number to explain. */
export interface ExposeOutcome {
  exposed: number
  reason: string
  cost?: number
  budget?: number
  removed?: number
}

/** The metrics sink the server writes to. `Metrics` implements it; a test can
 *  pass nothing at all. */
export interface MetricsSink {
  record(kind: string, data?: Record<string, unknown>): unknown
  read(since?: number): Array<{ t: number; kind: string; [field: string]: unknown }>
}

export interface CompactorArgs {
  config: ResolvedConfig
  pool: UpstreamPoolLike
  catalog: CatalogLike
  groups: Record<string, GroupConfig>
  metrics?: MetricsSink
  rawOptions?: CompactorOptions
  log?: Logger
}

interface ListGroupsArgs {
  group?: unknown
}

interface SearchArgs {
  query?: unknown
  limit?: unknown
}

interface CallArgs {
  server?: unknown
  tool?: unknown
  arguments?: unknown
  compress?: unknown
}

interface FetchArgs {
  tool?: unknown
  names_only?: unknown
  persist?: unknown
}

interface PersistArgs {
  group?: unknown
  persist?: unknown
  permanent?: unknown
}

interface DescribeArgs {
  group?: unknown
  title?: unknown
  description?: unknown
}

export class Compactor {
  config: ResolvedConfig
  options: ResolvedConfig["options"]
  policy: PersistPolicy
  pool: UpstreamPoolLike
  catalog: CatalogLike
  groups: Record<string, GroupConfig>
  metrics?: MetricsSink
  log: Logger
  index: Map<string, IndexedTool>
  dynamic: Map<string, DynamicEntry>
  exposedByKey: Map<string, string>
  registered: Set<string>
  pinned: Set<string>
  advertisedRevision: number
  lastRecordedRevision: number
  startedAt: number
  mcp: Server
  control?: http.Server

  constructor({ config, pool, catalog, groups, metrics, rawOptions, log = () => {} }: CompactorArgs) {
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
