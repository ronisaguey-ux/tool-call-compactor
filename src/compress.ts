// Result compression: a tool that returns 400 array items cost 400 items'
// worth of context, and the agent almost never reads past the tenth.
//
// Two hard rules, both learned the hard way by everyone who has written one of
// these proxies:
//   1. Never touch an error result. A truncated stack trace is a wrong answer.
//   2. Never touch the head. The agent's question is answered by what comes
//      first; it is the tail that is disposable, and the marker says so.

import type { McpCallToolResult, McpContentBlock, McpTextContent } from "./types.js"
import { isRecord } from "./types.js"

export interface CompressLimits {
  /** characters in a single text block before truncation */
  maxText?: number
  /** content blocks kept from a long result */
  maxItems?: number
  headItems?: number
  tailItems?: number
}

export interface ResolvedLimits {
  maxText: number
  maxItems: number
  headItems: number
  tailItems: number
}

export const DEFAULT_LIMITS: ResolvedLimits = {
  maxText: 10_000, // characters in a single text block before truncation
  maxItems: 10, // content blocks kept from a long result
  headItems: 3,
  tailItems: 2,
}

function isText(part: unknown): part is McpTextContent {
  return isRecord(part) && part.type === "text" && typeof part.text === "string"
}

export function textBytes(result: McpCallToolResult | null | undefined): number {
  if (!result || !Array.isArray(result.content)) return 0
  return result.content.reduce((n, part) => n + (isText(part) ? part.text.length : JSON.stringify(part).length), 0)
}

export function truncateText(text: string, maxText: number): string {
  if (text.length <= maxText) return text
  const head = Math.floor(maxText * 0.6)
  const tail = maxText - head
  const dropped = text.length - maxText
  return `${text.slice(0, head)}\n… [tool-call-compactor truncated ${dropped.toLocaleString("en-US")} characters] …\n${text.slice(-tail)}`
}

function clipTextParts(content: McpContentBlock[], maxText: number): { out: McpContentBlock[]; changed: boolean } {
  let changed = false
  const out = content.map((part) => {
    if (!isText(part) || part.text.length <= maxText) return part
    changed = true
    return { ...part, text: truncateText(part.text, maxText) }
  })
  return { out, changed }
}

function clipItemCount(
  content: McpContentBlock[],
  { maxItems, headItems, tailItems }: ResolvedLimits,
): { out: McpContentBlock[]; changed: boolean } {
  if (content.length <= maxItems) return { out: content, changed: false }
  const head = content.slice(0, headItems)
  const tail = content.slice(-tailItems)
  const dropped = content.length - head.length - tail.length
  const marker: McpTextContent = {
    type: "text",
    text: `… [tool-call-compactor omitted ${dropped} of ${content.length} result blocks] …`,
  }
  return { out: [...head, marker, ...tail], changed: true }
}

/** Compress a callTool result. Errors pass through untouched, always. */
export function compressResult(
  result: McpCallToolResult | null | undefined,
  limits: CompressLimits = {},
): { result: McpCallToolResult | null | undefined; compressed: boolean } {
  const opts: ResolvedLimits = { ...DEFAULT_LIMITS, ...limits }
  if (!result || result.isError || !Array.isArray(result.content)) {
    return { result, compressed: false }
  }
  const byCount = clipItemCount(result.content, opts)
  const byText = clipTextParts(byCount.out, opts.maxText)
  const compressed = byCount.changed || byText.changed
  if (!compressed) return { result, compressed: false }
  return { result: { ...result, content: byText.out }, compressed: true }
}

/** Cap a JSON-schema-ish object's arrays so a fetched schema cannot itself blow
 *  the budget (some upstreams ship enormous enums). */
export function clampSchema<T>(schema: T, maxEnum = 50, depth = 0): T {
  return clampAny(schema, maxEnum, depth) as T
}

function clampAny(schema: unknown, maxEnum: number, depth: number): unknown {
  if (depth > 8 || !schema || typeof schema !== "object") return schema
  if (Array.isArray(schema)) {
    const kept = schema.slice(0, maxEnum)
    return depth === 0 ? kept : kept.concat(schema.length > maxEnum ? ["…"] : [])
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum" && Array.isArray(value) && value.length > maxEnum) {
      out[key] = value.slice(0, maxEnum).concat([`… ${value.length - maxEnum} more`])
    } else if (key === "examples" && Array.isArray(value) && value.length > 3) {
      out[key] = value.slice(0, 3)
    } else {
      out[key] = clampAny(value, maxEnum, depth + 1)
    }
  }
  return out
}
