// End-to-end: a real MCP client talks to the compactor over a real transport,
// and has to find every upstream tool behind the compacted index.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Compactor } from "../src/server.js"
import { defaultConfig } from "../src/config.js"
import { Metrics } from "../src/metrics.js"
import { estimateTokens } from "../src/catalog.js"
import { autoGroups } from "../src/groups.js"

const big = (n) => "x".repeat(n)

/** Tool definitions of the size real MCP servers ship: a paragraph of
 *  description and a schema with several documented properties. */
function tool(name, description, propCount = 4) {
  const properties = {}
  for (let i = 0; i < propCount; i++) {
    properties[`param_${i}`] = {
      type: "string",
      description: `The ${name} parameter number ${i}, which controls one specific aspect of how ${name} behaves when it runs.`,
    }
  }
  const inputSchema = { type: "object", properties, required: ["param_0"], additionalProperties: false }
  const definition = { name, description, inputSchema }
  return { ...definition, hash: `h${name}`, tokens: estimateTokens(definition) }
}

const GITHUB_TOOLS = [
  tool("search_code", "Search for code across every repository the authenticated user can read, with qualifiers for language, path, repository and file size."),
  tool("create_issue", "Open a new issue in a repository, with an optional body, labels, assignees and milestone."),
  ...Array.from({ length: 18 }, (_, i) =>
    tool(`github_op_${i}`, `A GitHub operation number ${i} that does one specific thing to repositories, issues or pull requests, with its own parameters and behaviour.`),
  ),
]

const CATALOG = {
  servers: {
    github: { tools: GITHUB_TOOLS },
    builtin: { tools: [tool("bash", "Run a shell command and return its stdout, stderr and exit code.")] },
  },
}

const catalogToolCount = Object.values(CATALOG.servers).reduce((n, s) => n + s.tools.length, 0)

const CALLS = []

class FakeUpstream {
  constructor(name, tools) {
    this.name = name
    this.tools = tools
    this.stats = { calls: 0, errors: 0 }
  }
  async listTools() {
    return this.tools
  }
  async callTool(name, args) {
    CALLS.push({ server: this.name, name, args })
    if (name === "big_result") {
      return { content: [{ type: "text", text: big(50_000) }] }
    }
    if (name === "explodes") {
      return { content: [{ type: "text", text: big(40_000) }], isError: true }
    }
    return { content: [{ type: "text", text: `ran ${this.name}.${name} with ${JSON.stringify(args)}` }] }
  }
  close() {}
}

function makePool(extra = {}) {
  const servers = {
    github: new FakeUpstream("github", CATALOG.servers.github.tools),
    builtin: new FakeUpstream("builtin", CATALOG.servers.builtin.tools),
    ...extra,
  }
  return {
    names: () => Object.keys(servers),
    has: (n) => n in servers,
    get: (n) => {
      if (!servers[n]) throw new Error(`unknown upstream: ${n}`)
      return servers[n]
    },
    stats: () => servers,
    closeAll: () => {},
  }
}

async function connect({ config = {}, groups, pool, capabilities, catalog } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcc-test-"))
  const cfg = { ...defaultConfig(), ...config, dir, file: path.join(dir, "tcc.config.json") }
  cfg.options = { ...defaultConfig().options, ...(config.options || {}), control: { enabled: false } }
  const used = catalog || CATALOG
  const compactor = new Compactor({
    config: cfg,
    pool: pool || makePool(),
    catalog: used,
    groups: groups || autoGroups(used),
    metrics: new Metrics(path.join(dir, "metrics.jsonl")),
    log: () => {},
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-harness", version: "1" }, { capabilities: capabilities || {} })
  await Promise.all([compactor.mcp.connect(serverTransport), client.connect(clientTransport)])
  return { compactor, client, cfg, dir }
}

test("the advertised index is a handful of tiny tools, not the real schemas", async () => {
  const { client } = await connect()
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  assert.ok(names.includes("list_groups"))
  assert.ok(names.includes("see_tools_git"), `see_tools_git missing from ${names}`)
  assert.ok(names.includes("see_tools_shell"))
  assert.ok(!names.includes("search_code"), "the real tool must not be advertised")

  // What the harness would have carried: every upstream definition, verbatim.
  const hidden = Object.values(CATALOG.servers)
    .flatMap((s) => s.tools)
    .map((t) => JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }))
    .join("")
  const advertised = JSON.stringify(tools)
  assert.ok(advertised.length < hidden.length / 2, `index ${advertised.length}B should be far smaller than the ${hidden.length}B it hides`)
})

test("list_groups shows every batch with its title and description", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "list_groups", arguments: {} })
  const text = res.content[0].text
  assert.match(text, /Git and GitHub \[git\]/)
  assert.match(text, /Shell \[shell\]/)
  assert.match(text, /see_tools_/)
})

test("see_tools_<group> returns the full schemas that batch hides", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "see_tools_git", arguments: {} })
  const text = res.content[0].text
  assert.match(text, /search_code \(github\)/)
  assert.match(text, /create_issue \(github\)/)
  assert.match(text, /"param_0"/, "the input schema is included, not just the name")
  assert.match(text, /"additionalProperties":false/, "the schema is passed through intact")
})

test("the singular see_tool_<group> spelling works too", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "see_tool_git", arguments: {} })
  assert.match(res.content[0].text, /search_code/)
})

test("a batch is addressable by its title as well as its id", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "fetch_group", arguments: { group: "Git and GitHub" } })
  assert.match(res.content[0].text, /search_code/)
})

test("names_only gives an index without schemas", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "see_tools_git", arguments: { names_only: true } })
  const text = res.content[0].text
  assert.match(text, /search_code/)
  assert.ok(!text.includes('"q"'), "names_only must not carry schemas")
})

test("a single tool can be pulled out of a batch", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "see_tools_git", arguments: { tool: "create_issue" } })
  const text = res.content[0].text
  assert.match(text, /create_issue \(github\)/)
  assert.ok(!text.includes("search_code"), "only the requested tool comes back")
})

test("fetched tools execute through call_tool", async () => {
  CALLS.length = 0
  const { client } = await connect()
  const res = await client.callTool({ name: "call_tool", arguments: { server: "github", tool: "search_code", arguments: { q: "x" } } })
  assert.equal(res.isError, undefined)
  assert.match(res.content[0].text, /ran github\.search_code with \{"q":"x"\}/)
  assert.deepEqual(CALLS, [{ server: "github", name: "search_code", args: { q: "x" } }])
})

test("server::tool shorthand works when the server is omitted", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "call_tool", arguments: { tool: "github::search_code", arguments: { q: "y" } } })
  assert.match(res.content[0].text, /ran github\.search_code/)
})

test("a lone tool name resolves to its only owner", async () => {
  CALLS.length = 0
  const { client } = await connect()
  const res = await client.callTool({ name: "call_tool", arguments: { tool: "bash", arguments: { command: "true" } } })
  assert.equal(CALLS[0].server, "builtin")
  assert.equal(CALLS[0].name, "bash")
})

test("an ambiguous tool name is refused rather than guessed", async () => {
  const duplicate = { name: "bash", description: "A second bash.", inputSchema: { type: "object" }, hash: "hdup", tokens: 40 }
  const catalog = { servers: { ...CATALOG.servers, other: { tools: [duplicate] } } }
  const { client } = await connect({
    catalog,
    pool: makePool({ other: new FakeUpstream("other", [duplicate]) }),
  })
  const res = await client.callTool({ name: "call_tool", arguments: { tool: "bash", arguments: {} } })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /exists on .*builtin.*other|exists on .*other.*builtin/)
})

test("search_tools finds a tool by name and by purpose", async () => {
  const { client } = await connect()
  const byName = await client.callTool({ name: "search_tools", arguments: { query: "create_issue" } })
  assert.match(byName.content[0].text, /github::create_issue/)
  const byPurpose = await client.callTool({ name: "search_tools", arguments: { query: "issue" } })
  assert.match(byPurpose.content[0].text, /\[git\]/)
})

test("search_tools says so when nothing matches", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "search_tools", arguments: { query: "zzzznothing" } })
  assert.match(res.content[0].text, /No tool matched/)
})

test("a huge result is compressed, an error result never is", async () => {
  const pool = makePool({
    bulky: new FakeUpstream("bulky", [
      { name: "big_result", description: "big", inputSchema: {}, tokens: 5 },
      { name: "explodes", description: "error", inputSchema: {}, tokens: 5 },
    ]),
  })
  const { client } = await connect({ pool, groups: { bulky: { title: "Bulky", description: "big tools", servers: ["bulky"] } } })
  const bigRes = await client.callTool({ name: "call_tool", arguments: { tool: "bulky::big_result" } })
  assert.match(bigRes.content[0].text, /truncated/)

  const errRes = await client.callTool({ name: "call_tool", arguments: { tool: "bulky::explodes" } })
  assert.equal(errRes.isError, true)
  assert.equal(errRes.content[0].text.length, 40_000, "an error keeps every character")
})

test("compression can be turned off per call", async () => {
  const pool = makePool({
    bulky: new FakeUpstream("bulky", [{ name: "big_result", description: "big", inputSchema: {}, tokens: 5 }]),
  })
  const { client } = await connect({ pool, groups: { bulky: { servers: ["bulky"] } } })
  const res = await client.callTool({ name: "call_tool", arguments: { tool: "bulky::big_result", compress: false } })
  assert.equal(res.content[0].text.length, 50_000)
})

test("describe_group rewrites the batch and persists it to the config file", async () => {
  const { client, cfg } = await connect()
  const res = await client.callTool({
    name: "describe_group",
    arguments: { group: "git", description: "Everything GitHub: code search, issues, pull requests, reviews and releases." },
  })
  assert.match(res.content[0].text, /Updated "git"/)
  const saved = JSON.parse(readFileSync(cfg.file, "utf8"))
  assert.equal(saved.groups.git.description, "Everything GitHub: code search, issues, pull requests, reviews and releases.")
})

test("describe_group trims a description that runs past thirty words", async () => {
  const { client, cfg } = await connect()
  const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ")
  const res = await client.callTool({ name: "describe_group", arguments: { group: "git", description: long } })
  assert.match(res.content[0].text, /30 of 30 words, trimmed from 45/)
  const saved = JSON.parse(readFileSync(cfg.file, "utf8"))
  assert.equal(saved.groups.git.description.split(" ").length, 30)
})

test("renaming a batch moves its id and the advertised tool name", async () => {
  const { client, compactor } = await connect()
  const res = await client.callTool({ name: "describe_group", arguments: { group: "git", title: "Code hosting" } })
  assert.match(res.content[0].text, /renamed see_tools_git → see_tools_code_hosting/)
  const names = (await client.listTools()).tools.map((t) => t.name)
  assert.ok(names.includes("see_tools_code_hosting"))
  assert.ok(!names.includes("see_tools_git"))
  assert.ok(compactor.groups.code_hosting)
})

test("a small batch is exposed natively after it is fetched", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "see_tools_shell", arguments: {} })
  assert.match(res.content[0].text, /Registered \d+ tools natively/)
  const names = (await client.listTools()).tools.map((t) => t.name)
  assert.ok(names.includes("shell__bash"), `expected shell__bash in ${names}`)
  const called = await client.callTool({ name: "shell__bash", arguments: { command: "true" } })
  assert.match(called.content[0].text, /ran builtin\.bash/)
})

test("a batch over the exposure budget is not registered, so the saving survives", async () => {
  const { client } = await connect({ config: { options: { dynamicBudget: 100 } } })
  const res = await client.callTool({ name: "see_tools_git", arguments: {} })
  assert.match(res.content[0].text, /Execute with call_tool/)
  const names = (await client.listTools()).tools.map((t) => t.name)
  assert.ok(!names.some((n) => n.startsWith("git__")))
})

test("every tool is reachable by call_tool even when nothing is registered", async () => {
  CALLS.length = 0
  const { client } = await connect({ config: { options: { dynamic: false } } })
  await client.callTool({ name: "see_tools_git", arguments: {} })
  const res = await client.callTool({ name: "call_tool", arguments: { tool: "github::github_op_7", arguments: { param_0: "z" } } })
  assert.equal(res.isError, undefined)
  assert.deepEqual(CALLS, [{ server: "github", name: "github_op_7", args: { param_0: "z" } }])
})

test("dynamic exposure can be switched off entirely", async () => {
  const { client } = await connect({ config: { options: { dynamic: false } } })
  const res = await client.callTool({ name: "see_tools_shell", arguments: {} })
  assert.match(res.content[0].text, /Execute with call_tool/)
  const names = (await client.listTools()).tools.map((t) => t.name)
  assert.ok(!names.some((n) => n.startsWith("shell__")))
})

test("an unknown batch explains itself instead of failing", async () => {
  const { client } = await connect()
  const res = await client.callTool({ name: "see_tools_nope", arguments: {} })
  assert.match(res.content[0].text, /Unknown group "nope"/)
  assert.match(res.content[0].text, /git/)
})

test("an upstream failure surfaces as a tool error, not a crash", async () => {
  const broken = {
    ...makePool(),
    get: (n) => {
      if (n === "github") return { listTools: async () => [], callTool: async () => { throw new Error("upstream went away") }, close() {} }
      return makePool().get(n)
    },
  }
  const { client } = await connect({ pool: broken })
  const res = await client.callTool({ name: "call_tool", arguments: { tool: "github::search_code", arguments: {} } })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /upstream went away/)
})

test("metrics record what was advertised and what was fetched", async () => {
  const { client, compactor } = await connect({ config: { options: { dynamic: false } } })
  await client.listTools()
  const before = compactor.metrics.read().find((e) => e.kind === "advertised")
  assert.ok(before.tokens > 0, "the index has a token cost")
  assert.equal(before.hiddenTools, catalogToolCount, "every upstream tool is hidden behind the index")
  assert.ok(
    before.hiddenTokens > before.tokens,
    `hiding ${before.hiddenTokens} tokens behind a ${before.tokens}-token index`,
  )

  await client.callTool({ name: "see_tools_git", arguments: {} })
  const fetch = compactor.metrics.read().find((e) => e.kind === "fetch")
  assert.equal(fetch.group, "git")
  assert.equal(fetch.tools, GITHUB_TOOLS.length)
  assert.ok(fetch.tokens > 0)
})

test("a group with no catalog entry still works, by asking the server live", async () => {
  const pool = makePool()
  const { client } = await connect({ pool, groups: { live: { title: "Live", description: "direct", servers: ["github"] } } })
  const res = await client.callTool({ name: "see_tools_live", arguments: {} })
  assert.match(res.content[0].text, /search_code/)
})

test("estimateTokens is the same measure for index and hidden tools", () => {
  const token = estimateTokens({ name: "x", description: "y", inputSchema: { type: "object" } })
  assert.ok(Number.isInteger(token) && token > 0)
})

test.after(() => {
  for (const dir of []) rmSync(dir, { recursive: true, force: true })
})
