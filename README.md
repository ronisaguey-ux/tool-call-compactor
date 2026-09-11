# Tool Call Compactor

**Your agent pays for every tool schema on every request. This makes it pay for one description per batch instead, and fetch the schemas only when it needs them.**

Every MCP server you connect, and every built-in tool your harness ships, contributes its full JSON Schema to the prompt — on *every single turn*. Fifty tools is easily 30–60k tokens of schemas sitting in front of the conversation, permanently. It cannot be compacted away, because it is not history: it is the static prefix.

Tool Call Compactor puts a small MCP server in front of all of it. The harness sees a handful of tiny tools plus one entry per **batch**:

```
list_groups, search_tools, call_tool, describe_group, fetch_group,
see_tools_shell, see_tools_files, see_tools_browser, see_tools_git, ...
```

Each batch carries a **title** and a **description** that you (or your agent) write. When the agent needs something in that batch, it calls `see_tools_<batch>` and gets exactly those schemas — once — then calls `call_tool`.

Measured on a real machine with 18 MCP servers attached:

```
Before:  518 tools · 489,905 bytes · ~122,476 tokens of schema on every request
After:    20 tools ·  15,882 bytes ·   ~3,971 tokens, plus a batch only when you open one
```

That is a **98.3% cut** in tool-schema bytes, and on opencode it took the whole static prefix from **170,276 tokens to 31,493** — which is also 49,431 tokens *less* than the same config with three of its heaviest servers switched off.

## Install

```bash
git clone https://github.com/ronisaguey-ux/tool-call-compactor.git
cd tool-call-compactor
npm install
npm link            # optional: puts `tcc` on your PATH
```

Then, in one step — detect every MCP server your harnesses already have configured, snapshot their tools, write the batches, and install itself in front of them:

```bash
tcc bootstrap --harness opencode
```

`bootstrap` backs up the harness config before touching it (`.bak-tcc`) and removes only the servers it just took over. Other harnesses:

```bash
tcc init      --harness claude-code     # just write ~/.config/tool-call-compactor/tcc.config.json
tcc install   --harness codex           # print the TOML to paste
tcc snippet   --harness cursor          # print the JSON fragment to paste
tcc harnesses                           # show every config file found on this machine
```

## How a batch works

A batch is a title, a description, and a set of tools:

```json
{
  "groups": {
    "git": {
      "title": "Git and GitHub",
      "description": "GitHub: search code and repositories, read and write files, manage issues, pull requests, reviews and branches.",
      "servers": ["github"]
    },
    "files": {
      "title": "Files",
      "description": "Read file contents with line numbers, write and replace text, find files by glob, search contents by regex.",
      "tools": ["builtin::read", "builtin::write", "builtin::edit", "builtin::glob", "builtin::grep"]
    }
  }
}
```

- `servers` claims **every** tool that server has, including ones it grows later.
- `tools` claims `server::tool` refs — used when a batch takes only part of a server.
- The batch id is the slug of its title; `see_tools_git` comes from `"title": "Git"`.
- `expose: true` opts a batch **out** of compaction — see below.

Batches are addressable by id *or* by title, so `see_tools_git`, `see_tool_git`, and `fetch_group {group: "Git and GitHub"}` all land in the same place.

### The briefing the agent gets on connect

An index is useless to an agent that does not know it is standing in front of one. Nothing about `see_tools_git` says "the other 517 tools are still here" — the honest reading of a short tool list is a short list of tools, and an agent that reads it that way will tell the user a tool does not exist rather than go looking.

So the server ships an `instructions` block, which MCP clients splice into session context at connect time. It tells the agent the tools are not in its tool list, and gives it the order to look in:

- `list_groups` — the index. Every batch with its description **and the names of the tools inside it**.
- `search_tools {query}` — substring search over all 518 hidden tools by name, description and server. The instruction is explicit that a miss here is the *only* evidence a tool is genuinely absent, so the agent searches before it reports a gap.
- `see_tools_<batch>` — the real schemas, fetched only when about to be used.

It also carries the four things agents get wrong: fetching a batch to browse it (a fetched batch is history for the rest of the session — the most expensive call available), guessing a tool name instead of searching, reading a missing index entry as a missing tool, and pre-fetching batches "to be safe".

The counts in it are computed from the live catalog, so the block reads `14 batches, not the 518 tools across 18 servers` on the machine it is running on — and the persistence paragraph changes with `options.persist`.

**The names live in the answer, not the prefix.** That is the whole reason `list_groups` exists as a tool rather than as more prose: a description has to sit in the tool list, which is the cached prefix and is paid on every request and again on every cache miss, while anything a tool *returns* is history — paid once. So each description names only the capabilities the title does not already imply, and every tool name is a call away:

```
list_groups
  14 batches, 518 tools hidden behind them. Each batch lists its tools.

  Git and GitHub [git] (26 tools): The GitHub API — not local git. Search code,
  repositories, issues and users across GitHub; read, create and update file …
        add_issue_comment, create_branch, create_issue, create_or_update_file,
        create_pull_request, create_pull_request_review, create_repository,
        fork_repository, get_file_contents, get_issue, get_pull_request, … +14 more
        — list_groups {group: "git"}
```

Fourteen names are shown per batch, with the overflow pointed at `list_groups {group: "git"}`, which prints one batch in full: every tool with a short description of it, the servers behind it, and whether it is a pass-through. An agent that is unsure where something lives can read all 518 names for a few hundred tokens and never open a batch it did not need.

`search_tools` remains the backstop for the case the index cannot cover — an agent that does not know the vocabulary a batch was described in never reads the batch, and no amount of prose fixes a guess about what someone would have called a thing.

### Let the agent write the descriptions

The agent knows what it actually needed. `describe_group` rewrites a description or retitles a batch, and the change is written to `tcc.config.json` immediately:

```
> describe_group {group: "git", description: "The GitHub API — not local git. Search code, repositories, issues and users across GitHub; read, create and update file contents; push several files as one commit; open, review and merge pull requests; manage issues, labels and branches."}
Updated "git" (Git and GitHub): The GitHub API — not local git. Search code, repositories, issues …
53 words; saved to ~/.config/tool-call-compactor/tcc.config.json
```

**Nothing is trimmed.** A description a human or the agent wrote deliberately is kept whole, however long — the index is the writer's to spend, and the server does not second-guess it. The only thing the length check does is *report*: outside 20–100 words it adds a line saying so, and nothing more. That range is where the index measures well — past ~100 words the prose stops naming capabilities an agent would not have guessed and starts restating the tool list, below ~20 it stops carrying recall. `MAX_WORDS` still exists, but only as the clamp on a *title* (a title becomes a tool name) and on descriptions the server synthesized itself, which nobody chose the length of.

Renaming writes a new `see_tools_<id>` and the server sends `notifications/tools/list_changed`.

### Nothing is left behind

`tcc batch` rebuilds the batches from the catalog while keeping every title and description you have written, and guarantees **every** tool lands in exactly one batch — anything unclaimed goes into an `other` batch rather than silently disappearing:

```bash
tcc batch      # rebuild, keeping your titles; report coverage
tcc groups     # show the index the harness will actually see
```

## Batches that stay live

Not every batch should be hidden. A batch your agent reaches for constantly — the shell, the filesystem, one small server — is worth keeping in the tool list, where it behaves like any other tool.

```bash
tcc expose shell            # this batch is advertised as real tools, always
tcc expose shell --off      # back to a see_tools_shell entry
```

```json
{ "groups": { "shell": { "title": "Shell", "description": "...", "tools": ["builtin::bash"], "expose": true } } }
```

An exposed batch is registered as `<batch>__<tool>` from the **first request of every session** — `shell__bash`, `git__create_issue` — and gets no `see_tools_` entry, because there is nothing left to fetch. That timing matters: the tool list is part of the prompt prefix, and every provider that documents caching invalidates the whole prefix when it changes ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): "Modifying tool definitions … Entire cache (tools, system, messages)"). A batch registered at boot keeps the prefix byte-identical on every request; a batch registered mid-session costs one cache rebuild when it arrives.

## Keeping a fetched batch live

The other half: a batch that starts compacted and becomes live because the session needed it.

| `options.persist` | What a fetch does |
| --- | --- |
| `auto` (default) | Registers the batch's tools for the rest of the session, while the batch stays under `persistBudget` tokens (`0` = no cap). |
| `agent` | Registers nothing until the agent asks. |
| `off` | Never. The agent fetches, then calls `call_tool`. |

In `agent` mode the agent has a tool for it:

```
> persist_group {group: "browser", persist: true}
"browser" (Browser): pinned live for this session. kept 9 tools live as browser__<tool>.
```

`persist_group` with no `persist` just asks what state a batch is in; `permanent: true` writes `expose: true` into the config so it applies to every future session; `persist: false` drops a live batch again. `see_tools_persistent_<batch>` is accepted as the same request, and `list_groups` marks what is live.

**The cost, stated plainly:** these schemas still occupy the context window once registered — caching changes what you *pay* for tokens, not whether they count ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/context-windows)). So pinning trades window for latency and cost: fewer fetch round-trips, and the schemas sit in a part of the prefix the provider caches instead of being re-sent as fresh history. Pin small, hot batches; leave the 280-tool Unreal server behind its batch.

If your harness does not refresh its tool list mid-session, a mid-session registration is visible from its next restart. `expose: true` is unaffected — it is there from the first request. See [Who already does this](#who-already-does-this-and-when-it-applies) for which harnesses refresh, and run `node scripts/verify-persist.mjs --config ~/.config/tool-call-compactor` to watch a real batch get pinned, called, and released against your own config.

## Compacting built-in tools, not just MCP

A harness's own `bash` / `read` / `write` / `edit` / `glob` / `grep` cost prefix exactly like MCP schemas do, and no proxy can remove them from the outside. What it *can* do is take their place: the compactor implements those tools itself, and the harness is told to disable its own.

```bash
tcc init --harness opencode --builtins
```

- `tcc selftest` exercises every built-in against a scratch directory and proves they work — real files, real bash, real edits, real HTTP.

**The trade, stated plainly:** a relayed tool loses whatever the harness wrapped around it — the diff view, the permission prompt, the undo entry. That is why built-ins are opt-in and land in their own batches (`Shell`, `Files`, `Web fetch`), so you can switch them on or off independently of MCP servers. Do **not** relay `task`/subagent tools or anything holding harness-internal session state; those cannot be reimplemented from outside.

## Commands

| Command | What it does |
| --- | --- |
| `tcc init` | Detect MCP servers in every harness config, snapshot their tools, write batches |
| `tcc bootstrap` | `init` + install the compactor into the harness in one step |
| `tcc install --harness NAME` | Put the compactor in a harness, removing the servers it now fronts |
| `tcc snippet --harness NAME` | Print the config fragment instead of writing it |
| `tcc scan` | Re-snapshot every server and show what the grouping would be |
| `tcc batch` | Rebuild batches, keep your titles, guarantee full coverage |
| `tcc groups` | Print the exact index the harness will be sent |
| `tcc expose <batch>` | Make a batch pass-through, or `--off` to compact it again |
| `tcc report` | What it saved, from real metrics — not a brochure number |
| `tcc serve` | Run the MCP server (harnesses run this) |
| `tcc selftest` | Prove the built-in tools work |
| `tcc harnesses` | Show which harness configs exist on this machine |

Useful flags: `--config DIR`, `--harness a,b`, `--builtins`, `--concurrency N`, `--workdir PATH`, `--days N`.

## Harness setup

The compactor is one stdio MCP server, so every harness that speaks MCP can run it. Full notes per harness in [`docs/harnesses/`](docs/harnesses/).

**opencode** (`~/.config/opencode/opencode.json`) — `tcc bootstrap --harness opencode` writes this and removes the servers it replaces:

```json
{
  "mcp": {
    "compactor": {
      "type": "local",
      "command": ["node", "/path/to/tool-call-compactor/bin/tcc.js", "serve", "--config", "/home/you/.config/tool-call-compactor"],
      "enabled": true
    }
  }
}
```

**Claude Code** — `tcc install --harness claude-code`, or:

```bash
claude mcp add compactor -- node /path/to/bin/tcc.js serve
```

**Codex** (`~/.codex/config.toml`) — `tcc install --harness codex` prints:

```toml
[mcp_servers.compactor]
command = "node"
args = ["/path/to/bin/tcc.js", "serve", "--config", "/home/you/.config/tool-call-compactor"]
```

**Hermes, Cursor, VS Code, Windsurf, Cline, Claude Desktop** — `tcc harnesses` finds whichever config files exist and `tcc install --harness <name>` writes the right shape for each.

## Configuration

`~/.config/tool-call-compactor/tcc.config.json` (or `$TCC_CONFIG_DIR`):

```json
{
  "mcp": {
    "github": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-github"], "enabled": true }
  },
  "builtins": { "enabled": false, "tools": ["bash", "read", "write", "edit", "glob", "grep", "webfetch"] },
  "groups": { "...": "..." },
  "options": {
    "idleMs": 300000,
    "timeoutMs": 60000,
    "retries": 2,
    "cacheTtlMs": 86400000,
    "persist": "auto",
    "persistBudget": 0,
    "compress": true,
    "maxText": 10000,
    "control": { "enabled": true, "host": "127.0.0.1", "port": 4750, "token": null }
  }
}
```

| Option | Meaning |
| --- | --- |
| `idleMs` | Close an upstream after this long unused. `0` keeps every server alive. |
| `timeoutMs` / `retries` | Per-call timeout and transport retries. A tool that returns an *error* is never retried — retrying would just repeat the failure. |
| `cacheTtlMs` | How long a tool snapshot is trusted before it is refreshed. |
| `persist` | What fetching a batch does to the tool list: `auto` registers it, `agent` waits to be asked, `off` never registers. |
| `persistBudget` | Token ceiling on what `auto` will register, so a 20-tool GitHub batch never undoes the saving. `0` = no cap. An explicit `persist_group` ignores it. |
| `compress` / `maxText` | Truncate oversized results, keeping the head and tail. **Errors are never compressed.** |
| `control` | Localhost HTTP port for `tcc report`-style queries against a *running* server. |

Per batch: `expose: true` makes it pass-through (see above). `dynamic` / `dynamicBudget` are the older spelling of `persist` / `persistBudget`; a config that still uses them keeps the behaviour it was written with, and `persist` wins if both appear.

Environment variables inside server definitions (`${GITHUB_TOKEN}`) are substituted at load time; unknown names are left intact so a missing variable is visible rather than silently empty.

## What it actually saves

Run `tcc report`:

```
tool-call-compactor report

Advertised index      : 20 tools, ~3,979 tokens
Hidden behind groups  : 518 tools, ~117,488 tokens
Reduction             : 96.7% of tool-schema tokens

Since 2026-09-11T04:13:47.268Z:
  group fetches       : 76 (~593,844 tokens pulled on demand)
  tool calls executed : 6
  searches            : 5
  results compressed  : 0 of 6
  result bytes        : 972 out, 972 before compression

Most-fetched groups:
  messaging        10 fetches, ~8,640 tokens
  captcha          6 fetches, ~12,504 tokens
  context          5 fetches, ~1,410 tokens
  websearch        5 fetches, ~1,055 tokens
  git              5 fetches, ~19,860 tokens
  browser          5 fetches, ~48,915 tokens
```

Those ~3,979 tokens are what the richer descriptions cost: the same index written at ~13 words per batch measured ~2,100. The extra ~1,900 tokens buy the capabilities a title cannot imply — that `git` is the GitHub API and not your local repo, that `blender` generates models from a prompt, that `computer` exposes an accessibility tree. That is a deliberate trade, and it is the one the whole design turns on: a batch nobody opens costs its description *and* the schemas it was hiding.

**Honest caveat:** with prompt caching, most providers bill a cached prefix cheaply, so the *dollar* saving is smaller than the token percentage suggests. The reliable wins are a smaller context window, more room before auto-compaction triggers, and faster first-token latency. The benefit scales with how much schema you were carrying to begin with.

## Who already does this, and when it applies

This is not a trick only a proxy can pull. Across 2026 most of the big harnesses started deferring MCP tool schemas themselves, and **where one of them already does, the MCP half of this tool is largely redundant** — worth checking before you install anything.

**These already defer it for you.** Installing the compactor here buys you the curated index, not the saving, and in some cases costs you a hop:

| Harness | Since | The knob |
| --- | --- | --- |
| **Claude Code** | On by default (auto-mode in 2.1.7) | `ENABLE_TOOL_SEARCH` = `true`, `auto`, `auto:N`, `false`; per-server `alwaysLoad` exempts a server |
| **Cursor** | Jan 2026 ("Dynamic Context Discovery"), CLI Sep 2026 | Per-server toggle and an admin tool allowlist; the policy itself is not user-configurable |
| **VS Code Copilot** | 1.118, Apr 2026 | `github.copilot.chat.virtualTools.threshold` (default 128); `tool_search` is client-side semantic search |
| **Codex CLI** | 0.142.2, default in 0.143.0 | `enabled_tools` / `disabled_tools`; needs a tool-search-capable model |
| **opencode v2** (beta) | Code Mode is the default | `mcp.servers.<name>.codemode: false` to put a server back on the native list |
| **Amp** | Jan 2026, via Agent Skills | `includeTools` in the skill's `mcp.json` |
| **Anthropic API** (direct) | — | `defer_loading: true` per tool |

**These send you everything, on every turn.** This is the case the project was built for:

| Harness | The cost |
| --- | --- |
| **opencode v1** (stable) | Every MCP schema on every request; lazy-loading requests closed "not planned" ([#7399](https://github.com/anomalyco/opencode/issues/7399)) |
| **Zed** | Source-confirmed eager loading — every enabled built-in and context-server schema each turn; open request [#63974](https://github.com/zed-industries/zed/issues/63974), Sep 2026 |
| **Gemini CLI** | No deferral — `includeTools` / `excludeTools` filter, they do not defer |
| **Windsurf** | No deferral; Cascade is capped at 100 tools |
| **Cline**, **Continue.dev**, **JetBrains** | No deferral; open requests, no cap |
| **Roo Code** | No deferral (request declined); warns above 60 MCP tools; project archived May 2026 |
| **Aider** | Not a tool-calling harness at all |

The size of the prize is not small. Anthropic's own measurements put GitHub's 35 tools at about **26k tokens** and Slack's 11 at about **21k**; Zed's feature request cites **20–60k tokens** of schema for a 30–100 tool server. Carrying that on every request is exactly what a batch index replaces.

**So when does this earn its place?**

1. **Your harness sends every schema on every request.** opencode v1, Zed, Gemini CLI, Windsurf, Cline — which is still most editors.
2. **You carry more schema than a session uses.** Eighteen servers and 518 tools is the case this was built for. Three small servers is not.
3. **You want the index itself.** Curated titles and hand-written descriptions beat search over names — deterministic, no embedding round-trip, and the agent can rewrite its own index with `describe_group`. Plus one `tcc.config.json` serving every harness on the machine, and built-in tools batched by the same mechanism.

And the honest edge: on a harness that already defers, adding a compactor can make things *worse* for the model. Its index tools get deferred too, so reaching a tool becomes search → fetch batch → call instead of search → call. On Claude Code, either turn tool search off (`ENABLE_TOOL_SEARCH=false`) if you would rather have the batch index, or leave the compactor out.

**Mid-session changes are a client question, not a protocol one.** The MCP spec says a client should re-issue `tools/list` when a server sends `notifications/tools/list_changed`. opencode does — its MCP client re-lists and republishes on the notification — and so does Zed, so a batch pinned mid-session becomes callable immediately there. Claude Code does not, and neither does Cursor: new tools stay invisible until the session restarts ([#65698](https://github.com/anthropics/claude-code/issues/65698), [#62844](https://github.com/anthropics/claude-code/issues/62844), [#60626](https://github.com/anthropics/claude-code/issues/60626)). Codex refuses for the same reason on the protocol side — the PR that would have added it was closed unmerged. Treat an unlisted harness as "probably not" and test it: `scripts/verify-persist.mjs` proves the server side, and the harness either sees the new tools or it does not. `expose: true` sidesteps the question entirely, because it is registered from the first request rather than arriving later.

## Security

- The compactor runs locally and speaks stdio to the harness. It spawns the servers you configured and nothing else.
- The control port binds `127.0.0.1` and can require a token; set `"control": {"enabled": false}` to switch it off.
- Tool schemas from upstreams are passed through, with oversized enums clamped so a hostile schema cannot itself blow the budget.
- It does not execute anything the agent did not ask for, and it does not phone home. `tcc report` reads a local JSONL file.

## Licence

MIT — see [LICENSE](LICENSE).
