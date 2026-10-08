// A config whose command cannot start fails in a way that looks like a network or schema
// problem: the server advertises nothing and the batch comes back empty. These are the
// causes preflightUpstreams has to name before a snapshot is attempted — the `{env:KIT_DIR}`
// class of bug, which cost real time when nothing resolved it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { preflightUpstreams } from "../src/cli.js"

test("an unresolved placeholder is named, not left to look like a dead server", () => {
  const p = preflightUpstreams({ mcp: { a: { command: ["node", "{env:KIT_DIR}/x.js"] } } })
  assert.equal(p.length, 1)
  assert.match(p[0], /\{env:KIT_DIR\}/)
  assert.match(p[0], /never resolved/)

  const q = preflightUpstreams({ mcp: { b: { command: ["node", "__KIT_DIR__/x.js"] } } })
  assert.match(q[0], /__KIT_DIR__/)
})

test("a command pointing at a missing file is caught", () => {
  const p = preflightUpstreams({ mcp: { a: { command: ["node", "/no/such/file.js"] } } })
  assert.equal(p.length, 1)
  assert.match(p[0], /does not exist/)
})

test("a binary that is not on PATH is caught", () => {
  const p = preflightUpstreams({ mcp: { a: { command: ["definitely-not-a-real-binary-xyz"] } } })
  assert.equal(p.length, 1)
  assert.match(p[0], /not on PATH/)
})

test("an entry with no command is caught", () => {
  const p = preflightUpstreams({ mcp: { a: { type: "local" } } })
  assert.equal(p.length, 1)
  assert.match(p[0], /no command/)
})

test("a cwd that does not exist is caught", () => {
  const p = preflightUpstreams({ mcp: { a: { command: ["node", "-e", "0"], cwd: "/no/such/dir" } } })
  assert.equal(p.length, 1)
  assert.match(p[0], /cwd/)
})

test("a healthy config produces NOTHING — otherwise every finding above is meaningless", () => {
  assert.deepEqual(preflightUpstreams({ mcp: { good: { command: ["node", "-e", "0"] } } }), [])
  assert.deepEqual(
    preflightUpstreams({ mcp: { good: { command: [process.execPath, "-e", "0"], cwd: process.cwd() } } }),
    [],
  )
})

test("every broken entry is reported, not just the first", () => {
  const p = preflightUpstreams({
    mcp: {
      a: { command: ["node", "{env:KIT_DIR}/a.js"] },
      b: { command: ["node", "/no/b.js"] },
      c: { command: ["nope-xyz"] },
      good: { command: ["node", "-e", "0"] },
    },
  })
  assert.equal(p.length, 3)
})
