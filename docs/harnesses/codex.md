# Codex

Codex keeps MCP servers in `~/.codex/config.toml` under `[mcp_servers.<name>]`. `tcc install --harness codex` prints the block rather than rewriting your TOML:

```toml
[mcp_servers.compactor]
command = "node"
args = ["/path/to/tool-call-compactor/bin/tcc.js", "serve", "--config", "/home/you/.config/tool-call-compactor"]
```

`tcc init --harness codex` reads the same file to discover your existing servers. It parses the subset of TOML an MCP config actually uses — `[tables]` and `[tables.sub]`, quoted strings, numbers, booleans, string arrays, and inline tables. If your config uses anything outside that, run `tcc harnesses` and check the server count it reports before trusting it.

## Verifying

```bash
node scripts/verify-live.mjs --config ~/.config/tool-call-compactor
```

Codex's own tools (`shell`, `read_file`, `write_file`, `apply_patch`, `list_files`, `search`) are built in and cannot be removed from outside. To batch them, switch them off and relay the compactor's equivalents — see the built-ins section of the main README. Be aware that `apply_patch` is a patch format, not a string replace, so relaying it changes how edits are expressed.

## Two things to know before installing

**Codex already defers MCP tools.** Since 0.142.2 it exposes names and short descriptions up front and resolves schemas on demand through tool search, injecting the discovered schema at the *end* of the context so the prefix survives. That is the same saving this project makes, so on a tool-search-capable model the compactor buys you little for MCP servers — and it can cost you a hop, because Codex defers the compactor's own index tools as well.

**Codex will not notice a mid-session change.** The client does not re-read `tools/list` on `notifications/tools/list_changed` (the PR adding it was closed unmerged), so anything the compactor registers mid-session is invisible until Codex restarts. `expose: true` is unaffected — those tools are advertised from the first request.
