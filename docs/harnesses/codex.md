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
