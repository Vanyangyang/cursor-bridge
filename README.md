# cursor-bridge

> **Compatibility:** Cursor 3.0's redesigned UI is not supported yet.

An MCP server that lets **Codex and Claude Code use Cursor agents for semantic search and bounded delegated execution**. It reuses Cursor's project index, keeps exploratory work out of the primary agent's context, and drives Cursor directly through CDP—no console injection, callback channel, or `/multitask` dependency.

## Architecture

```text
Codex / Claude Code
   |  (one logical plugin; each conversation/context may spawn its own stdio MCP adapter)
   v
cursor-bridge adapter (stdio MCP)  --IPC-->  user-level Cursor lifecycle supervisor (singleton)
                                               |
                                               +-- ensures / recovers Cursor with CDP :9223
                                               v
                                            Cursor renderer  <-- CDP Runtime.evaluate + Input -- adapters
```

- Each MCP context may start its own adapter, but all adapters share one user-level lifecycle supervisor.
- The supervisor starts and recovers Cursor with CDP `:9223`; on Windows it runs outside the Codex Job Object. Disconnecting an adapter does not close Cursor.
- GUI input is serialized. FIFO tasks use the active chat; `parallel_agent` tasks use independent top-level Agents identified by `agentId`.

> [!WARNING]
> Cursor is an agent, not a technical sandbox. Search prompts can require a concise `path:line` list and prohibit edits, but these remain prompt-level constraints. Do not treat Cursor Bridge as filesystem isolation.

## Requirements

- Cursor must be signed in, have the target project open and indexed, and run with `--remote-debugging-port=9223`.
- Node.js 18 or later.

## Installation

This repository supports Claude Code and the Codex marketplace.

### Option A: Claude Code plugin

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

Restart Claude Code or run `/reload-plugins`. The MCP server and runtime dependencies are bundled and registered automatically.

### Option B: Codex marketplace

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

Start a new Codex task or restart Codex after installation so the tools and skills enter the session.

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

Adapters ask the supervisor to ensure Cursor is ready. Set `CURSOR_BRIDGE_NO_AUTOLAUNCH=1` to disable automatic launch. Use `CURSOR_BRIDGE_INLINE_ENSURE=1` only for debugging; it bypasses the supervisor and is unsafe under Windows Job lifecycle. On Linux, set `CURSOR_EXE` when auto-detection is unavailable.

## MCP tools

| Tool | Purpose |
|---|---|
| `cursor_search` | Semantic code lookup; returns a focused `path:line` list. |
| `cursor_do` | Submit bounded FIFO or independent `parallel_agent` work. Parallel writes require non-overlapping `allowed_paths`. |
| `cursor_status` | Read-only connectivity, queue, reservation, and task snapshot. |
| `cursor_task_control` | `reap`, targeted `cancel`, or explicitly acknowledged `abandon` for one task. |
| `cursor_policy` | Inspect or set `manual`, `auto`, `active`, or `eager`. Persistent by default. |
| `cursor_launch` | Ensure Cursor is running with CDP and return lifecycle diagnostics. |

### Task flow and recovery

- Submit `cursor_do` with `background=true` and `new_chat=true`, save `task_id`, then collect with `cursor_status(task_id)`.
- `submitting`, `running`, and `collecting` are normal; longer than two minutes is not itself a failure. `cursor_status` never mutates a task.
- Use `reap` only for a bound orphan, and `cancel` only with the exact published `agentId`. Bridge never clicks a broad global Stop control.
- FIFO or unbound orphans block new delegation until the user verifies Cursor manually and explicitly accepts `abandon` risk.
- Task records are process-local. After restarting Codex/MCP, inspect Agent History and workspace changes before overlapping work.

## Choose how readily Cursor joins the work

This is a judgment setting, not a call counter.

| Mode | Choose this when | What the primary agent does |
|---|---|---|
| `manual` | Every handoff needs an explicit request. | Waits for the user. |
| `auto` | Occasional, clearly beneficial help. | Delegates only clean, easy-to-check work. |
| `active` | Regular teamwork. **Recommended.** | Usually delegates one useful bounded slice on non-trivial tasks. |
| `eager` | Frequent safe delegation and parallel work. | Uses every suitable independent slice. |

Cursor still stays out of product/architecture decisions, exclusive GUI state, unsafe scopes, and tasks the user keeps local. Final verification remains with the primary agent.

Set a persistent policy through the MCP tool and verify the returned effective policy:

```text
cursor_policy({mode: "active"})
```

Persistent is the default scope; use `scope: "session"` for a temporary override. `cursor_status` reports the effective and restart policies. A direct user opt-out always wins. Codex users can invoke `$cursor-policy` or ask in natural language; Cursor Bridge does not provide a `/cursor` command.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor remote-debugging port. |
| `CURSOR_BRIDGE_TIMEOUT` | `180000` | Per-query timeout in milliseconds. |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | unset | Set to `1` to disable automatic Cursor launch at server startup. |
| `CURSOR_BRIDGE_INLINE_ENSURE` / `CURSOR_BRIDGE_NO_SUPERVISOR` | unset | Set to `1` to bypass the singleton supervisor and ensure Cursor inside the adapter process (legacy / debug only; unsafe under Windows Job lifecycle). |
| `CURSOR_BRIDGE_LIFECYCLE_DIR` | platform user state | Override the supervisor state directory (pid/lock/boot-env). Default: `%LOCALAPPDATA%\\cursor-bridge\\lifecycle` on Windows. |
| `CURSOR_BRIDGE_SUPERVISOR_SOCK` | derived | Override the supervisor IPC endpoint (Named Pipe on Windows, Unix socket elsewhere). |
| `CURSOR_BRIDGE_DELEGATION` | `on` | Administrator-level compatibility switch. Set it to `off` only when the host must disable and hide `cursor_do` entirely; this is not a normal user policy. Other tools remain available. Restart the MCP server, Codex, or Claude Code after changing it. |
| `CURSOR_BRIDGE_POLICY` | `active` | Bootstrap user-facing mode used only when no persisted choice exists. The legacy value `on` maps to `active`; a persistent `cursor_policy` choice takes precedence on later starts. |
| `CURSOR_BRIDGE_POLICY_FILE` | platform user config | Override the durable policy file path. The default is `%APPDATA%\cursor-bridge\policy.json` on Windows and the XDG user config directory elsewhere. |
| `CURSOR_PROJECT_PATH` | auto-detected | Project root for Cursor to open and index. If unset while running from a plugin cache, the launcher omits the path and lets Cursor restore its previous workspace. |
| `CURSOR_EXE` | auto-detected | Explicit path to `Cursor.exe` when automatic detection fails. |

## Development verification

Before publishing:

```bash
node --check server.mjs
npm test
npm run build
node --check dist/cursor-bridge.mjs
node --check dist/cursor-lifecycle-supervisor.mjs
git diff --check
```

`npm run build` emits the adapter and lifecycle-supervisor bundles; plugin installs must ship both.

## Repository layout

```text
.claude-plugin/       # Claude Code manifest and marketplace
.agents/plugins/      # Codex marketplace
.codex-plugin/        # Codex plugin manifest
dist/                 # Bundled adapter and lifecycle supervisor
server.mjs            # MCP tools and scheduling
launch-cursor.mjs     # Cursor/CDP launcher
skills/               # Delegation and policy guidance
test/                 # Regression suite
```

Installed plugins execute `dist/cursor-bridge.mjs`. See [RELEASING.md](./RELEASING.md) for the release process.
