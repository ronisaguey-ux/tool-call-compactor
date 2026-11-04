// Metrics: the only way to know whether this thing is actually worth running.
//
// Every event is a JSON line, so the file is readable with grep and the report
// is computed from what really happened rather than from a brochure number.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { MetricEvent } from "./types.js"
import { isRecord } from "./types.js"

export class Metrics {
  file: string
  events: MetricEvent[]

  constructor(file: string) {
    this.file = file
    this.events = []
  }

  record(kind: string, data: Record<string, unknown> = {}): MetricEvent {
    const event: MetricEvent = { t: Date.now(), kind, ...data }
    this.events.push(event)
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8")
    } catch {
      // Metrics must never be the reason a tool call fails.
    }
    return event
  }

  read(since = 0): MetricEvent[] {
    if (!existsSync(this.file)) return []
    try {
      return readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line): MetricEvent | null => {
          try {
            const parsed: unknown = JSON.parse(line)
            // A line that is not an event object is dropped, not trusted.
            return isRecord(parsed) && typeof parsed.t === "number" && typeof parsed.kind === "string"
              ? (parsed as MetricEvent)
              : null
          } catch {
            return null
          }
        })
        .filter((e): e is MetricEvent => e !== null && e.t >= since)
    } catch {
      return []
    }
  }
}

/** A numeric field of an event, or 0. The log is append-only and mixing kinds,
 *  so a field is unknown until it is asked for as a number. */
const num = (value: unknown): number => (typeof value === "number" ? value : 0)
const sum = (list: MetricEvent[], key: string): number => list.reduce((n, e) => n + num(e[key]), 0)
const fmt = (n: number): string => n.toLocaleString("en-US")

/** Turn the event log into the number that matters: schemas the agent would
 *  have carried on every turn, versus the index it carries now. */
export function reportLines(events: MetricEvent[], { windowMs }: { windowMs?: number } = {}): string[] {
  const since = windowMs ? Date.now() - windowMs : 0
  const all = events.filter((e) => e.t >= since)
  const advertised = all.filter((e) => e.kind === "advertised")
  const fetched = all.filter((e) => e.kind === "fetch")
  const calls = all.filter((e) => e.kind === "call")
  const searches = all.filter((e) => e.kind === "search")

  const latest = advertised[advertised.length - 1] || ({} as MetricEvent)
  const lastPeriodStart = num(latest.periodStart)
  const indexTokens = num(latest.tokens)
  const hiddenTokens = num(latest.hiddenTokens)
  const hiddenTools = num(latest.hiddenTools)

  const lines: string[] = []
  lines.push("tool-call-compactor report")
  lines.push("")
  if (!advertised.length) {
    lines.push("No adverts recorded yet — start a harness against the compactor first.")
    return lines
  }
  lines.push(`Advertised index      : ${fmt(num(latest.tools))} tools, ~${fmt(indexTokens)} tokens`)
  lines.push(`Hidden behind groups  : ${fmt(hiddenTools)} tools, ~${fmt(hiddenTokens)} tokens`)
  if (indexTokens + hiddenTokens > 0) {
    const pct = ((1 - indexTokens / (indexTokens + hiddenTokens)) * 100).toFixed(1)
    lines.push(`Reduction             : ${pct}% of tool-schema tokens`)
  }
  if (lastPeriodStart) {
    lines.push("")
    lines.push(`Since ${new Date(lastPeriodStart).toISOString()}:`)
    lines.push(`  group fetches       : ${fmt(fetched.length)} (~${fmt(sum(fetched, "tokens"))} tokens pulled on demand)`)
    lines.push(`  tool calls executed : ${fmt(calls.length)}`)
    lines.push(`  searches            : ${fmt(searches.length)}`)
    if (calls.length) {
      const compressed = calls.filter((c) => c.compressed).length
      lines.push(`  results compressed  : ${fmt(compressed)} of ${fmt(calls.length)}`)
      lines.push(`  result bytes        : ${fmt(sum(calls, "outBytes"))} out, ${fmt(sum(calls, "bytes"))} before compression`)
    }
  }
  const perGroup = new Map<string, { n: number; tokens: number }>()
  for (const f of fetched) {
    const group = typeof f.group === "string" ? f.group : String(f.group ?? "")
    const prev = perGroup.get(group) || { n: 0, tokens: 0 }
    perGroup.set(group, { n: prev.n + 1, tokens: prev.tokens + num(f.tokens) })
  }
  if (perGroup.size) {
    lines.push("")
    lines.push("Most-fetched groups:")
    for (const [group, stat] of [...perGroup].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
      lines.push(`  ${group.padEnd(16)} ${fmt(stat.n)} fetches, ~${fmt(stat.tokens)} tokens`)
    }
  }
  return lines
}
