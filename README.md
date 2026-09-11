# Tool Call Compactor

**Your agent pays for every tool schema on every request. This makes it pay for thirty words instead, and fetch the schemas only when it needs them.**

Every MCP server you connect, and every built-in tool your harness ships, contributes its full JSON Schema to the prompt — on *every single turn*. Fifty tools is easily 30–60k tokens of schemas sitting in front of the conversation, permanently. It cannot be compacted away, because it is not history: it is the static prefix.

Tool Call Compactor puts a small MCP server in front of all of it. The harness sees a handful of tiny tools plus one entry per **batch**:

```
list_groups, search_tools, call_tool, describe_group, fetch_group,
see_tools_shell, see_tools_files, see_tools_browser, see_tools_git, ...
```

Each batch carries a **title** and a thirty-word **description** that you (or your agent) write. When the agent needs something in that batch, it calls `see_tools_<batch>` and gets exactly those schemas — once — then calls `call_tool`.

Measured on a real machine with 18 MCP servers attached:

```
Before:  518 tools · 489,905 bytes · ~122,000 tokens of schema on every request
After:    19 tools ·   8,522 bytes ·   ~2,100 tokens, plus a batch only when you open one
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

Batches are addressable by id *or* by title, so `see_tools_git`, `see_tool_git`, and `fetch_group {group: "Git and GitHub"}` all land in the same place.

### Let the agent write the descriptions

The agent knows what it actually needed. `describe_group` rewrites a description (hard-capped at thirty words) or retitles a batch, and the change is written to `tcc.config.json` immediately:

```
> describe_group {group: "git", description: "Everything GitHub — code search, issues, PRs, reviews, releases."}
Updated "git" (Git and GitHub): Everything GitHub — code search, issues, PRs, reviews, releases.
30 of 30 words; saved to ~/.config/tool-call-compactor/tcc.config.json
```

Renaming writes a new `see_tools_<id>` and the server sends `notifications/tools/list_changed`.

### Nothing is left behind

`tcc batch` rebuilds the batches from the catalog while keeping every title and description you have written, and guarantees **every** tool lands in exactly one batch — anything unclaimed goes into an `other` batch rather than silently disappearing:

```bash
tcc batch      # rebuild, keeping your titles; report coverage
tcc groups     # show the index the harness will actually see
```

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
    "dynamic": true,
    "dynamicBudget": 4000,
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
| `dynamic` | `true` (default) registers a fetched batch's real tools when they are cheap; `"always"` ignores the budget; `false` disables it. |
| `dynamicBudget` | Token ceiling for the default policy. A 20-tool GitHub batch is never registered, so the saving survives; a 1-tool batch is. |
| `compress` / `maxText` | Truncate oversized results, keeping the head and tail. **Errors are never compressed.** |
| `control` | Localhost HTTP port for `tcc report`-style queries against a *running* server. |

Environment variables inside server definitions (`${GITHUB_TOKEN}`) are substituted at load time; unknown names are left intact so a missing variable is visible rather than silently empty.

## What it actually saves

Run `tcc report`:

```
tool-call-compactor report

Advertised index      : 19 tools, ~2,131 tokens
Hidden behind groups  : 518 tools, ~122,476 tokens
Reduction             : 98.3% of tool-schema tokens

Since 2026-09-11T02:14:07.221Z:
  group fetches       : 7 (~23,140 tokens pulled on demand)
  tool calls executed : 41
  results compressed  : 12 of 41
  result bytes        : 184,220 out, 902,441 before compression
```

**Honest caveat:** with prompt caching, most providers bill a cached prefix cheaply, so the *dollar* saving is smaller than the token percentage suggests. The reliable wins are a smaller context window, more room before auto-compaction triggers, and faster first-token latency. The benefit scales with how much schema you were carrying to begin with.



## Security

- The compactor runs locally and speaks stdio to the harness. It spawns the servers you configured and nothing else.
- The control port binds `127.0.0.1` and can require a token; set `"control": {"enabled": false}` to switch it off.
- Tool schemas from upstreams are passed through, with oversized enums clamped so a hostile schema cannot itself blow the budget.
- It does not execute anything the agent did not ask for, and it does not phone home. `tcc report` reads a local JSONL file.

## Licence

MIT — see [LICENSE](LICENSE).
