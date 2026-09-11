import { test } from "node:test"
import assert from "node:assert/strict"
import { clampSchema, compressResult, truncateText } from "../src/compress.js"

const textResult = (text) => ({ content: [{ type: "text", text }] })

test("a small result passes through untouched", () => {
  const result = textResult("hello")
  const { result: out, compressed } = compressResult(result)
  assert.equal(compressed, false)
  assert.equal(out, result)
})

test("errors are never compressed, however large", () => {
  const big = { content: [{ type: "text", text: "x".repeat(50_000) }], isError: true }
  const { result: out, compressed } = compressResult(big)
  assert.equal(compressed, false)
  assert.equal(out.content[0].text.length, 50_000)
})

test("long text keeps the head and the tail and says what it dropped", () => {
  const text = "A".repeat(9_000) + "MIDDLE" + "B".repeat(9_000)
  const { result: out, compressed } = compressResult(textResult(text), { maxText: 1_000 })
  assert.equal(compressed, true)
  const body = out.content[0].text
  assert.ok(body.startsWith("A"))
  assert.ok(body.endsWith("B"))
  assert.match(body, /truncated 17,006 characters/)
})

test("a long content array keeps head and tail with a marker between", () => {
  const content = Array.from({ length: 40 }, (_, i) => ({ type: "text", text: `item ${i}` }))
  const { result: out, compressed } = compressResult({ content }, { maxItems: 10, headItems: 3, tailItems: 2 })
  assert.equal(compressed, true)
  assert.equal(out.content.length, 6)
  assert.equal(out.content[0].text, "item 0")
  assert.match(out.content[3].text, /omitted 35 of 40 result blocks/)
  assert.equal(out.content[5].text, "item 39")
})

test("non-text parts survive compression", () => {
  const content = [
    { type: "image", data: "AAAA", mimeType: "image/png" },
    ...Array.from({ length: 20 }, (_, i) => ({ type: "text", text: `t${i}` })),
  ]
  const { result: out } = compressResult({ content }, { maxItems: 10, headItems: 2, tailItems: 2 })
  assert.equal(out.content[0].type, "image")
})

test("truncateText is exact about the character budget", () => {
  const out = truncateText("z".repeat(100), 100)
  assert.equal(out.length, 100)
})

test("clampSchema trims huge enums but leaves small ones alone", () => {
  const big = { type: "string", enum: Array.from({ length: 500 }, (_, i) => `v${i}`) }
  const clamped = clampSchema(big, 50)
  assert.equal(clamped.enum.length, 51)
  assert.match(clamped.enum[50], /450 more/)
  const small = { type: "string", enum: ["a", "b"] }
  assert.deepEqual(clampSchema(small, 50).enum, ["a", "b"])
})

test("clampSchema keeps nesting intact", () => {
  const schema = { type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } }
  assert.deepEqual(clampSchema(schema), schema)
})
