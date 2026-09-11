// The persist policy decides what a fetched batch costs the prompt from then
// on, so it has to read an old config the way that config was written.

import { test } from "node:test"
import assert from "node:assert/strict"
import { persistPolicy, defaultConfig, LEGACY_DYNAMIC_BUDGET } from "../src/config.js"

test("a config that says nothing gets the auto policy with no budget", () => {
  assert.deepEqual(persistPolicy({}), { mode: "auto", budget: 0, source: "default" })
  assert.deepEqual(persistPolicy(undefined), { mode: "auto", budget: 0, source: "default" })
})

test("the modes are off, auto and agent", () => {
  for (const mode of ["off", "auto", "agent"]) {
    assert.equal(persistPolicy({ persist: mode }).mode, mode)
  }
  assert.equal(persistPolicy({ persist: "nonsense" }).mode, "auto", "an unknown mode falls back rather than exploding")
})

test("persistBudget caps auto; 0 means no cap", () => {
  assert.equal(persistPolicy({ persist: "auto", persistBudget: 1_500 }).budget, 1_500)
  assert.equal(persistPolicy({ persist: "auto", persistBudget: 0 }).budget, 0)
  assert.equal(persistPolicy({ persist: "auto" }).budget, 0)
  assert.equal(persistPolicy({ persist: "auto", persistBudget: -5 }).budget, 0, "a negative budget is no budget")
})

test("persist outranks the legacy dynamic, whichever way it is set", () => {
  assert.deepEqual(persistPolicy({ persist: "agent", dynamic: true }), { mode: "agent", budget: 0, source: "persist" })
  assert.deepEqual(persistPolicy({ persist: "auto", dynamic: false }), { mode: "auto", budget: 0, source: "persist" })
})

test("an old dynamic config keeps the behaviour it was written with", () => {
  assert.equal(persistPolicy({ dynamic: false }).mode, "off")
  assert.equal(persistPolicy({ dynamic: "always" }).mode, "auto")
  assert.equal(persistPolicy({ dynamic: "always" }).budget, 0)
  assert.deepEqual(persistPolicy({ dynamic: true }), { mode: "auto", budget: LEGACY_DYNAMIC_BUDGET, source: "dynamic" })
  assert.equal(persistPolicy({ dynamic: true, dynamicBudget: 900 }).budget, 900)
  assert.equal(persistPolicy({ dynamicBudget: 900 }).budget, 900, "a bare budget still means auto with that budget")
})

test("the written defaults say what the policy does", () => {
  const options = defaultConfig().options
  assert.equal(options.persist, "auto")
  assert.equal(options.persistBudget, 0)
  assert.equal(options.dynamic, undefined, "the legacy switch is not written into new configs")
})
