#!/usr/bin/env node
// Thin shim. The implementation is TypeScript, compiled to ../dist — this file
// stays at bin/tcc.js because every agent's MCP config spawns exactly this path.
const path = require("node:path")
const { main } = require(path.join(__dirname, "..", "dist", "cli.js"))

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`tcc: ${err?.stack || err}\n`)
  process.exit(1)
})
