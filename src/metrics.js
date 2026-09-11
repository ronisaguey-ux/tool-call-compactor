// Metrics: the only way to know whether this thing is actually worth running.
//
// Every event is a JSON line, so the file is readable with grep and the report
// is computed from what really happened rather than from a brochure number.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"

export class Metrics {
  constructor(file) {
    this.file = file
    this.events = []
  }

  record(kind, data = {}) {
    const event = { t: Date.now(), kind, ...data }
    this.events.push(event)
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8")
    } catch {
      // Metrics must never be the reason a tool call fails.
    }
    return event
  }

  read(since = 0) {
    if (!existsSync(this.file)) return []
    try {
      return readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((e) => e && e.t >= since)
    } catch {
      return []
    }
  }
}

const sum = (list, key) => list.reduce((n, e) => n + (e[key] || 0), 0)
const fmt = (n) => n.toLocaleString("en-US")

/** Turn the event log into the number that matters: schemas the agent would
 *  have carried on every turn, versus the index it carries now. */
export function reportLines(events, { windowMs } = {}) {
  const since = windowMs ? Date.now() - windowMs : 0
  const all = events.filter((e) => e.t >= since)
  const advertised = all.filter((e) => e.kind === "advertised")
  const fetched = all.filter((e) => e.kind === "fetch")
  const calls = all.filter((e) => e.kind === "call")
  const searches = all.filter((e) => e.kind === "search")

  const latest = advertised[advertised.length - 1] || {}
  const lastPeriodStart = latest.periodStart || 0
  const indexTokens = latest.tokens || 0
  const hiddenTokens = latest.hiddenTokens || 0
  const hiddenTools = latest.hiddenTools || 0

  const lines = []
  lines.push("tool-call-compactor report")
  lines.push("")
  if (!advertised.length) {
    lines.push("No adverts recorded yet — start a harness against the compactor first.")
    return lines
  }
  lines.push(`Advertised index      : ${fmt(latest.tools || 0)} tools, ~${fmt(indexTokens)} tokens`)
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
  const perGroup = new Map()
  for (const f of fetched) {
    const prev = perGroup.get(f.group) || { n: 0, tokens: 0 }
    perGroup.set(f.group, { n: prev.n + 1, tokens: prev.tokens + (f.tokens || 0) })
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
