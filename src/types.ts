// The shapes that cross this program's boundaries: the MCP wire protocol, the
// config file a human edits, the catalog snapshot a scan writes, and the
// metrics log a report is computed from.
//
// Everything that arrives from disk is `unknown` at the door and is narrowed by
// a check before it is used — these types describe what survives that check, so
// a malformed tcc.config.json cannot silently become a lie the rest of the
// program believes.

// --------------------------------------------------------------------- JSON

/** Any value JSON can represent. Used where a payload's shape is the
 *  upstream's business, not ours. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface JsonObject {
  [key: string]: JsonValue
}

/** A JSON Schema as MCP carries it in a tool definition. Only the keywords this
 *  project reads are named; the index signature keeps the rest intact, because
 *  a schema is passed through to the agent as written. */
export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  enum?: JsonValue[]
  examples?: JsonValue[]
  items?: JsonSchema | JsonSchema[]
  [keyword: string]: unknown
}

// ---------------------------------------------------------------- JSON-RPC 2.0

export type JsonRpcId = string | number | null

/** A request on the wire: the framing every MCP message uses. The SDK owns the
 *  transport and the id bookkeeping; these describe what it puts on the wire so
 *  the rest of the program can talk about a message without guessing. */
export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: string | number
  method: string
  params?: JsonValue
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: JsonValue
}

export interface JsonRpcResponse<TResult = JsonValue> {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: TResult
  error?: JsonRpcErrorObject
}

/** A notification carries no id and is never answered — `notifications/tools/
 *  list_changed` is the one this server sends. */
export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: JsonValue
}

// ------------------------------------------------------------- MCP tool shapes

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** A tool definition as `tools/list` carries it. `name`, `description` and
 *  `inputSchema` are the contract; annotations ride along when an upstream
 *  supplied them. */
export interface McpToolSchema {
  name: string
  description?: string
  inputSchema: JsonSchema
  annotations?: McpToolAnnotations
  [key: string]: unknown
}

export interface McpListToolsResult {
  tools: McpToolSchema[]
}

export interface McpTextContent {
  type: "text"
  text: string
  [key: string]: unknown
}

/** Any content block an upstream can return. Only text blocks are compressed,
 *  but image and resource blocks pass through untouched. */
export interface McpContentBlock {
  type: string
  [key: string]: unknown
}

export interface McpCallToolResult {
  content: McpContentBlock[]
  isError?: boolean
  [key: string]: unknown
}

export interface McpCallToolParams {
  name: string
  arguments?: Record<string, unknown>
}

/** What this server's own tools answer with: one text block, optionally an
 *  error. Narrower than McpCallToolResult on purpose — every handler here
 *  produces text. */
export interface McpTextReply {
  content: McpTextContent[]
  isError?: boolean
}

// ------------------------------------------------------------------- config

/** How a fetched batch's schemas come back to live in the harness's tool list. */
export type PersistMode = "off" | "auto" | "agent"

export interface PersistPolicy {
  mode: PersistMode
  budget: number
  source: "persist" | "dynamic" | "default"
}

/** One upstream server as the config file declares it. Accepts opencode-style
 *  (`type`/`command`/`environment`/`url`/`headers`), Claude-Desktop-style
 *  (`command`/`args`/`env`) and older mcmcp-style specs alike. */
export interface McpServerConfig {
  type?: string
  command?: string | string[]
  args?: Array<string | number>
  environment?: Record<string, string>
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  cwd?: string
  workdir?: string
  transport?: string
  enabled?: boolean
  disabled?: boolean
  [key: string]: unknown
}

export interface ControlOptions {
  enabled?: boolean
  host?: string
  port?: number
  token?: string | null
}

/** The knobs under `options`. Every field is optional on disk; `defaultConfig`
 *  fills the gaps, and `ResolvedOptions` is what the rest of the program reads. */
export interface CompactorOptions {
  idleMs?: number
  timeoutMs?: number
  retries?: number
  cacheTtlMs?: number
  /** Legacy switch, predating `persist`. Still honoured. */
  dynamic?: boolean | string
  dynamicBudget?: number
  persist?: string
  persistBudget?: number
  compress?: boolean
  maxText?: number
  control?: ControlOptions
}

export interface ResolvedControl {
  enabled: boolean
  host: string
  port: number
  token: string | null
}

/** The options after defaults have been filled in: what the code may rely on. */
export interface ResolvedOptions {
  idleMs: number
  timeoutMs: number
  retries: number
  cacheTtlMs: number
  compress: boolean
  maxText: number
  persist?: string
  persistBudget?: number
  dynamic?: boolean | string
  dynamicBudget?: number
  control: ResolvedControl
}

/** A batch: the thing that hides a set of tool schemas behind one description. */
export interface GroupConfig {
  title?: string
  description?: string
  hint?: string
  servers?: string[]
  tools?: string[]
  /** Pass-through: advertised as real tools from the first request. */
  expose?: boolean
  /** Tool count recorded when no catalog covers the batch yet. */
  declaredCount?: number
}

export interface BuiltinOptions {
  enabled?: boolean
  tools?: string[]
  workdir?: string
}

/** The config file on disk, before defaults. */
export interface ConfigFile {
  $schema?: string
  mcp?: Record<string, McpServerConfig>
  groups?: Record<string, GroupConfig>
  options?: CompactorOptions
  builtins?: BuiltinOptions
  cachePath?: string
}

/** `defaultConfig()`: every top-level key present, with the written defaults. */
export interface DefaultConfig extends ConfigFile {
  $schema: string
  mcp: Record<string, McpServerConfig>
  groups: Record<string, GroupConfig>
  options: ResolvedOptions
}

/** What `loadConfig` hands back: the file, the defaults merged under it, and
 *  where it came from. `rawOptions` is the options *as written*, which is what
 *  the persist policy has to read — a default sitting on top of a legacy
 *  `dynamic` is not the same thing as `persist: "auto"` having been chosen. */
export interface ResolvedConfig extends DefaultConfig {
  dir: string
  file: string
  exists: boolean
  rawOptions: CompactorOptions
  builtins?: BuiltinOptions
  cachePath?: string
}

// ------------------------------------------------------ catalog (cache entries)

/** One snapshot of everything an upstream advertises: the compactor's cache. */
export interface CatalogTool {
  name: string
  description: string
  inputSchema: JsonSchema
  hash: string
  tokens: number
}

export interface CatalogServerEntry {
  ok: boolean
  error?: string
  tools: CatalogTool[]
}

export interface Catalog {
  savedAt: number
  version: number
  servers: Record<string, CatalogServerEntry>
}

/** A catalog as *read*: a file on disk can be older, partial, or hand-edited,
 *  so every field is optional until a check has confirmed it. */
export interface CatalogToolLike {
  name: string
  description?: string
  inputSchema?: JsonSchema
  hash?: string
  tokens?: number
}

export interface CatalogServerLike {
  ok?: boolean
  error?: string
  tools?: CatalogToolLike[]
}

export interface CatalogLike {
  savedAt?: number
  version?: number
  servers?: Record<string, CatalogServerLike>
}

/** An entry in the tool index: a catalog tool with the server it came from
 *  folded in, which is what `"server::tool"` keys are built out of. A tool
 *  listed live from a running upstream has no hash — the catalog ones do. */
export interface IndexedTool {
  server: string
  name: string
  description?: string
  inputSchema?: JsonSchema
  annotations?: McpToolAnnotations
  hash?: string
  tokens?: number
}

// -------------------------------------------------------------- provider records

/** Per-upstream counters. `spawns` counts connections opened, not processes
 *  still alive. */
export interface UpstreamStats {
  calls: number
  errors: number
  spawns: number
  lastUsed: number
}

/** A provider record as `/stats` reports it: the counters plus whether the
 *  client is currently connected. */
export interface ProviderRecord extends UpstreamStats {
  connected: boolean
}

export interface ProviderRecordMap {
  [server: string]: ProviderRecord
}

// -------------------------------------------------------------------- metrics

/** One line of the metrics log. `kind` decides which extra fields are present,
 *  so the rest is unknown until a reader asks for a key by name. */
export interface MetricEvent {
  t: number
  kind: string
  [field: string]: unknown
}

// -------------------------------------------------------------------- helpers

export type Logger = (line: string) => void

/** The minimum an upstream has to offer to be usable from the pool: list its
 *  tools and run one. Both a real MCP client and the built-in tools satisfy it. */
export interface UpstreamLike {
  name: string
  stats: UpstreamStats
  client?: unknown
  listTools(): Promise<McpToolSchema[]>
  callTool(name: string, args?: Record<string, unknown>): Promise<McpCallToolResult>
  close(reason?: string): void
}

/** What the compactor needs from a pool. Narrower than UpstreamPool so a
 *  side-by-side replacement (the tests' fake, the built-ins' pool) fits. */
export interface UpstreamPoolLike {
  names(): string[]
  has(name: string): boolean
  get(name: string): UpstreamLike
  closeAll(): void
  stats(): ProviderRecordMap
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
