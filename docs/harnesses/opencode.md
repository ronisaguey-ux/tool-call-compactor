# opencode

## Install

```bash
tcc bootstrap --harness opencode
```

This detects every server in `~/.config/opencode/opencode.json`, snapshots their tools, writes the batches, backs the config up to `opencode.json.bak-tcc`, removes the servers it just took over, and adds one entry:

```json
{
  "mcp": {
    "compactor": {
      "type": "local",
      "command": [
        "node",
        "/path/to/tool-call-compactor/bin/tcc.js",
        "serve",
        "--config",
        "/home/you/.config/tool-call-compactor"
      ],
      "enabled": true
    }
  }
}
```

If you would rather edit the file yourself, `tcc snippet --harness opencode` prints exactly that fragment.

## Restart is required

opencode reads its config **at serve boot**. Editing `opencode.json` does nothing until:

```bash
systemctl --user restart opencode-serve.service
```

The same applies to plugins and to the agent prompt. If a change looks inert, this is why.

## Bringing back servers you switched off

Servers parked with `"enabled": false` are usually the expensive ones — a big engine or design server whose schemas were not worth carrying. That is precisely what a compactor can afford. Pick them up with:

```bash
tcc init --harness opencode --include-disabled
```

They become lazy upstreams: nothing is spawned until a batch containing them is fetched.

## Verifying it worked

```bash
# 1. every batch opens and the index is small
node scripts/verify-live.mjs --config ~/.config/tool-call-compactor

# 2. opencode itself sees the compactor
curl -s http://127.0.0.1:4096/mcp | python3 -m json.tool
```

Then measure the static prefix the model actually receives. `POST /session`, send one message, and read `tokens.input + tokens.cache.read` off the reply — that number is the system prompt plus every tool schema, and it is re-sent on every request:

```
POST /session                       → { id }
POST /session/{id}/message
  { "agent": "build",
    "model": { "providerID": "deepseek", "modelID": "deepseek-flash" },
    "parts": [{ "type": "text", "text": "Reply with the single word: ok" }] }
DELETE /session/{id}
```

The first assistant message's `tokens.input + tokens.cache.read` is the prefix. Compare before and after.

## Things that bite

- **The prefix, not the history.** Compaction can only summarise history; the tool schemas sit in front of it. A prefix that fills the window makes an auto-compacting session compact forever without ever making progress.
- **Key order varies.** In some entries `enabled` is the last key. A regex that assumes `"enabled": true` follows the server name silently matches nothing — this tool parses the JSON instead.
- **`bytes / 4` over-counts** dense JSON schemas by roughly 10%. Treat it as an estimate; `tcc report` uses the same measure in both directions, so the comparison holds even if the absolute number is off.
- **Built-ins are separate.** `tools` like `bash`, `read`, `write`, `edit`, `glob`, `grep` come from opencode itself and cannot be removed from outside. To batch those too, see the built-ins section of the main README — it means disabling opencode's copies, which also loses opencode's diff view for edits made through the relay.
