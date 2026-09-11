# Hermes

Hermes is a stdio MCP client, so the compactor is a normal MCP server to it. There is no single canonical config path across Hermes builds, so `tcc harnesses` probes the common ones and reports which it found:

```
~/.config/hermes/mcp.json
~/.hermes/mcp.json
~/.config/hermes/config.json
```

with `mcpServers`, `mcp`, and `servers` all accepted as the key. If your build keeps its servers somewhere else, point the compactor at the file directly:

```bash
TCC_HERMES_CONFIG=/path/to/your/config.json tcc harnesses
```

or skip detection entirely and copy the entry in yourself:

```json
{
  "mcpServers": {
    "compactor": {
      "command": "node",
      "args": [
        "/path/to/tool-call-compactor/bin/tcc.js",
        "serve",
        "--config",
        "/home/you/.config/tool-call-compactor"
      ]
    }
  }
}
```

Anything that launches an MCP server over stdio works — the command is the whole contract:

```bash
node /path/to/tool-call-compactor/bin/tcc.js serve --config /home/you/.config/tool-call-compactor
```

## Verifying

```bash
node scripts/verify-live.mjs --config ~/.config/tool-call-compactor
```

That runs the compactor as its own process and checks the parts Hermes will rely on: a compact index, openable batches, full schemas, a real tool call, and search over hidden tools.

## One thing to check on your build

Whether a batch registered *mid-session* becomes callable depends entirely on whether your Hermes build re-reads `tools/list` when a server sends `notifications/tools/list_changed`. opencode does; Claude Code, Codex and Cursor do not. If yours does not, the compactor's index still saves the prefix, and anything you want permanently live should be marked `expose: true` in the config instead of pinned at runtime — `expose` is registered from the first request, so no refresh is needed.
