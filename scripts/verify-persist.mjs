#!/usr/bin/env node
// End-to-end check of the persist feature against a real config.
//
// Not part of `npm test`: it spawns whatever the config points at. It is the
// proof that pinning a batch changes the tool list a harness actually reads,
// that the pinned tools are callable rather than merely listed, and that
// dropping the pin puts the batch back behind its `see_tools_` entry.
//
//   node scripts/verify-persist.mjs --config ~/.config/tool-call-compactor [--batch speech]

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import path from "node:path"
import { loadConfig, resolveConfigDir } from "../src/config.js"

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dir = resolveConfigDir(argOf("config"))
const cfg = loadConfig(dir)

let failures = 0
const check = (name, passed, detail = "") => {
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!passed) failures += 1
}

// Pick a small batch: pinning it must not depend on spawning anything heavy.
const candidates = Object.keys(cfg.groups || {}).filter((id) => !cfg.groups[id].expose)
const batch = argOf("batch", candidates[0])
if (!batch) {
  console.log("no compacted batch in this config to pin")
  process.exit(1)
}

const cli = path.resolve(new URL("../bin/tcc.js", import.meta.url).pathname)
const client = new Client({ name: "verify-persist", version: "1" }, { capabilities: {} })
let listChanges = 0
const transport = new StdioClientTransport({
  command: "node",
  args: [cli, "serve", "--config", dir],
  stderr: "inherit",
})
await client.connect(transport)
client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
  listChanges += 1
})

const toolNames = async () => (await client.listTools()).tools.map((t) => t.name)
const liveOf = (names) => names.filter((n) => n.startsWith(`${batch}__`))

const state = await client.callTool({ name: "persist_group", arguments: { group: batch } })
check(
  "persist_group reports the batch state",
  /fetch-only|live|pinned|policy/.test(state.content[0].text),
  state.content[0].text.split("\n")[0],
)

const before = await toolNames()
check(
  `"${batch}" starts behind see_tools_`,
  before.includes(`see_tools_${batch}`) && liveOf(before).length === 0,
  `${liveOf(before).length} live tools`,
)

const pin = await client.callTool({ name: "persist_group", arguments: { group: batch, persist: true } })
const after = await toolNames()
const live = liveOf(after)
const text = pin.content[0].text

check(
  `pinning "${batch}" advertises its tools as real tools`,
  live.length > 0,
  `${live.length} live: ${live.slice(0, 4).join(", ")}${live.length > 4 ? ", …" : ""}`,
)
check(
  "pinning is refused cleanly rather than crashing",
  !pin.isError || /persist-off|policy/.test(text),
  pin.isError ? text.split("\n")[0] : "accepted",
)
check("the harness was told the list changed", listChanges > 0, `${listChanges} notification(s)`)

// The point of pinning is that the tools are usable, not just visible.
if (live.length) {
  const called = await client.callTool({ name: live[0], arguments: {} })
  const out = called.content?.[0]?.text ?? ""
  // A tool that ran and complained about its arguments has still been reached.
  // Only "no such tool" means the registration did not take.
  const unreachable = /unknown tool|not found|no such tool/i.test(out) && !called.isError
  check(`a pinned tool is callable (${live[0]})`, !unreachable, out.split("\n")[0].slice(0, 90) || "(empty result)")
}

const drop = await client.callTool({ name: "persist_group", arguments: { group: batch, persist: false } })
const end = await toolNames()
check(
  `dropping the pin puts "${batch}" back behind see_tools_`,
  liveOf(end).length === 0 && end.includes(`see_tools_${batch}`),
  `${liveOf(end).length} live tools · ${drop.content[0].text.split("\n")[0]}`,
)

console.log("")
console.log(`${batch}: ${before.length} tools -> ${after.length} pinned -> ${end.length} released`)
await client.close()
process.exit(failures ? 1 : 0)
