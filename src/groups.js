// Groups: the whole point of the compactor.
//
// A hundred tool schemas cost a hundred schemas' worth of context on every single
// request. A group costs one description. The agent reads it, decides it needs
// that group, and only then pulls the real schemas — once.
//
// Group descriptions are meant to be edited by a human or by the agent itself
// (`describe_group`), because whoever knows what the tools are for writes a
// better description than any heuristic. Length is the writer's call: the index
// is the only thing the prefix pays for, so a description long enough to name the
// capabilities an agent would not have guessed is worth its words. Past ~100 the
// prose stops being an index; below ~20 it stops carrying recall. Advice, not a cap.

export const MAX_WORDS = 30
/** Descriptions are NOT capped — the index is the only thing the prefix pays
 *  for, and an owner who wants to spend more of it on recall should be able to.
 *  This is the range that measures well: past ~100 words the prose stops naming
 *  capabilities an agent would not have guessed, and the index stops being an
 *  index. Reported to the writer as advice, never enforced. */
export const WORDS_RECOMMENDED = [20, 100]
export const DEFAULT_CONFIG_DIR = "~/.config/tool-call-compactor"

/** True when a description sits outside the range this project measures well in.
 *  Only ever used to advise — nothing is trimmed. */
export function outsideRecommended(words) {
  return words > 0 && (words < WORDS_RECOMMENDED[0] || words > WORDS_RECOMMENDED[1])
}

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

/** Titles and descriptions for the batches we know how to describe. Anything not
 *  listed here is titled and described from its own tool list. */
export const KNOWN_GROUPS = {
  shell: {
    title: "Shell",
    description: "Run a shell command and get back stdout, stderr and the exit code. This is where git, tests, builds, package managers, process and service inspection, and anything the other batches do not cover belong. Prefer it over any tool that shells out for you: one command is cheaper than a round trip.",
  },
  files: {
    title: "Files",
    description: "Read a file with line numbers, write a whole file, replace an exact string in one, find files by glob pattern, and search file contents by regex. Read and edit are the pair you will use most; glob and grep are how you find the path you did not know.",
  },
  browser: {
    title: "Browser",
    description: "Drive a real browser: navigate, click, type, fill forms, hover, drag, upload files, handle dialogs, switch tabs, wait for conditions, and locate elements by their visible text. Read console output and network requests, evaluate JavaScript in the page, screenshot, and record performance traces.",
  },
  git: {
    title: "Git and GitHub",
    description: "The GitHub API, not local git. Search code, repositories, issues and users; read, create and update file contents; push several files as one commit; open, review and merge pull requests; manage issues, labels and branches; fork a repository. For local git commands use the shell batch instead.",
  },
  web: {
    title: "Web fetch",
    description: "Fetch one URL over plain HTTP and return the page as markdown, text or raw HTML. The cheap first attempt at any URL, so try it before the scraping batch. It cannot click, log in or run scripts, so escalate when a page comes back blocked, empty, or JavaScript-only.",
  },
  websearch: {
    title: "Web search",
    description: "Search the live web and get back ranked results with titles, URLs and snippets. Use it for anything current or versioned — release notes, prices, news, an unfamiliar library's real API — rather than answering from memory, then fetch a result in full with the web batch.",
  },
  captcha: {
    title: "CAPTCHA solving",
    description: "Solve the challenges that block automation: reCAPTCHA and hCaptcha through real headed browser engines, image puzzles through OCR, slider puzzles. Detect what kind of challenge a page is showing and get back a solution token to submit. Tokens stay bound to the browser session that solved them.",
  },
  scraping: {
    title: "Web scraping",
    description: "Fetch pages that block ordinary requests, through stealth browsers that fight bot detection, with sessions that hold cookies and headers across calls, an escalation ladder from plain HTTP to a full browser, CSS-selector extraction, bulk parallel requests and screenshots.",
  },
  computer: {
    title: "Desktop control",
    description: "Control the desktop the way a person would: move and click the mouse, drag, scroll, type, press keys, use the clipboard, list and switch windows, launch apps, and screenshot the screen or a region. An accessibility-tree family lets you find and act on a labelled control without pixel hunting.",
  },
  context: {
    title: "Workspace context",
    description: "A prebuilt cache of the workspace: per-file summaries and named context packs, written ahead of time so a file does not have to be read again. Ask for a summary by path, or a context pack by name, before reading a large file for the first time.",
  },
  messaging: {
    title: "Agent messaging",
    description: "Talk to the other agents on this machine: send a message, read what came back, poll an inbox for new mail, check whether a bridge is alive, and pull the conversation history. How work is handed to another agent, or relayed to the user out of band.",
  },
  jobs: {
    title: "Background jobs",
    description: "Background jobs that outlive the current turn: spawn a long-running command or a whole agent, list what is running, poll its status, read its log, message it, pause, resume or kill it. Use it instead of a blocking command for anything that takes minutes or must keep running after you reply.",
  },
  speech: {
    title: "Speech",
    description: "Speak text aloud through this machine's speakers, and report which speech engine is available. Use it to alert the user when they are away from the keyboard, read a result out loud, or announce that a long job finished. Text goes in, audio comes out.",
  },
  blender: {
    title: "Blender",
    description: "Blender 3D: inspect the open scene and its objects, run arbitrary Blender Python, take viewport screenshots, import and export models. It also generates models from a text prompt or reference images, polls those jobs, and downloads stock HDRIs, textures and models from the usual asset libraries.",
  },
  unreal: {
    title: "Unreal Engine",
    description: "Unreal Engine editor: author materials and Blueprints down to individual nodes and compile them, build Niagara VFX down to emitters, modules and custom HLSL, configure StateTree AI and Mass entity traits, edit UMG widgets, data tables, data assets, input mappings and level actors, import assets, and run editor Python.",
  },
  design: {
    title: "Design system",
    description: "Frontend design system: read the UI and UX principles before styling or wiring behaviour, pick or extract a design system, find and install icon sets, pull widget and motion guidance, then self-review against the review rules, a comprehension check and a spacing inspection that measures real rendered layout.",
  },
  database: {
    title: "Database",
    description: "Run SQL against a configured database and inspect its schema. Use it for queries and introspection rather than shelling out to a client — the connection is already configured, and results come back structured.",
  },
  payments: {
    title: "Payments",
    description: "Stripe: read and manage customers, products, prices, payments, subscriptions and invoices. Use it for anything billing-shaped rather than reconstructing requests by hand.",
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

/** Hard cap at MAX_WORDS. Only titles and synthesized descriptions go through
 *  here — a title becomes a tool name, so it has to stay short. A description a
 *  human or the agent wrote deliberately is never truncated. */
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
 *  alone, and short enough to skim. Only a synthesized description is clamped;
 *  `describe_group` may write as much as it likes. */
export function synthesizeDescription(id, servers, sampleNames = []) {
  const known = KNOWN_GROUPS[id]
  if (known?.description) return known.description
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
