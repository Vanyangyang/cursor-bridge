# cursor-bridge

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/stargazers)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

An MCP server that lets **Codex and Claude Code use Cursor as a verifiable Cursor Context Engine (CCE) and bounded execution worker**. It reuses Cursor's project index and Agent UI, keeps repository exploration in Cursor's context, and drives the real Cursor application through CDP.

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
- `cursor_init` initializes the current Codex or Claude Code context for one workspace. Re-running it replaces only that host-context workspace. Before explicit initialization, Codex can infer the workspace from `CODEX_THREAD_ID`; Claude Code uses its project root / working directory.
- The supervisor binds each resolved project to a validated Editor CDP target. Stale target IDs are rejected when their window title no longer matches the project, so an old `cursor-bridge` window cannot impersonate VESPERIX.
- Editor workspace selection and Agent UI selection are separate. When Cursor Agents v2 and the legacy workbench are both open, Bridge uses Agents v2 and creates the new Agent from the matching repository section—never from `Home`. If Agents v2 is not open, Bridge falls back to the legacy project workbench.
- FIFO means first in, first out: tasks are serialized through a UI lock, and each starts in a clean chat by default.
- `parallel_agent` tasks use independent top-level Cursor Agents.
- On Windows, the supervisor runs outside the Codex Job lifecycle, so closing one session does not terminate Cursor.

## Cursor Context Engine

Cursor Bridge exposes one read-only `cursor_context_engine` entry point with one parameter: `query`. State the intent once; Cursor decides how much investigation the question actually needs.

It can combine:

- Cursor indexed semantic retrieval
- exact text search
- symbol and reference tracing
- targeted source inspection
- Cursor Explore capabilities when they materially improve cross-file verification

Simple locations converge quickly. Call chains, data flows, registrations, interface implementations, and cross-module questions continue until Cursor has the minimum sufficient evidence, for example:

- route → service → storage
- producer → queue → consumer
- config → registration → implementation
- interface → concrete implementations
- cross-module ownership or data flow
- implementation context spanning multiple subsystems

The Bridge constrains read-only behavior, evidence quality, and stopping conditions. It does not pretend to micromanage Cursor's internal harness or force every question through the same search recipe.

The installed plugin also includes a shared `cce-routing` Skill for Codex and Claude Code. It steers unfamiliar-project questions, unknown implementation locations, and cross-module relationship tracing toward CCE, while keeping known-file reads, tests, logs, builds, Git work, and external documentation on their cheaper native paths.

Claude Code additionally receives a narrow routing guard for high-confidence ownership, call-chain, data-flow, registration, and load/runtime/save questions. The prompt hook asks Claude to try CCE first; if Claude still selects a competing context-mode collection tool, the guard denies at most two such calls and points it back to `cursor_context_engine`. The guard clears as soon as CCE is attempted and fails open after the bounded redirects. It does not intercept `Read`, `Grep`, `Glob`, `Bash`, `Agent`, editing, tests, logs, builds, Git work, external documentation, or an explicit Cursor opt-out. This materially improves automatic selection without claiming that a model-controlled tool call is mathematically guaranteed.

### Result contract

```text
CCE_SEARCH_RESULT
intent: <normalized intent>
coverage: <focused|extended> | <why this investigation depth was sufficient>
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
- Cursor installed and signed in. The target project must exist locally and open normally in Cursor.
- Run “Initialize CCE workspace to …” to persist that project as the active CCE workspace. Cursor itself owns and completes project indexing; `cursor_init` and the lifecycle supervisor do not build the index.
- Bridge manages the required local CCE connection automatically. If Cursor was opened before Bridge without that connection, save your work, close Cursor once, and repeat the same initialization sentence.
- Windows for actual top-level window suppression. Other platforms persist runtime mode but report window control as unsupported.

## Installation

### Codex

First installation:

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add cursor-bridge@vanyangyang
```

Update an existing installation:

```bash
codex plugin marketplace upgrade vanyangyang
codex plugin add cursor-bridge@vanyangyang
```

Restart Codex and start a new task after installation or update so the refreshed MCP tools and skills enter the session.

### Claude Code

First installation:

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

Update an existing installation:

```bash
claude plugin update cursor-bridge@vanyangyang
```

Restart Claude Code or run `/reload-plugins` after installation or update.

## Initialize CCE

Initialize once for the current Codex or Claude Code context. Initialization validates and persists the workspace, locates Cursor through platform-specific discovery, ensures the required CDP lifecycle, and opens or verifies the matching project target. The result is stored outside the plugin cache and survives adapter/plugin restarts; initialize again whenever you want to replace it.

Tell Codex or Claude Code in natural language:

```text
Initialize CCE workspace to C:\absolute\path\to\project
```

The host maps that sentence to the one-parameter `cursor_init({path})` tool. There is no Cursor Bridge slash command to remember or collide with a host command. The current host path and `CURSOR_PROJECT_PATH` remain compatibility fallbacks when no persisted initialization exists, but explicit initialization is authoritative.

The path must identify an existing project directory or `.code-workspace` file. Quoted paths, Windows UNC/extended paths, and macOS `~` paths are normalized internally; relative paths and unrelated files are rejected with a simple correction.

Cursor executable discovery is internal and requires no additional initialization parameter. On Windows, Bridge checks registered Cursor shell/uninstall locations, then standard per-user and system installations. On macOS, it checks `/Applications/Cursor.app` and `~/Applications/Cursor.app`. Only portable or custom installations should need `CURSOR_EXE`; it may point to `Cursor.exe`, a Windows Cursor installation folder, a macOS `.app` bundle, or its `Contents/MacOS/Cursor` executable. Quoted paths are normalized automatically.

You choose whether Cursor itself uses the legacy workbench, the new Agents Window, or both. Bridge does not rewrite that preference. If both are already open, requests prefer the new Agents Window and create the conversation inside the initialized repository rather than `Home`.

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
| `cursor_init` | Initialize or reinitialize CCE for one absolute workspace path. |
| `cursor_context_engine` | Adaptive read-only project understanding with compact, verified `path:line` evidence. Its only parameter is `query`. |
| `cursor_do` | Submit bounded FIFO (first-in, first-out serial queue) or independent `parallel_agent` work. |
| `cursor_status` | Read-only connectivity, queue, reservation, runtime, and task snapshot. |
| `cursor_task_control` | `reap`, targeted `cancel`, or explicitly acknowledged `abandon` for one task. |
| `cursor_runtime` | Persistently switch Cursor between visible `normal` and background `minimal` mode. |

## Minimal runtime

Tell Codex or Claude Code: `Switch CCE to minimal mode.` To use the Cursor interface again, say: `Switch CCE to normal mode.`

Minimal mode is the recommended option for using Cursor Bridge without bringing Cursor into the foreground. It is opt-in: fresh installations remain in visible `normal` mode, and top-level window suppression has currently been successfully tested only on Windows 11. Once enabled, the choice persists. Bridge prewarms the real Cursor process and keeps its top-level windows hidden while retaining the project index, Agent DOM, and task queue. This is a **UI-suppressed runtime**, not a headless reimplementation.

- **Advantage:** `cursor_context_engine` and `cursor_do` stay available in the background, so Cursor Bridge can be used without visible UI interruption.
- **Trade-off:** while minimal mode is active, manually opening Cursor reuses the guarded single-instance process and its window is hidden again. Ask CCE to **switch to normal mode** before returning to ordinary interactive Cursor use. There is no separate public temporary-show state to remember.

If Cursor was already open before CCE could establish its connection, initialization keeps the workspace saved and returns one safe instruction: save your work and close Cursor normally once. Repeat the same initialization sentence afterward; Bridge reopens Cursor automatically in the currently selected `normal` or `minimal` mode. Codex or Claude Code does not need to be restarted.

- `cursor_runtime({mode: "normal"})` restores ordinary visible behavior.
- `cursor_runtime({mode: "minimal"})` keeps CCE available while continuously hiding Cursor windows.

Switching back to `normal` forces a non-activating native show plus a placement-safe compositor refresh for ordinary windows. This wakes a populated Agents surface without deliberately taking keyboard focus; minimized, maximized, and snapped placement remains user-owned.

## Task execution and recovery

- Submit `cursor_do` with `background=true`, retain the returned `task_id`, then collect with `cursor_status(task_id)`.
- Parallel write tasks require non-overlapping `allowed_paths`; read-only tasks use `read_only=true`.
- `submitting`, `running`, and `collecting` are normal non-terminal states. `cursor_status` never mutates a task.
- A newly observed `LLM provider error` tray is a terminal failure. Bridge records its message and Request ID and never clicks retry automatically.
- Bridge verifies that Cursor accepted a submission. If Enter leaves the prompt in the editor, it tries Cursor's exact Send control once and then fails quickly as `submit_not_accepted` instead of waiting five minutes or creating an orphan.
- When Agents v2 is open, Bridge prefers it and creates new work from the initialized repository's sidebar section. A missing or ambiguous repository fails closed instead of falling back to `Home` or another project. If Agents v2 is absent, Bridge uses the validated legacy Editor target and its native Chat sidepanel.
- A timeout means Bridge could not confirm both a complete assistant reply and the end of generation. It does not prove the underlying Agent stopped.
- Partial Markdown while Stop remains active is not accepted as success.
- Post-send uncertainty retains an Agent or global reservation; Bridge does not silently release, resubmit, or click a broad global Stop control.
- Use `reap` only for a bound orphan and targeted `cancel` only with the exact published `agentId`.
- FIFO or unbound orphans block new delegation until the user verifies Cursor state and explicitly accepts `abandon` risk.
- Task records are process-local. After an MCP restart, inspect Agent History and workspace changes before overlapping work.

<details>
<summary><strong>Advanced environment overrides</strong></summary>

These are deployment and compatibility controls, not part of the normal CCE calling surface.

| Variable | Default | Description |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor remote-debugging port. |
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | Search completion timeout in milliseconds. |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | unset | Set to `1` to disable startup prewarming in both normal and minimal modes. |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | Bootstrap runtime mode when no persisted choice exists. Set `minimal` only for an explicitly requested UI-suppressed first run. |
| `CURSOR_BRIDGE_RUNTIME_FILE` | user config directory | Override the persistent runtime-mode file. |
| `CURSOR_BRIDGE_WORKSPACE_FILE` | user lifecycle directory | Override the per-host persistent `cursor_init` binding file. |
| `CURSOR_BRIDGE_DELEGATION` | `on` | Set to `off` to disable and hide `cursor_do`. |
| `CURSOR_PROJECT_PATH` | unset | Optional compatibility fallback used only when no persisted `cursor_init` workspace exists; otherwise the host project is auto-detected. |
| `CURSOR_EXE` | auto-detected | Optional executable, Windows installation folder, or macOS `.app` override for portable/custom installs. |

Advanced lifecycle overrides are intended for compatibility diagnostics. Bypassing the singleton supervisor on Windows is not recommended.

</details>

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](./assets/star-history.svg)](https://github.com/Vanyangyang/cursor-bridge/stargazers)
