# cursor-bridge

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

**Bring the project understanding in your real, signed-in Cursor session to Codex, Claude Code, and Grok Build.**

> [!NOTE]
> **Live-tested environment:** Windows 11 + Cursor 3.16.17, including Grok Build TUI. Every current Cursor version ships two editors: the workbench and the Agents Window. Bridge uses the Agents Window when it can bind the project, otherwise the workbench. It supports the older Agents Window sidebar and the 3.16.17 sidebar. Requires Node.js 18+, Cursor installed and signed in, and a local project Cursor can open. macOS has not yet been live-tested.

## What is CCE?

**Cursor Context Engine (CCE) exposes Cursor's existing project index and Agent search capabilities to Codex, Claude Code, and Grok Build through MCP.**

Ask a project question once. Cursor chooses the semantic retrieval, exact search, source reading, reference tracing, or Agent exploration it needs. Cursor Bridge returns compact, source-anchored `path:line` evidence with relevance notes instead of dumping the entire search process into the main Agent's context.

That means fewer blind directory guesses, fewer repeated `grep` calls, and less context-window waste.

Cursor Bridge does not inspect or manage your Cursor subscription. The models, quotas, and BYOK options available to your signed-in Cursor remain part of your own Cursor setup.

## Quick start

### Codex

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add cursor-bridge@vanyangyang
```

### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

### Grok Build

```bash
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge
```

Grok keeps plugins off until you enable them. `--trust` is required so the plugin's MCP server and hooks can run. Installing does not hot-reload the current session: open `/plugins` and press `r`, or start a new Grok session.

`grok plugin install Vanyangyang/cursor-bridge --trust` also works without adding the marketplace first.

Restart Codex and start a new task, restart Claude Code / run `/reload-plugins`, or reload Grok as above. Then initialize the project in natural language:

```text
Initialize CCE workspace to C:\absolute\path\to\project
```

Ask the real project question:

```text
Who owns this state, and what is the complete path from save loading to runtime use and save write-back?
```

Initialization is persistent. Repeat the initialization sentence with another absolute path whenever you want to switch projects.

## Compatibility

- **Cursor 3.16.17** Agents Window is live-tested on Windows 11. Bridge detects the current editor from on-screen elements, not the Cursor version number.
- The **workbench** and the **previous Agents Window** sidebar stay supported. If the Agents Window cannot bind the current repository, CCE uses the workbench.
- **Grok Build** is a supported plugin host alongside Codex and Claude Code. After `grok plugin install … --trust` and `grok plugin enable cursor-bridge`, reload with `/plugins` then `r` or start a new session.

## Use it

- **Understand a project:** `cursor_context_engine` follows ownership, call chains, data flow, registrations, and cross-module relationships, then returns compact source anchors, coverage, gaps, and confidence.
- **Delegate a bounded task:** `cursor_do` sends an explicitly scoped subtask to Cursor Agent and returns a task ID. The primary Agent remains responsible for reviewing the result and workspace changes.

> [!WARNING]
> Cursor is an Agent, not a filesystem sandbox. CCE strongly prompts read-only investigation, but prompts and allowed paths are not OS-level isolation. Verify consequential anchors and workspace changes.

<details>
<summary><strong>Update an existing installation</strong></summary>

Codex:

```bash
codex plugin marketplace upgrade vanyangyang
codex plugin add cursor-bridge@vanyangyang
```

Claude Code:

```bash
claude plugin marketplace update vanyangyang
claude plugin update cursor-bridge@vanyangyang
```

Grok Build:

```bash
grok plugin marketplace update cursor-bridge
grok plugin update cursor-bridge
```

Restart Codex and start a new task, restart Claude Code / run `/reload-plugins`, or in Grok open `/plugins` and press `r` / start a new session.

</details>

<details>
<summary><strong>How CCE searches and returns evidence</strong></summary>

`cursor_context_engine` has one public parameter: `query`. Cursor adapts the investigation depth to the evidence it discovers.

It can combine:

- indexed semantic retrieval;
- exact text search;
- symbol and reference tracing;
- targeted source inspection;
- Cursor Explore when cross-file verification actually needs it.

Why reuse Cursor? Its project understanding already combines semantic indexing, exact search, targeted reading, and agentic exploration. Cursor Bridge connects that existing capability to another coding Agent instead of rebuilding a second code-search stack.

Simple locations should converge quickly. Call chains, data flows, registrations, interface implementations, and ownership questions can continue across modules until the evidence is sufficient.

The installed `cce-routing` Skill offers bounded guidance for selecting CCE on unfamiliar-project semantic questions while leaving known-file reads, tests, logs, builds, Git work, and external documentation on native tools. Grok Build loads the same plugin skills after the plugin is enabled. Claude Code also has a narrow, fail-open routing guard for competing context collection. The host model still controls tool selection.

Result shape:

```text
CCE_SEARCH_RESULT
intent: <normalized intent>
coverage: <focused|extended> | <why this depth was sufficient>
evidence:
- path/to/file.ts:42-67 | symbolOrAnchor | verified relevance or relationship | reference
gaps: none
confidence: high
```

- Evidence is ordered by strength.
- Semantic similarity is not presented as a proven call edge.
- Missing evidence returns `NOT_FOUND` and the actual searched scope instead of a framework guess.
- Conversational preambles are removed without inventing evidence.

</details>

<details>
<summary><strong>Full MCP tool reference</strong></summary>

| Tool | What it does |
|---|---|
| `cursor_context_engine` | Read-only project understanding from one natural-language `query`. |
| `cursor_do` | Submits a clear, bounded subtask to Cursor Agent for execution. |
| `cursor_init` | Initializes or switches CCE to one absolute workspace path. |
| `cursor_runtime` | Switches between visible `normal` mode and Windows 11-tested UI-suppressed `minimal` mode. |
| `cursor_status` | Reads connection, queue, runtime, and task state without changing it. |
| `cursor_task_control` | Performs targeted `reap`, `cancel`, or explicitly acknowledged `abandon` recovery. |

</details>

<details>
<summary><strong>Workspace, Cursor UI, and lifecycle behavior</strong></summary>

```text
Codex / Claude Code / Grok Build
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

- `cursor_init` validates and persists one workspace for the current host context. Re-running it switches that context to another workspace.
- Cursor owns project indexing. Bridge ensures the connection and selects a matching, validated CDP target; it does not build the index itself.
- Multiple MCP adapters share one user-level lifecycle supervisor and re-read the persisted runtime mode before status or lifecycle work.
- When the Agents Window and the workbench are both open, Bridge prefers the Agents Window and creates work in the initialized repository section, including the 3.16.17 sidebar. If that window cannot bind the repo, or only the workbench is available, it uses the workbench. It does not create work in `Home`.
- Stale target IDs are rejected when the title no longer matches the requested project.
- Cursor UI preference remains user-owned; Bridge does not force old or new UI on.
- On Windows, the supervisor survives an individual Codex, Claude Code, or Grok session closing.

The path may be an existing project directory or `.code-workspace` file. Quoted paths, Windows UNC/extended paths, and macOS `~` paths are normalized; relative and unrelated file paths are rejected.

Cursor executable discovery is internal. Standard Windows registered/user/system locations and `/Applications/Cursor.app` or `~/Applications/Cursor.app` on macOS are checked automatically. Portable/custom installs may use `CURSOR_EXE`.

The macOS path normalization and executable-discovery branches are implementation details, not an end-to-end support claim; they have not yet been live-tested.

If Cursor is already running without the connection Bridge needs, Bridge returns one `close_cursor_and_retry` step instead of terminating it. Save your work, close Cursor normally once, and repeat the initialization sentence.

</details>

<details>
<summary><strong>Minimal runtime details</strong></summary>

Minimal mode is an explicit, persistent opt-in for UI-suppressed use on Windows 11. It keeps the real Cursor process, index, Agent DOM, and task queue running while hiding top-level Cursor windows. It is not a headless reimplementation.

- Advantage: `cursor_context_engine` and `cursor_do` stay available without a visible Cursor interruption.
- Trade-off: manually opening Cursor reuses the guarded single-instance process and remains hidden until CCE switches back to `normal`.
- Returning to `normal` performs a non-activating native show and a placement-safe compositor refresh for ordinary windows, without deliberately taking keyboard focus.
- Minimized, maximized, and snapped placement remains user-owned.

```text
Switch CCE to minimal mode.
Switch CCE to normal mode.
```

</details>

<details>
<summary><strong>cursor_do execution and recovery</strong></summary>

- FIFO means first in, first out: ordinary tasks are serialized through one UI lock and start in a clean chat.
- Independent `parallel_agent` tasks use separate top-level Cursor Agents. Writable parallel tasks require non-overlapping `allowed_paths`; read-only work uses `read_only=true`.
- Keep the returned `task_id` and collect it with `cursor_status(task_id)`.
- `submitting`, `running`, and `collecting` are normal non-terminal states.
- Bridge confirms that Cursor accepted the prompt. A prompt left in the editor gets one exact Send-control fallback, then fails as `submit_not_accepted` instead of silently becoming an orphan.
- Provider-error trays are retained as terminal evidence; Bridge does not click Retry automatically.
- Uncertain post-send work retains its reservation. It is not silently released or resubmitted.
- `reap` is for a bound orphan, targeted `cancel` requires the exact published Agent ID, and `abandon` requires explicit risk acknowledgement.
- Task records are process-local. After an MCP restart, inspect Agent History and workspace changes before starting overlapping work.

</details>

<details>
<summary><strong>Run from source and advanced overrides</strong></summary>

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

| Variable | Default | Description |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor remote-debugging port. |
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | Search completion timeout in milliseconds. |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | unset | Set to `1` to disable startup prewarming. |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | Bootstrap mode when no persisted choice exists. |
| `CURSOR_BRIDGE_RUNTIME_FILE` | user config directory | Override persistent runtime-mode storage. |
| `CURSOR_BRIDGE_WORKSPACE_FILE` | user lifecycle directory | Override persistent workspace binding storage. |
| `CURSOR_BRIDGE_DELEGATION` | `on` | Set to `off` to disable and hide `cursor_do`. |
| `CURSOR_PROJECT_PATH` | unset | Compatibility fallback used only without persisted initialization. |
| `CURSOR_EXE` | auto-detected | Portable/custom executable, Windows install folder, or macOS `.app` override. |

Advanced lifecycle overrides are compatibility controls. Bypassing the Windows singleton supervisor is not recommended.

</details>

## Friends

- [LINUX DO](https://linux.do) — A new kind of ideal community.

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/master/assets/star-history.svg?v=68a9278cec79)](https://github.com/Vanyangyang/cursor-bridge)

Updated automatically from GitHub's repository API. No external chart service or manually managed PAT is required.
