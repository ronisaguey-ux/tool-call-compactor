#!/usr/bin/env node
// End-to-end check against a real config and real upstream servers.
//
// Not part of `npm test`: it spawns whatever the config points at and needs
// network. It is the proof that the compacted index a harness sees is real, that
// a batch can be opened, and that a tool reached through a batch really runs.
//
//   node scripts/verify-live.mjs --config ~/.config/tool-call-compactor [--call server::tool]

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import path from "node:path"
import { loadConfig, resolveConfigDir } from "../src/config.js"
import { readCache, defaultCachePath } from "../src/catalog.js"

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dir = resolveConfigDir(argOf("config"))
const cfg = loadConfig(dir)
const catalog = readCache(cfg.cachePath || defaultCachePath()) || { servers: {} }
const hiddenBytes = JSON.stringify(catalog.servers).length
const hiddenTools = Object.values(catalog.servers).reduce((n, s) => n + (s.tools?.length || 0), 0)

let failures = 0
const check = (name, passed, detail = "") => {
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!passed) failures += 1
}

const cli = path.resolve(new URL("../bin/tcc.js", import.meta.url).pathname)
const transport = new StdioClientTransport({
  command: "node",
  args: [cli, "serve", "--config", dir],
  stderr: "inherit",
})
const client = new Client({ name: "verify-live", version: "1" }, { capabilities: {} })
await client.connect(transport)

// 1. What the harness is actually sent.
const { tools } = await client.listTools()
const indexBytes = JSON.stringify(tools).length
const bytesPerToken = 4
check(
  "the advertised index is compact",
  indexBytes < hiddenBytes * 0.1,
  `${indexBytes.toLocaleString()} B vs ${hiddenBytes.toLocaleString()} B hidden (~${Math.round(indexBytes / bytesPerToken).toLocaleString()} vs ~${Math.round(hiddenBytes / bytesPerToken).toLocaleString()} tokens, ${((1 - indexBytes / hiddenBytes) * 100).toFixed(1)}% less)`,
)
check(
  "the index advertises batches, not upstream tools",
  tools.some((t) => t.name.startsWith("see_tools_")) && !tools.some((t) => t.name === "search_code"),
  `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`,
)

// 2. Every batch is openable and reports the schemas it hides.
const groupTools = tools.filter((t) => t.name.startsWith("see_tools_"))
let schemasSeen = 0
for (const tool of groupTools) {
  const res = await client.callTool({ name: tool.name, arguments: { names_only: true } })
  const text = res.content[0].text
  if (res.isError || /no readable tools|Unknown group/.test(text)) {
    check(`${tool.name} opens`, false, text.slice(0, 120))
    continue
  }
  schemasSeen += (text.match(/^## /gm) || []).length
}
check("every batch opens", failures === 0, `${groupTools.length} batches, ${schemasSeen} tools listed`)

// 3. A batch returns a complete, usable schema rather than a name.
const batch = groupTools[0]
const full = await client.callTool({ name: batch.name, arguments: { tool: undefined } })
check(
  `${batch.name} returns full schemas`,
  /"type"\s*:\s*"object"/.test(full.content[0].text),
  `${full.content[0].text.length.toLocaleString()} B`,
)

// 4. A tool reached through the compactor really runs.
const target = argOf("call", "mcp-server-fetch::fetch")
const [server, name] = target.split("::")
const args = name === "fetch" ? { url: "https://example.com" } : {}
const ran = await client.callTool({ name: "call_tool", arguments: { server, tool: name, arguments: args } })
check(
  `call_tool runs ${target}`,
  !ran.isError && ran.content?.[0]?.text?.length > 0,
  ran.isError ? ran.content[0].text.slice(0, 200) : `${ran.content[0].text.length.toLocaleString()} B returned`,
)

// 5. Search reaches tools the index never advertised.
const found = await client.callTool({ name: "search_tools", arguments: { query: "screenshot" } })
check("search_tools finds hidden tools", /\[/.test(found.content[0].text), found.content[0].text.split("\n")[0])

// 6. Pass-through batches: configured `expose: true`, so their tools are real
//    tools in the first tool list rather than something behind a fetch.
const exposed = Object.entries(cfg.groups || {}).filter(([, g]) => g.expose)
for (const [id] of exposed) {
  const live = tools.filter((t) => t.name.startsWith(`${id}__`))
  check(`batch "${id}" is pass-through`, live.length > 0 && !groupTools.some((t) => t.name === `see_tools_${id}`), `${live.length} live tools`)
}

// 7. The persist policy is what the file says, and asking is never an error.
const asked = await client.callTool({ name: "persist_group", arguments: { group: groupTools[0]?.name?.replace(/^see_tools_/, "") || "shell" } })
check("persist_group answers with the batch state", /policy|persist=|fetch-only|live/.test(asked.content[0].text), asked.content[0].text.split("\n")[0])

console.log("")
console.log(`${hiddenTools} upstream tools behind ${tools.length} advertised tools`)
await client.close()
process.exit(failures ? 1 : 0)
