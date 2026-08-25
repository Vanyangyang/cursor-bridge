<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge"><img alt="30 Star milestone" src="https://img.shields.io/badge/30_STAR_MILESTONE-THANK_YOU!-FFD700?style=for-the-badge&amp;logo=github&amp;logoColor=white&amp;labelColor=181717" /></a>
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/master"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center"><strong>✨ 30 stars—thank you! Cursor Bridge is here for the long run and will keep pace with the latest Cursor releases. If this project helps you, please consider lighting up a ⭐ Star—thank you for your support! ✨</strong></p>

<p align="center"><sub><strong>Compatibility policy:</strong> Cursor Bridge maintains only the latest Cursor release; previous Cursor releases are not actively supported. If you need a historical Cursor version, first open the <a href="./COMPATIBILITY.md">Cursor Bridge compatibility and update history</a> and switch precisely to its matching archived release when one is listed. Archived releases receive no maintenance. If no historical release meets your needs, use <strong>Fork</strong> in the top-right corner and maintain the required adaptation in your own fork.</sub></p>

# Cursor Bridge + Grok Build Supervisor（New）

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

> [!WARNING]
> **Windows only:** Cursor Bridge and Grok Build Supervisor currently support Windows only. macOS and Linux are not supported or covered by end-to-end acceptance.

**Two independently installable MCP plugins for Codex, Claude Code, Grok Build, and Pi. Install only the bridge you need.**

| Plugin | Use it for | Documentation |
|---|---|---|
| **Cursor Bridge** | Let Codex, Claude Code, Grok Build, or Pi use Cursor CCE to understand the project, locate the right code, and trace relationships automatically; when needed, the optional `cursor_do` feature can execute clearly scoped tasks | [Continue below](#cursor-bridge) |
| **Grok Build Supervisor** | Let Codex, Claude Code, or Pi plan and review the work while automatically coordinating Grok Build to execute tasks, track progress, and verify results | [English](./plugins/grok-build-supervisor/README.md) · [简体中文](./plugins/grok-build-supervisor/README.zh-CN.md) |

## Grok Build Supervisor (New)

**Let Codex, Claude Code, or Pi plan and review the work while automatically coordinating Grok Build to execute tasks, track progress, and verify results.**

It is installed and updated independently from Cursor Bridge.

[Read the introduction, installation, and usage guide →](./plugins/grok-build-supervisor/README.md)

## Cursor Bridge

**Let Codex, Claude Code, Grok Build, or Pi use Cursor CCE to understand the project, locate the right code, and trace relationships automatically; when needed, the optional `cursor_do` feature can execute clearly scoped tasks.**

> [!IMPORTANT]
> **One-time Windows migration:** If the installed Cursor Bridge version is 5.3.6 or earlier, save your work before the first upgrade to 5.4.0 or any later release, then follow [Update an existing installation](#windows-update-migration) to clean up old-cache processes once. Later updates use the normal flow.

> [!NOTE]
> **Live-tested environment:** Windows 11 + Cursor **3.17.8** (IDE/workbench and Agents Window). Requires Node.js 18+, Cursor installed and signed in, and a local project Cursor can open. macOS has not yet been live-tested.

## What is CCE?

**Cursor Context Engine (CCE) exposes Cursor's existing project index and Agent search capabilities to Codex, Claude Code, Grok Build, and Pi through MCP.**

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

### Pi

```bash
pi install npm:pi-cursor-bridge
```

Restart Codex and start a new task, restart Claude Code / run `/reload-plugins`, reload Grok as above, or restart Pi after installation. Pi automatically binds Cursor Bridge to the directory where Pi was started. Other hosts can initialize or switch the project in natural language; Pi can use the same sentence when you intentionally want a different project:

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

Current Cursor compatibility target (Windows 11):

| Cursor | Cursor Bridge | Status |
|---|---|---|
| **3.17.8** | **5.4.2** (`master`, current) | Live-tested on Windows 11 in both the IDE and Agents Window. Project understanding and task execution work as expected. |

Previous Cursor versions are not actively maintained. See [Compatibility and update history](./COMPATIBILITY.md) for the archived Cursor Bridge 5.4.1 / Cursor 3.16.29 and Cursor Bridge 5.4.0 / Cursor 3.16.17 pairings with exact installation commands. If Agents Window is not available, CCE uses the IDE. Running FIFO tasks publish an Agent ID when the current editor exposes one; `cursor_task_control` cancel then stops that exact task. If no ID is published, Bridge does not guess-click Stop.

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

<a id="windows-update-migration"></a>

## Update an existing installation

> [!WARNING]
> **The first upgrade from Cursor Bridge 5.3.6 or earlier to 5.4.0 or any later release needs a one-time Windows cleanup.** Old plugin processes can keep a versioned cache directory open, which prevents Windows from replacing it. This is not an ACL problem and does not require deleting the plugin cache.

> [!TIP]
> **Recommended — copy this to your local coding Agent:** “I saved my work. Upgrade the installed Cursor Bridge plugin to the latest version currently available from its marketplace. Check its current version first; if it is 5.3.6 or earlier, inspect old-cache instances of `cursor-lifecycle-supervisor.mjs` and `dist/cursor-bridge.mjs`. After verifying ownership and the old-cache path, stop those processes without asking again; leave new persistent runtimes and unrelated processes alone. Do not mass-stop Node or PowerShell, change ACLs, or delete caches. Run the normal update and report the installed version, marketplace source, and any old-cache process that remains.”

After this migration, Cursor Bridge 5.4.0 and later releases run their persistent components outside the plugin cache, so later updates do not need special cleanup.

Codex:

```bash
codex plugin marketplace upgrade vanyangyang
codex plugin add cursor-bridge@vanyangyang
```

If Codex reports `marketplace 'vanyangyang' is not configured as a Git marketplace`, run `codex plugin marketplace add Vanyangyang/cursor-bridge --ref master` once, then retry the two commands above.

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

Updating the cache no longer requires stopping post-5.4.0 persistent runtimes, but an already open task does not hot-load new MCP, Skill, or command code. Start a new Codex task, restart Claude Code / run `/reload-plugins`, or in Grok open `/plugins` and press `r` / start a new session.

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
- `cursor_status` lists CDP page titles only. It does not inspect page DOM. CCE reloads a DOM-blank Agents page once. On Windows normal runtime, reusing an Agents Window also performs a throttled, non-activating native compositor refresh so a healthy DOM cannot remain behind a white Electron surface.
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

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/master/assets/star-history.svg?v=91940ce6cc4a)](https://github.com/Vanyangyang/cursor-bridge)
