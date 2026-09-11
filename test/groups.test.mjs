import { test } from "node:test"
import assert from "node:assert/strict"
import {
  autoGroups,
  clampWords,
  coverage,
  describeLine,
  findGroup,
  groupIdFor,
  slug,
  titleFor,
  toolsInGroup,
  toolIndex,
  wordCount,
} from "../src/groups.js"

const catalog = {
  servers: {
    "chrome-devtools-mcp": {
      tools: [
        { name: "click", description: "click a thing", tokens: 10 },
        { name: "navigate_page", description: "go", tokens: 10 },
      ],
    },
    "playwright-mcp": { tools: [{ name: "browser_click", description: "click", tokens: 10 }] },
    github: { tools: [{ name: "search_code", description: "search", tokens: 20 }] },
    builtin: {
      tools: [
        { name: "bash", description: "run shell", tokens: 5 },
        { name: "read", description: "read a file", tokens: 5 },
        { name: "write", description: "write a file", tokens: 5 },
        { name: "webfetch", description: "fetch", tokens: 5 },
      ],
    },
  },
}

test("clampWords caps at thirty words by default", () => {
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ")
  assert.equal(wordCount(clampWords(long)), 30)
  assert.equal(clampWords("short one"), "short one")
})

test("servers aliasing to the same id merge into one batch", () => {
  const groups = autoGroups(catalog)
  assert.ok(groups.browser, "browser batch exists")
  assert.deepEqual(groups.browser.servers.sort(), ["chrome-devtools-mcp", "playwright-mcp"])
  assert.equal(toolsInGroup(groups.browser, catalog).length, 3)
})

test("built-ins split by tool, not by server", () => {
  const groups = autoGroups(catalog)
  assert.deepEqual(groups.shell.tools, ["builtin::bash"])
  assert.equal(groups.files.tools.length, 2)
  assert.deepEqual(groups.web.tools, ["builtin::webfetch"])
})

test("a batch that takes only part of a server stores explicit tool refs", () => {
  const groups = autoGroups(catalog)
  assert.equal(groups.files.servers, undefined)
  assert.ok(groups.files.tools.includes("builtin::read"))
  assert.ok(groups.git.servers.includes("github"), "a whole-server batch keeps the server ref")
})

test("a tool added to a whole-server batch later is picked up automatically", () => {
  const groups = autoGroups(catalog)
  const grown = structuredClone(catalog)
  grown.servers.github.tools.push({ name: "new_tool", description: "new", tokens: 1 })
  assert.equal(toolsInGroup(groups.git, grown).length, 2)
})

test("every catalogued tool lands in exactly one batch", () => {
  const groups = autoGroups(catalog)
  const cov = coverage(groups, catalog, toolIndex(catalog))
  assert.equal(cov.unbatched.length, 0)
  assert.deepEqual(cov.duplicated, [])
  assert.equal(cov.batched, cov.total)
})

test("coverage reports a tool no batch claims", () => {
  const cov = coverage({ shell: { servers: ["builtin"] } }, catalog, toolIndex(catalog))
  assert.ok(cov.unbatched.length > 0)
  assert.ok(cov.unbatched.includes("github::search_code"))
})

test("titles are human readable and ids stay slugs", () => {
  assert.equal(titleFor("shell"), "Shell")
  assert.equal(titleFor("web_search"), "Web Search")
  assert.equal(slug("Web Search"), "web_search")
  assert.equal(slug("Git and GitHub"), "git_and_github")
})

test("findGroup resolves id, title, and the see_tools_ prefix", () => {
  const groups = { git: { title: "Git and GitHub", description: "d" } }
  assert.equal(findGroup(groups, "git").id, "git")
  assert.equal(findGroup(groups, "Git and GitHub").id, "git")
  assert.equal(findGroup(groups, "see_tools_git").id, "git")
  assert.equal(findGroup(groups, "see_tool_git").id, "git")
  assert.equal(findGroup(groups, "nope"), null)
})

test("groupIdFor prefers per-tool aliases over the server alias", () => {
  assert.equal(groupIdFor("builtin", "bash"), "shell")
  assert.equal(groupIdFor("builtin", "read"), "files")
  assert.equal(groupIdFor("github", "anything"), "git")
})

test("describeLine shows title, id, size and description", () => {
  const line = describeLine("shell", { title: "Shell", description: "Run things." }, 3)
  assert.equal(line, "Shell [shell] (3 tools): Run things.")
})
