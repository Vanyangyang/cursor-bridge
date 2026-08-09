# cursor-bridge

[![Version](https://img.shields.io/github/package-json/v/Vanyangyang/cursor-bridge?style=flat-square&logo=github&label=version)](https://github.com/Vanyangyang/cursor-bridge/tags)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square&logo=opensourceinitiative&logoColor=white)](./LICENSE)

An MCP server that lets **Codex and Claude Code use Cursor as a verifiable Cursor Context Engine (CCE) and bounded execution worker**. It reuses Cursor's project index, keeps most exploratory work in Cursor's context, and drives Cursor directly through CDP—no console injection, callback channel, or `/multitask` dependency.

> **Compatibility:** Supports both the legacy workbench and the redesigned Cursor Agents UI (live-verified with Cursor 3.7.42 on Windows). When CDP exposes both, the bridge selects the most capable target and pins each submitted task to that editor window.

## Architecture

```text
Codex / Claude Code -> CCE MCP adapter(s) -> shared lifecycle supervisor -> Cursor Agent / Index (CDP :9223)
```

- Each MCP context may start an adapter, but all adapters share one user-level supervisor. On Windows, it runs outside the Codex Job lifecycle, so closing a session does not close Cursor.
- GUI input is serialized: FIFO uses the active chat; `parallel_agent` uses independent top-level Agents.

## Cursor Context Engine: evidence, not guessed paths

`cursor_search` is not an expensive rename for `grep`, and it does not promise mystical “zero hallucination.” It asks Cursor Agent to work inside its indexed workspace, combine semantic retrieval, exact text search, symbol/reference tracing, and enough source inspection to confirm a location, then return evidence anchors the primary agent can open and verify.

| What CCE does | What CCE does not claim |
|---|---|
| Starts from intent such as behavior ownership or cross-module data flow. | It does not guess directories from framework convention. |
| Returns workspace-relative `path:start-end`, a symbol/anchor, relevance, and match type. | Semantic similarity is not presented as a proven call edge. |
| Returns `NOT_FOUND` with searched terms, symbols, or scope when evidence is missing. | “Not found” is not presented as proof that code does not exist. |
| Keeps most exploration in Cursor context, then hands verification anchors back. | It does not claim zero primary-context cost or replace source verification. |

Prefer local `rg` for an obvious literal or known symbol. CCE is strongest for concepts, unknown naming, cross-file ownership, and multi-hop relationships. Read-only search is a strong behavioral contract, not a filesystem sandbox.

> [!WARNING]
> Cursor is an agent, not a technical sandbox. Search prompts can require a concise `path:line` list and prohibit edits, but these remain prompt-level constraints. Do not treat Cursor Bridge as filesystem isolation.

## Requirements

- Cursor must be signed in, have the target project open and indexed, and run with `--remote-debugging-port=9223`.
- Node.js 18 or later.

## Installation

This repository supports Claude Code and the Codex marketplace.

### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

Restart Claude Code or run `/reload-plugins`. The MCP server and runtime dependencies are bundled and registered automatically.

### Codex

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

Start a new Codex task or restart Codex after installation so the tools and skills enter the session.

<details>
<summary><strong>Run from source</strong></summary>

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

Adapters ask the supervisor to ensure Cursor is ready. Set `CURSOR_BRIDGE_NO_AUTOLAUNCH=1` to disable automatic launch. On Linux, set `CURSOR_EXE` when auto-detection is unavailable.

</details>

## MCP tools

| Tool | Purpose |
|---|---|
| `cursor_search` | Semantic code lookup; returns a focused `path:line` list. |
| `cursor_do` | Submit bounded FIFO or independent `parallel_agent` work. Parallel writes require non-overlapping `allowed_paths`. |
| `cursor_status` | Read-only connectivity, queue, reservation, and task snapshot. |
| `cursor_task_control` | `reap`, targeted `cancel`, or explicitly acknowledged `abandon` for one task. |
| `cursor_policy` | Inspect or set `manual`, `auto`, `active`, or `eager`. Persistent by default. |
| `cursor_runtime` | Inspect or set `normal` / `minimal`; minimal keeps CCE available while hiding the Windows Cursor UI. |
| `cursor_launch` | Ensure Cursor is running with CDP and return lifecycle diagnostics. |

### Task flow and recovery

- Submit `cursor_do` with `background=true` and `new_chat=true`, save `task_id`, then collect with `cursor_status(task_id)`.
- `submitting`, `running`, and `collecting` are normal; longer than two minutes is not itself a failure. `cursor_status` never mutates a task.
- A newly displayed `LLM provider error` tray is a confirmed failed terminal state. Bridge records its message and Request ID, releases the reservation, and never clicks `Try again` or dismisses the tray automatically.
- Use `reap` only for a bound orphan, and `cancel` only with the exact published `agentId`. Bridge never clicks a broad global Stop control.
- FIFO or unbound orphans block new delegation until the user verifies Cursor manually and explicitly accepts `abandon` risk.
- Task records are process-local. After restarting Codex/MCP, inspect Agent History and workspace changes before overlapping work.

### Minimal runtime

```text
cursor_runtime({mode: "minimal"})
```

Minimal mode persists and defers Cursor startup until the first `cursor_search` or `cursor_do`. On Windows, Bridge hides the top-level Cursor windows serving CDP while retaining the real Cursor process, project index, Agent DOM, and task queue. This is a **UI-suppressed runtime**, not a headless reimplementation.

- `cursor_runtime({action: "show"})` temporarily reveals Cursor for login, upgrades, or manual diagnostics without changing the stored mode.
- `cursor_runtime({action: "hide"})` hides it again immediately.
- `cursor_runtime({mode: "normal"})` restores ordinary visible behavior.
- Other platforms currently persist the mode and report that window control is unsupported; they do not pretend the UI was hidden.

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
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | Per-query timeout in milliseconds. |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | unset | Set to `1` to disable automatic Cursor launch at server startup. |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | Bootstrap runtime when no persisted choice exists: `normal` or `minimal`. |
| `CURSOR_BRIDGE_RUNTIME_FILE` | platform user config | Override the persistent normal/minimal runtime file. |
| `CURSOR_BRIDGE_POLICY` | `active` | Bootstrap user-facing mode used only when no persisted choice exists. The legacy value `on` maps to `active`; a persistent `cursor_policy` choice takes precedence on later starts. |
| `CURSOR_PROJECT_PATH` | auto-detected | Project root for Cursor to open and index. |
| `CURSOR_EXE` | auto-detected | Explicit path to `Cursor.exe` when automatic detection fails. |

<details>
<summary><strong>Advanced and troubleshooting variables</strong></summary>

| Variable | Default | Description |
|---|---|---|
| `CURSOR_BRIDGE_INLINE_ENSURE` / `CURSOR_BRIDGE_NO_SUPERVISOR` | unset | Bypass the singleton supervisor (legacy/debug only; unsafe under Windows Job lifecycle). |
| `CURSOR_BRIDGE_LIFECYCLE_DIR` | platform user state | Override the supervisor state directory. Windows default: `%LOCALAPPDATA%\\cursor-bridge\\lifecycle`. |
| `CURSOR_BRIDGE_SUPERVISOR_SOCK` | derived | Override the supervisor IPC endpoint. |
| `CURSOR_BRIDGE_DELEGATION` | `on` | Administrator switch that disables and hides `cursor_do` when set to `off`; restart the MCP server or client after changing it. |
| `CURSOR_BRIDGE_POLICY_FILE` | platform user config | Override the durable policy file path. |

</details>

## Development

Run `npm test` and `npm run build` before submitting changes. See [RELEASING.md](./RELEASING.md) for the release checklist.
