# Claude Code

## Install

```bash
tcc install --harness claude-code
```

or directly:

```bash
claude mcp add compactor -- node /path/to/tool-call-compactor/bin/tcc.js serve --config /home/you/.config/tool-call-compactor
```

Claude Code stores MCP servers in `~/.claude.json` under `mcpServers` (and per-project under `projects.<path>.mcpServers`). `tcc install` writes the top-level one and backs the file up first.

## Relationship to Claude Code's own Tool Search

Claude Code already ships this idea natively: MCP tools can be deferred and discovered with a `ToolSearch` call instead of being loaded up front. If that covers your case, use it — it is first-party and needs no proxy.

The compactor is worth adding on top when you want:

- **Batches with your own titles and thirty-word descriptions**, rather than search over names and descriptions. Deterministic, no embedding round-trip, and the agent can rewrite the index itself with `describe_group`.
- **One configuration across every harness on the machine.** The same `tcc.config.json` serves Claude Code, opencode, Codex and anything else that speaks MCP, and `tcc init` reads all of their configs at once.
- **Built-in tools batched too**, when you also switch off the harness's own copies.

## Verifying

```bash
claude mcp list                      # compactor should be listed as connected
node scripts/verify-live.mjs --config ~/.config/tool-call-compactor
```

Then, in a session, the first turn's usage is the number that matters — that is the prefix including every tool schema.

## Notes

- Claude Code's built-ins are named `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`. Relay them only if you accept losing Claude Code's own permission prompts and diff UI for those operations — see the built-ins section of the main README.
- The compactor declares `tools.listChanged`, so batches fetched mid-session can register their real tools immediately when they are small enough to be worth it.
