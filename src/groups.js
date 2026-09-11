// Groups: the whole point of the compactor.
//
// A hundred tool schemas cost a hundred schemas' worth of context on every single
// request. A group costs thirty words. The agent reads the thirty words, decides
// it needs that group, and only then pulls the real schemas — once.
//
// Group descriptions are meant to be edited by a human or by the agent itself
// (`describe_group`), because whoever knows what the tools are for writes a
// better thirty words than any heuristic.

export const MAX_WORDS = 30
export const DEFAULT_CONFIG_DIR = "~/.config/tool-call-compactor"

/** Server name → group id. Servers that alias to the same id merge, which is the
 *  point: chrome-devtools and playwright are one thing to an agent ("browser"). */
export const SERVER_ALIASES = {
  "chrome-devtools-mcp": "browser",
  "playwright-mcp": "browser",
  "puppeteer": "browser",
  "github": "git",
  "github-mcp-server": "git",
  "gitlab": "git",
  "mcp-server-fetch": "web",
  "fetch": "web",
  "websearch-deepseek": "websearch",
  "brave-search": "websearch",
  "tavily": "websearch",
  "exa": "websearch",
  "captcha": "captcha",
  "pierrondi-solver": "captcha",
  "scrapling-mcp": "scraping",
  "firecrawl": "scraping",
  "vadgr-computer-use": "computer",
  "computer-use-linux": "computer",
  "desktop-commander": "computer",
  "contextcache": "context",
  "memory": "context",
  "envy-bridge": "messaging",
  "antigravity-bridge": "messaging",
  "slack": "messaging",
  "discord": "messaging",
  "oc_bg": "jobs",
  "speak": "speech",
  "blender-mcp": "blender",
  "unreal-mcp": "unreal",
  "better-design": "design",
  "filesystem": "files",
  "postgres": "database",
  "sqlite": "database",
  "stripe": "payments",
}

/** Tool name → group id, for servers that hold several unrelated tool families.
 *  The built-ins are exactly that case: bash is not a file tool. */
export const TOOL_ALIASES = {
  builtin: {
    bash: "shell",
    read: "files",
    write: "files",
    edit: "files",
    glob: "files",
    grep: "files",
    webfetch: "web",
  },
}

/** Titles and thirty-word descriptions for the batches we know how to describe.
 *  Anything not listed here is titled and described from its own tool list. */
export const KNOWN_GROUPS = {
  shell: {
    title: "Shell",
    description: "Run shell commands and return stdout, stderr and exit code. Git, tests, builds, package managers, system inspection.",
  },
  files: {
    title: "Files",
    description: "Read file contents with line numbers, write and replace text, find files by glob, search contents by regex.",
  },
  browser: {
    title: "Browser",
    description: "Drive a real browser: open pages, click, type, screenshot, read console and network, run JavaScript, audit performance.",
  },
  git: {
    title: "Git and GitHub",
    description: "GitHub: search code and repositories, read and write files, manage issues, pull requests, reviews and branches.",
  },
  web: {
    title: "Web fetch",
    description: "Fetch a URL and return the page content as text or markdown. One-shot HTTP retrieval.",
  },
  websearch: {
    title: "Web search",
    description: "Search the live web and return ranked results with titles, URLs and snippets.",
  },
  captcha: {
    title: "CAPTCHA solving",
    description: "Solve CAPTCHAs: reCAPTCHA, hCaptcha, image and slider puzzles, returning a solution token.",
  },
  scraping: {
    title: "Web scraping",
    description: "Fetch pages through stealth browsers with sessions, CSS selectors, proxies and screenshots. For sites that block plain requests.",
  },
  computer: {
    title: "Desktop control",
    description: "Control this Linux desktop: move the mouse, click, type text, press keys, screenshot the screen.",
  },
  context: {
    title: "Workspace context",
    description: "Workspace context cache: store and retrieve file summaries and prebuilt context packs.",
  },
  messaging: {
    title: "Agent messaging",
    description: "Send and read messages over the local agent bridges.",
  },
  jobs: {
    title: "Background jobs",
    description: "Background job control: start long-running commands, poll their status, collect output.",
  },
  speech: {
    title: "Speech",
    description: "Speak text aloud through the host's speakers.",
  },
  blender: {
    title: "Blender",
    description: "Blender 3D: inspect and edit the current scene, run Python, import and export models.",
  },
  unreal: {
    title: "Unreal Engine",
    description: "Unreal Engine: build materials and blueprints, edit Niagara systems, run editor Python.",
  },
  design: {
    title: "Design system",
    description: "Frontend design system: UI and UX principles, icons, motion guidance, component and review rules.",
  },
  database: {
    title: "Database",
    description: "Run SQL queries and inspect schemas on a configured database.",
  },
  payments: {
    title: "Payments",
    description: "Stripe: customers, products, prices, payments, subscriptions and invoices.",
  },
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length
}

/** Hard cap at MAX_WORDS: the whole value proposition collapses if a "30-word"
 *  description is really 90 words. */
export function clampWords(text, max = MAX_WORDS) {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean)
  if (parts.length <= max) return parts.join(" ")
  return parts.slice(0, max).join(" ")
}

export function groupIdForServer(server) {
  return SERVER_ALIASES[server] || slug(server)
}

/** The group a single tool belongs to: per-tool aliases win over per-server. */
export function groupIdFor(server, toolName) {
  const perTool = TOOL_ALIASES[server]
  if (perTool && perTool[toolName]) return perTool[toolName]
  return groupIdForServer(server)
}

/** One line an agent can skim: the batch title, its id, its size, its description. */
export function describeLine(id, group, toolCount) {
  const size = toolCount ? ` (${toolCount} tools)` : ""
  const hint = group.hint ? ` ${group.hint}` : ""
  const description = String(group.description || "").trim().replace(/\.+$/, "")
  return `${group.title || titleFor(id)} [${id}]${size}: ${description}.${hint}`
}

/** "shell" → "Shell", "web_search" → "Web Search". */
export function titleFor(id, servers = []) {
  const known = KNOWN_GROUPS[id]
  if (known?.title) return known.title
  const words = String(id).split(/[_\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1))
  if (words.length) return words.join(" ")
  return servers.join(", ")
}

/** Build a catalog entry lookup: "server::tool" → tool. */
export function toolIndex(catalog) {
  const idx = new Map()
  for (const [server, entry] of Object.entries(catalog?.servers || {})) {
    for (const tool of entry.tools || []) idx.set(`${server}::${tool.name}`, { server, ...tool })
  }
  return idx
}

/** Which tools belong to a group. Explicit `tools` entries win; otherwise every
 *  tool from every listed server belongs to the group. */
export function toolsInGroup(group, catalog, index = toolIndex(catalog)) {
  const out = []
  const claimed = new Set()
  for (const ref of group.tools || []) {
    const [server, name] = ref.includes("::") ? ref.split("::") : [null, ref]
    if (server) {
      const hit = index.get(`${server}::${name}`)
      if (hit) {
        out.push(hit)
        claimed.add(`${hit.server}::${hit.name}`)
      }
    } else {
      for (const [key, tool] of index) {
        if (tool.name === name && !claimed.has(key)) {
          out.push(tool)
          claimed.add(key)
        }
      }
    }
  }
  for (const server of group.servers || []) {
    for (const [key, tool] of index) {
      if (tool.server === server && !claimed.has(key)) {
        out.push(tool)
        claimed.add(key)
      }
    }
  }
  return out
}

/** Say what a group is, when nobody wrote a description for it. The first few
 *  tool names are the most honest summary we have — better than the server name
 *  alone, and still inside thirty words. */
export function synthesizeDescription(id, servers, sampleNames = []) {
  const known = KNOWN_GROUPS[id]
  if (known?.description) return clampWords(known.description)
  const label = id.replace(/_/g, " ")
  const names = sampleNames.slice(0, 4)
  if (!names.length) return clampWords(`Tools from ${servers.join(", ")}.`)
  return clampWords(`${label} tools from ${servers.join(", ")}: ${names.join(", ")}.`)
}

/** Derive groups for a catalog that has no explicit grouping yet.
 *
 *  A group that ends up holding every tool a server has is stored as
 *  `servers: [name]` so tools added upstream later join it automatically. A
 *  group holding only part of a server (the built-ins, split into shell/files/
 *  web) is stored as explicit tool refs instead, because there is no way to say
 *  "these three of that server's seven". */
export function autoGroups(catalog) {
  const buckets = new Map()
  for (const [server, entry] of Object.entries(catalog?.servers || {})) {
    const tools = entry.tools || []
    for (const tool of tools) {
      const id = groupIdFor(server, tool.name)
      if (!buckets.has(id)) buckets.set(id, { servers: new Map(), sample: [], refs: [] })
      const bucket = buckets.get(id)
      bucket.servers.set(server, (bucket.servers.get(server) || 0) + 1)
      bucket.refs.push(`${server}::${tool.name}`)
      if (bucket.sample.length < 5) bucket.sample.push(tool.name)
    }
  }
  const totals = Object.fromEntries(
    Object.entries(catalog?.servers || {}).map(([server, entry]) => [server, (entry.tools || []).length]),
  )
  const groups = {}
  for (const [id, bucket] of buckets) {
    const group = {
      title: titleFor(id, [...bucket.servers.keys()]),
      description: synthesizeDescription(id, [...bucket.servers.keys()], bucket.sample),
    }
    const wholeServers = [...bucket.servers.entries()].filter(([server, count]) => count === totals[server]).map(([server]) => server)
    if (wholeServers.length === bucket.servers.size) {
      group.servers = wholeServers
    } else {
      if (wholeServers.length) group.servers = wholeServers
      group.tools = bucket.refs.filter((ref) => !wholeServers.some((server) => ref.startsWith(`${server}::`)))
    }
    groups[id] = group
  }
  return groups
}

/** Merge explicit config groups over an auto-derived set. Config wins; groups
 *  the config never mentions keep their synthesized description. */
export function mergeGroups(auto, configured) {
  const merged = { ...auto }
  for (const [id, group] of Object.entries(configured || {})) {
    merged[id] = { ...merged[id], ...group }
    if (!merged[id].description) merged[id].description = synthesizeDescription(id, merged[id].servers || [])
  }
  return merged
}

export function findGroup(groups, id) {
  if (!id) return null
  const stripped = String(id).replace(/^see_tool_|^see_tools?_/, "")
  for (const candidate of [stripped, id]) {
    const wanted = slug(candidate)
    if (groups[wanted]) return { id: wanted, group: groups[wanted] }
    for (const [key, group] of Object.entries(groups)) {
      if (group.title && slug(group.title) === wanted) return { id: key, group }
    }
  }
  return null
}

/** Every tool in exactly one batch, or the index is lying to the agent. */
export function coverage(groups, catalog, index = toolIndex(catalog)) {
  const owners = new Map()
  for (const [id, group] of Object.entries(groups)) {
    for (const tool of toolsInGroup(group, catalog, index)) {
      const key = `${tool.server}::${tool.name}`
      if (!owners.has(key)) owners.set(key, [])
      owners.get(key).push(id)
    }
  }
  const unbatched = []
  const duplicated = []
  for (const [key] of index) {
    const held = owners.get(key)
    if (!held) unbatched.push(key)
    else if (held.length > 1) duplicated.push({ tool: key, groups: held })
  }
  return { total: index.size, batched: index.size - unbatched.length, unbatched, duplicated }
}
