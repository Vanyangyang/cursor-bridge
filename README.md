# cursor-bridge

[English](./README.md) | [Simplified Chinese](./README.zh-CN.md)

> **Compatibility:** Cursor 3.0's redesigned UI is not supported yet.
>
> An MCP server that lets **Codex and Claude Code drive Cursor IDE agents for semantic search and bounded delegated execution**.
> It uses direct CDP control—no console injection and no WebSocket callback channel.

Cursor Bridge reuses Cursor's native project index and agent execution capabilities. It gives a primary agent semantic code location, FIFO delegation, and a pool of independent top-level Cursor Agents without relying on `/multitask`.

## Why use it?

- **Preserve the primary agent's context.** Cursor performs the exploratory search, file reading, and local reasoning in its own context, then returns a focused result such as a `path:line` list or a bounded implementation summary. The primary agent avoids carrying search noise and intermediate file contents.
- **Reuse Cursor's project understanding.** Cursor combines its project embedding index with agent-driven multi-step search and reference following. This is especially useful for intent-based lookup and cross-file understanding that keyword search alone may miss.

## Architecture

```text
Codex / Claude Code  --(MCP stdio)-->  cursor-bridge server  --(CDP :9223 Runtime.evaluate + Input)-->  Cursor renderer
```

- GUI input is serialized behind a mutex so concurrent submissions do not compete for the same input box. After `parallel_agent` submissions complete, independent top-level Cursor Agents may run concurrently and are collected by stable `agentId`.
- Cursor does not expose a dedicated pure-search API or UI. Semantic search therefore runs through `@Codebase` or agent chat: fill the query, send a real Enter key event, wait for generation, and collect the response.
- FIFO completion uses the stop-button state (`codicon-stop` and related indicators) plus response stability. `parallel_agent` collection also uses Agent History state and a stable `agentId`.

> [!WARNING]
> Cursor is an agent, not a technical sandbox. Search prompts can require a concise `path:line` list and prohibit edits, but these remain prompt-level constraints. Do not treat Cursor Bridge as filesystem isolation.

## Requirements

- Cursor must be signed in, have the target project open and indexed, and run with `--remote-debugging-port=9223`.
- Node.js 18 or later.

## Installation

This repository is a dual-format plugin repository for both Claude Code and the Codex marketplace.

### Option A: Claude Code plugin

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

Restart Claude Code, or run `/reload-plugins`, after installation. The `cursor-bridge` MCP server is registered automatically; no manual `.mcp.json` edit is required. Runtime dependencies are bundled into `dist/cursor-bridge.mjs`, so plugin users do not need to run `npm install`.

By default, Cursor indexes the MCP client's current working directory. Set `CURSOR_PROJECT_PATH` on the MCP server to select a specific project root.

### Option B: Codex marketplace

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

Codex reads `.agents/plugins/marketplace.json` and `.codex-plugin/plugin.json`, then registers `cursor_search`, `cursor_do`, `cursor_status`, `cursor_policy`, and `cursor_launch`. Start a new Codex task or restart Codex after installation so the tools and the `cursor-delegate` and `cursor-policy` skills enter the session.

### Option C: Run from source

```bash
git clone https://github.com/Vanyangyang/cursor-bridge.git
cd cursor-bridge
npm install
```

```json
{
  "mcpServers": {
    "cursor-bridge": {
      "command": "node",
      "args": ["path/to/cursor-bridge/server.mjs"]
    }
  }
}
```

At startup, the server automatically ensures that Cursor is running with CDP enabled. Set `CURSOR_BRIDGE_NO_AUTOLAUNCH=1` to disable automatic launch.

> [!NOTE]
> Automatic Cursor launch currently supports Windows only. It uses `tasklist` and the default `Cursor.exe` installation paths; set `CURSOR_EXE` to override detection. On macOS or Linux, start Cursor manually with `--remote-debugging-port=9223 --remote-allow-origins=http://localhost:9223` before calling `cursor_search`.

## MCP tools

| Tool | Purpose |
|---|---|
| `cursor_search` | Ask a Cursor agent to locate code by natural-language intent and return a focused `path:line` list. Calls are serialized and typically take about 90 seconds, with observed runs varying from roughly 66 to 175 seconds. |
| `cursor_do` | Delegate a bounded task. Use `execution=fifo` for compatible serial execution or `execution=parallel_agent` for an independent top-level Agent. Set `read_only=true` for parallel read-only work. Parallel write tasks require pairwise non-overlapping `allowed_paths`. The tool is hidden when `CURSOR_BRIDGE_DELEGATION=off`. |
| `cursor_status` | Inspect CDP connectivity, FIFO work, and active parallel Agents. Pass `task_id` to retrieve the exact task state and raw response. It also reports the effective delegation policy. |
| `cursor_policy` | Set or inspect how readily the primary agent hands work to Cursor. The public choices are `manual`, `auto`, `active`, and `eager`; the result reports the effective choice for the current session. |
| `cursor_launch` | Ensure Cursor is running with a CDP debugging port. It returns `already`, `launched`, `running-no-debug`, `port-not-cursor`, `no-exe`, or `timeout`. |

Use `cursor_do` with `background=true` and `new_chat=true` by default. Save its `task_id`, then collect it with `cursor_status(task_id)`. `submitting`, `running`, and `collecting` are normal in-progress states; exceeding two minutes is not itself a failure. Cursor Bridge does not require a unique completion marker or a minimum response length.

## Choose how readily Cursor joins the work

This setting is about judgment, not a counter. Cursor Bridge does not call Cursor every N tool uses. The primary agent looks at the actual task and decides whether a handoff will save time or catch omissions.

| Mode | Choose this when | What the primary agent does |
|---|---|---|
| `manual` | You want full control over every handoff. | Uses Cursor only after you explicitly ask for it. |
| `auto` | You want occasional help without many background tasks. | Hands off work only when the scope is clean, the result is easy to check, and the likely benefit clearly outweighs dispatch and review time. |
| `active` | You want Cursor to be a regular implementation partner. **Recommended for most users.** | For a non-trivial task, normally looks for one useful bounded slice—such as local implementation, tests, documentation, configuration, or a second check—to send to Cursor while the primary agent continues other work. |
| `eager` | You have enough independent work to benefit from frequent delegation or parallel Agents. | Uses Cursor whenever a safe bounded slice exists, including small read-only probes and independent mechanical work, and parallelizes tasks whose write paths do not overlap. |

Cursor is a good fit when a task has a clear goal, a limited path or subsystem, and a result the primary agent can verify with a diff, test, count, or concrete document check. It is especially useful for repetitive edits, local implementation discovery, tests, documentation, configuration, and independent second passes.

Cursor stays out when:

- you say not to use it;
- the task is a tiny edit that is faster to complete directly;
- the unresolved question is product direction, architecture, creative intent, or another decision the primary agent must own;
- the task depends on exclusive GUI state or shared mutable runtime state;
- there is no clean scope, no safe path boundary, or no practical way to verify the returned work.

Changing modes never weakens those boundaries or transfers final verification to Cursor.

Set a session policy through the MCP tool and verify the returned effective policy:

```text
cursor_policy({mode: "active"})
```

`cursor_status` echoes the effective mode so later handoff decisions stay consistent. A direct “do not use Cursor” request always wins over the selected mode.

Codex users may invoke `$cursor-policy` or ask the primary agent in natural language to inspect or change the mode. Cursor Bridge does not claim a built-in `/cursor` command: the Codex plugin manifest has no custom slash-command surface, and other hosts may differ. Use the skill, the MCP tool, or ordinary natural-language instructions unless the current host explicitly exposes a verified wrapper.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor remote-debugging port. |
| `CURSOR_BRIDGE_TIMEOUT` | `180000` | Per-query timeout in milliseconds. |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | unset | Set to `1` to disable automatic Cursor launch at server startup. |
| `CURSOR_BRIDGE_DELEGATION` | `on` | Administrator-level compatibility switch. Set it to `off` only when the host must disable and hide `cursor_do` entirely; this is not a normal user policy. Other tools remain available. Restart the MCP server, Codex, or Claude Code after changing it. |
| `CURSOR_BRIDGE_POLICY` | `active` | Initial user-facing mode: `manual`, `auto`, `active`, or `eager`. The legacy value `on` maps to `active`; `cursor_policy` may change the in-memory mode for the current session. |
| `CURSOR_PROJECT_PATH` | auto-detected | Project root for Cursor to open and index. If unset while running from a plugin cache, the launcher omits the path and lets Cursor restore its previous workspace. |
| `CURSOR_EXE` | auto-detected | Explicit path to `Cursor.exe` when automatic detection fails. |

Administrators can temporarily disable delegated execution for a Codex launch in PowerShell:

```powershell
$env:CURSOR_BRIDGE_DELEGATION='off'
codex
```

When delegation is disabled, the `cursor-delegate` skill must complete work in the primary agent and must not attempt to bypass or re-enable delegation. Remove the variable or set it to `on`, then restart the client to restore the tool.

## Recommended usage

- Use `cursor_search` for intent-based semantic lookup and cross-file understanding that benefits from Cursor's project index.
- Treat Cursor as an execution partner. Keep product direction, scope decisions, architectural boundaries, and final verification with the primary agent.
- Use `parallel_agent` only for independent tasks with non-overlapping write paths; use `fifo` otherwise.
- Always collect by `task_id`. Parallel tasks also bind to an Agents Window identity such as `local:<UUID>`; do not infer task identity from the currently visible chat.
- Allow Cursor to perform limited local investigation inside a clearly defined task envelope. The primary agent does not need to pre-solve every implementation detail before delegating.

## Repository layout

```text
.claude-plugin/
  plugin.json          # Claude Code plugin manifest
  marketplace.json     # Repository-local Claude Code marketplace
.agents/plugins/
  marketplace.json     # Codex marketplace entry
.codex-plugin/
  plugin.json          # Codex plugin manifest and MCP configuration
.mcp.json              # MCP server declaration pointing to dist/cursor-bridge.mjs
dist/cursor-bridge.mjs # Bundled single-file runtime used by installed plugins
server.mjs             # MCP server source: CDP control and tool definitions
launch-cursor.mjs      # Cursor/CDP launcher
build.mjs              # esbuild entry (`npm run build` rebuilds dist/)
skills/cursor-delegate/ # Delegation, task envelopes, collection, and review rules
skills/cursor-policy/   # Session policy inspection and switching workflow
test/                  # node:test coverage for scheduling, path conflicts, and Agent identity
probe-*.mjs            # CDP integration probes
agents-autopilot.mjs / autopilot-switch.py  # Autopilot helpers
test-*.mjs             # Search and batch smoke tests
```

Installed plugins execute `dist/cursor-bridge.mjs`, which bundles `@modelcontextprotocol/sdk` and `ws`. After changing `server.mjs` or `launch-cursor.mjs`, run `npm install && npm run build` to regenerate the bundle. See [RELEASING.md](./RELEASING.md) for the release process.
