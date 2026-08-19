# Cursor Bridge + Grok Build Supervisor

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

**Two independently installable MCP plugins for supervised coding-agent workflows. Install only the bridge you need.**

| Plugin | Use it for | Documentation |
|---|---|---|
| **Cursor Bridge** | Cursor project intelligence and bounded Cursor Agent execution | [Continue below](#cursor-bridge) |
| **Grok Build Supervisor** | Keep Grok Build running without repeatedly filling the host's context | [English](./plugins/grok-build-supervisor/README.md) · [简体中文](./plugins/grok-build-supervisor/README.zh-CN.md) |

> [!IMPORTANT]
> Existing Cursor Bridge users do not need to change their installation, configuration, tools, runtime, or update workflow. Grok Build Supervisor is a separate optional plugin and is not installed with Cursor Bridge.

## Grok Build Supervisor

**Let Codex or Claude Code manage a real Grok Build session while Grok does the hands-on work.**

The plugin opens or resumes Grok in a visible Windows Terminal window and keeps the connection alive in the background. Closing one Codex or Claude Code task, or reloading the plugin, does not make the Grok session disappear. It also keeps the project folder and sender identity matched, and prevents two hosts from sending commands at the same time.

The plugin does not send the same growing answer back on every status check. While Grok is working, it returns only a small status update. Short answers are returned once; long reports are saved to a local file and represented by the file location, size, checksum, and a short summary. If context-mode is already installed, it can extract the useful parts of that file, but it is optional.

Install it independently:

```bash
# Codex
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add grok-build-supervisor@vanyangyang

# Claude Code
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install grok-build-supervisor@vanyangyang
```

Run `/grok_init` once to set up the local proxy. After that, everyday use needs only `/grok_execute on` and `/grok_execute off`. While the mode is on, give Codex or Claude Code a normal task; the plugin finds, reuses, or opens the right Grok session by itself.

> [!TIP]
> Grok opens in a visible Windows Terminal window by default. If you do not want to see it for a particular task, say so plainly, for example: “Run this one without showing the Grok terminal.” The plugin never hides the window unless you ask.

[Read the Grok Build Supervisor documentation →](./plugins/grok-build-supervisor/README.md)

## Cursor Bridge

**Bring the project understanding in your real, signed-in Cursor session to Codex, Claude Code, and Grok Build.**

> [!NOTE]
> **Live-tested environment:** Windows 11 + Cursor **3.16.17** and **3.7.42**. Requires Node.js 18+, Cursor installed and signed in, and a local project Cursor can open. macOS has not yet been live-tested.

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

> [!TIP]
> **Recommended on Windows 11: minimal runtime**
>
> After initialization, say “Switch CCE to minimal mode.” The real Cursor process, project index, Agent DOM, and task queue keep running in the background while top-level windows stay hidden. You can use Cursor as the capability behind the plugin without visible interruption; `cursor_context_engine` and `cursor_do` remain available.
>
> **Trade-off:** while minimal mode is active, manually opening Cursor reuses the guarded single-instance process and remains hidden. Before you need the Cursor UI again, say “Switch CCE to normal mode.”
>
> This is an explicit, persistent opt-in live-tested on Windows 11, not a headless reimplementation of Cursor. Returning to normal does not deliberately take keyboard focus; minimized, maximized, and snapped placement remains user-owned.

## Compatibility

Supported Cursor versions (Windows 11):

| Cursor | Status |
|---|---|
| **3.16.17** | Live-tested. IDE and Agents Window, including running FIFO cancel when an Agent ID is published. |
| **3.7.42** | Live-tested. IDE and Agents Window. |

Other Cursor versions have not been tested. If Agents Window is not available, CCE uses the IDE. Running FIFO tasks publish an Agent ID when the current editor exposes one; `cursor_task_control` cancel then stops that exact task. If no ID is published, Bridge does not guess-click Stop.

Supported hosts: **Codex**, **Claude Code**, and **Grok Build**. After installing on Grok, run `grok plugin enable cursor-bridge`, then `/plugins` and `r`, or start a new session.

## Use it

- **Understand a project:** `cursor_context_engine` follows ownership, call chains, data flow, registrations, and cross-module relationships, then returns compact source anchors, coverage, gaps, and confidence.
- **Delegate a bounded task:** `cursor_do` sends an explicitly scoped subtask to Cursor Agent and returns a task ID. The primary Agent remains responsible for reviewing the result and workspace changes.

## Full MCP tool reference

| Tool | What it does |
|---|---|
| **`cursor_init`** | Initializes or switches CCE to one absolute workspace path. |
| **`cursor_context_engine`** | Read-only project understanding from one natural-language `query`. |
| **`cursor_do`** | Submits a clear, bounded subtask to Cursor Agent for execution. |
| **`cursor_status`** | Reads connection, queue, runtime, and task state without changing it. |
| `cursor_runtime` | Switches between visible `normal` mode and Windows 11-tested UI-suppressed `minimal` mode. |
| `cursor_task_control` | Performs targeted `reap`, `cancel`, or explicitly acknowledged `abandon` recovery. |

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
- When the Agents Window and the workbench are both open, Bridge prefers the Agents Window for the current project. If only the workbench is available, it uses that. It does not create work in `Home`.
- If Agents Window is already open, ensure reuses that CDP page and does not spawn `Cursor.exe --new-window`. A new workbench window is opened only when Cursor is connected and neither Agents Window nor a matching editor title exists.
- `cursor_status` lists CDP page titles only. It does not inspect page DOM. If Agents Window is white, CCE reloads that page once, then continues.
- Stale target IDs are rejected when the title no longer matches the requested project, except for the Agents Window title `Cursor Agents`, which is a valid reusable target.
- Cursor UI preference remains user-owned; Bridge does not force old or new UI on.
- On Windows, the supervisor survives an individual Codex, Claude Code, or Grok session closing.

The path may be an existing project directory or `.code-workspace` file. Quoted paths, Windows UNC/extended paths, and macOS `~` paths are normalized; relative and unrelated file paths are rejected.

Cursor executable discovery is internal. Standard Windows registered/user/system locations and `/Applications/Cursor.app` or `~/Applications/Cursor.app` on macOS are checked automatically. Portable/custom installs may use `CURSOR_EXE`.

The macOS path normalization and executable-discovery branches are implementation details, not an end-to-end support claim; they have not yet been live-tested.

If Cursor is already running without the connection Bridge needs, Bridge returns one `close_cursor_and_retry` step instead of terminating it. Save your work, close Cursor normally once, and repeat the initialization sentence.

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
- `reap` is for a bound parallel orphan. Targeted `cancel` requires the exact published Agent ID. FIFO tasks on Agents Window or workbench that publish an Agent ID can be stopped the same way. If no ID is published, Bridge will not guess-click Stop; confirm the Cursor chat is stopped, then `abandon`.
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

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/master/assets/star-history.svg?v=3e8695085bf9)](https://github.com/Vanyangyang/cursor-bridge)

Updated automatically from GitHub's repository API. No external chart service or manually managed PAT is required.
