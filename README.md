# cursor-bridge

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/stargazers)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

An MCP server that lets **Codex and Claude Code use Cursor as a verifiable Cursor Context Engine (CCE) and bounded execution worker**. It reuses Cursor's project index and Agent UI, keeps repository exploration in Cursor's context, and drives the real Cursor application through CDP—without console injection, callback services, or a `/multitask` dependency.

> **Compatibility:** Supports both the legacy Cursor workbench and Cursor Agents v2 UI. Cursor 3.7.42 on Windows is part of the live-verified compatibility set. Future Cursor UI changes may require adapter updates.

## Architecture

```text
Codex / Claude Code
        │ MCP
        ▼
Cursor Bridge adapter(s)
        │ singleton IPC
        ▼
Shared lifecycle supervisor
        │ ensure / CDP :9223
        ▼
Cursor Agent + project index
```

- Each MCP context may start an adapter; all adapters share one user-level supervisor.
- FIFO tasks use the active chat and are serialized through a UI lock.
- `parallel_agent` tasks use independent top-level Cursor Agents.
- On Windows, the supervisor runs outside the Codex Job lifecycle, so closing one session does not terminate Cursor.

## Cursor Context Engine

Cursor Bridge exposes two read-only CCE search depths. Both return compact, workspace-relative source evidence for the primary agent to verify.

### `cursor_search`: balanced locator

Use `cursor_search` for natural-language concepts, behavior ownership, unknown naming, and other intent-to-code location tasks. It combines:

- Cursor indexed semantic retrieval
- exact text search
- symbol and reference tracing
- a small amount of targeted source inspection

It intentionally avoids broad repository traversal. If a query requires multi-hop, data-flow, or cross-module proof, `gaps` reports `deep_search_recommended: <reason>` instead of silently widening the investigation.

### `cursor_search_deep`: repository investigation

Use `cursor_search_deep` when the question already requires verified relationships across files or subsystems, such as:

- route → service → storage
- producer → queue → consumer
- config → registration → implementation
- interface → concrete implementations
- cross-module ownership or data flow
- implementation context spanning multiple subsystems

Deep search stops after collecting the minimum sufficient code context. It does not produce an implementation plan or large code blocks.

### Search routing

| Query shape | Use |
|---|---|
| Known literal, filename, or exact symbol | Caller-side Grep / `rg` |
| Concept, behavior owner, unknown naming | `cursor_search` |
| Call chain, data flow, cross-module/subsystem relationship | `cursor_search_deep` |
| Balanced result reports `deep_search_recommended` | Escalate that query to `cursor_search_deep` |

Do not run balanced search and deep search by default. Choose the depth that matches the question.

### Result contract

```text
CCE_SEARCH_RESULT
intent: <normalized intent>
evidence:
- path/to/file.ts:42-67 | symbolOrAnchor | verified relevance or relationship | reference
gaps: none
confidence: high
```

- Results are ordered by evidence strength.
- Semantic similarity is not presented as a proven call edge.
- Missing evidence returns `NOT_FOUND` plus the terms, symbols, references, or scope actually searched.
- Result normalization removes conversational preambles without inventing evidence.

> [!WARNING]
> Cursor is an agent, not a technical sandbox. Search prompts strongly require read-only behavior, but this is not filesystem isolation. Verify returned anchors in the real working tree.

## Requirements

- Node.js 18 or later.
- Cursor signed in with the target project open and indexed.
- Cursor running with `--remote-debugging-port=9223`; Bridge can manage this lifecycle automatically on supported setups.
- Windows for actual top-level window suppression. Other platforms persist runtime mode but report window control as unsupported.

## Installation

### Codex

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

Restart Codex and start a new task so the MCP tools and skills enter the session.

### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

Restart Claude Code or run `/reload-plugins`.

<details>
<summary><strong>Run from source</strong></summary>

```bash
git clone https://github.com/Vanyangyang/cursor-bridge.git
cd cursor-bridge
npm install
npm run build
```

```json
{
  "mcpServers": {
    "cursor-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/cursor-bridge/server.mjs"]
    }
  }
}
```

Set `CURSOR_BRIDGE_NO_AUTOLAUNCH=1` to disable automatic launch. On Linux, set `CURSOR_EXE` when automatic detection is unavailable.

</details>

## MCP tools

| Tool | Purpose |
|---|---|
| `cursor_search` | Balanced read-only CCE location with compact `path:line` evidence. |
| `cursor_search_deep` | Deep read-only repository investigation for verified cross-file relationships. |
| `cursor_do` | Submit bounded FIFO or independent `parallel_agent` work. |
| `cursor_status` | Read-only connectivity, queue, reservation, runtime, and task snapshot. |
| `cursor_task_control` | `reap`, targeted `cancel`, or explicitly acknowledged `abandon` for one task. |
| `cursor_policy` | Inspect or set `manual`, `auto`, `active`, or `eager`. |
| `cursor_runtime` | Inspect or set `normal` / `minimal` Cursor presentation. |
| `cursor_launch` | Ensure Cursor is running with CDP and return lifecycle diagnostics. |

## Minimal runtime

```text
cursor_runtime({mode: "minimal"})
```

Minimal mode persists and defers Cursor startup until the first `cursor_search`, `cursor_search_deep`, or `cursor_do`. On Windows, Bridge hides top-level Cursor windows while retaining the real Cursor process, project index, Agent DOM, and task queue. This is a **UI-suppressed runtime**, not a headless reimplementation.

- `cursor_runtime({action: "show"})` temporarily reveals Cursor for login, upgrades, or diagnostics.
- `cursor_runtime({action: "hide"})` hides it again without changing the stored mode.
- `cursor_runtime({mode: "normal"})` restores ordinary visible behavior.

## Task execution and recovery

- Submit `cursor_do` with `background=true`, retain the returned `task_id`, then collect with `cursor_status(task_id)`.
- Parallel write tasks require non-overlapping `allowed_paths`; read-only tasks use `read_only=true`.
- `submitting`, `running`, and `collecting` are normal non-terminal states. `cursor_status` never mutates a task.
- A newly observed `LLM provider error` tray is a terminal failure. Bridge records its message and Request ID and never clicks retry automatically.
- A timeout means Bridge could not confirm both a complete assistant reply and the end of generation. It does not prove the underlying Agent stopped.
- Partial Markdown while Stop remains active is not accepted as success.
- Post-send uncertainty retains an Agent or global reservation; Bridge does not silently release, resubmit, or click a broad global Stop control.
- Use `reap` only for a bound orphan and targeted `cancel` only with the exact published `agentId`.
- FIFO or unbound orphans block new delegation until the user verifies Cursor state and explicitly accepts `abandon` risk.
- Task records are process-local. After an MCP restart, inspect Agent History and workspace changes before overlapping work.

## Cursor participation policy

`cursor_policy` is a judgment setting, not a call counter or hard scheduler.

| Mode | Behavior |
|---|---|
| `manual` | Wait for an explicit user request. |
| `auto` | Use Cursor selectively when the benefit is clear. |
| `active` | Treat Cursor as a regular bounded teammate. Recommended default. |
| `eager` | Use every safe, independent opportunity. |

Product decisions, overlapping writes, exclusive GUI state, and final verification remain with the primary agent.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor remote-debugging port. |
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | Search completion timeout in milliseconds. |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | unset | Set to `1` to disable automatic launch in normal mode. |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | Bootstrap runtime mode when no persisted choice exists. |
| `CURSOR_BRIDGE_RUNTIME_FILE` | user config directory | Override the persistent runtime-mode file. |
| `CURSOR_BRIDGE_POLICY` | `active` | Bootstrap participation policy when no persisted choice exists. |
| `CURSOR_BRIDGE_POLICY_FILE` | user config directory | Override the persistent policy file. |
| `CURSOR_BRIDGE_DELEGATION` | `on` | Set to `off` to disable and hide `cursor_do`. |
| `CURSOR_PROJECT_PATH` | auto-detected | Project Cursor should open and index. |
| `CURSOR_EXE` | auto-detected | Explicit Cursor executable path. |

Advanced lifecycle overrides are intended for compatibility diagnostics. Bypassing the singleton supervisor on Windows is not recommended.

## Development

```bash
npm install
npm run build
npm test
```

Installed plugins execute `dist/cursor-bridge.mjs`. Always rebuild and commit the bundle after changing runtime source. See [RELEASING.md](./RELEASING.md) for the dual-marketplace release process and [CHANGELOG.md](./CHANGELOG.md) for release history.

For Cursor UI compatibility issues, include the Cursor version, operating system, target UI flavor, and sanitized lifecycle/task evidence.

## License

[MIT](./LICENSE)

## Star History

<a href="https://www.star-history.com/#Vanyangyang/cursor-bridge&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Vanyangyang/cursor-bridge&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Vanyangyang/cursor-bridge&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Vanyangyang/cursor-bridge&type=Date" />
  </picture>
</a>
