<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/main"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center"><strong>✨ Thank you! This project is here for the long run, and Cursor Bridge will keep pace with the latest Cursor releases. If it helps you, please consider lighting up a ⭐ Star—thank you for your support! ✨</strong></p>

<p align="center"><sub><strong>Compatibility policy:</strong> Cursor Bridge maintains only the latest Cursor release; previous Cursor releases are not actively supported. If you need a historical Cursor version, first open the <a href="./COMPATIBILITY.md">Cursor Bridge compatibility and update history</a> and switch precisely to its matching archived release when one is listed. Archived releases receive no maintenance. If no historical release meets your needs, use <strong>Fork</strong> in the top-right corner and maintain the required adaptation in your own fork.</sub></p>

# Cursor Bridge + Grok Build Supervisor

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

## Give the coding client you already use access to Cursor and Grok Build

Keep using **Codex (recommended)**, Claude Code, or Pi as your normal coding client. The plugins are independent: install Cursor Bridge to let that client use Cursor, install Grok Build Supervisor to let it coordinate Grok Build, or install both to combine those capabilities in one conversation.

```text
Codex (recommended) / Claude Code / Pi
      your existing coding client
              │
   plugins add coordination abilities
          ┌───┴──────────────┐
          ▼                  ▼
    Cursor Bridge     Grok Build Supervisor
   CCE + cursor_do       supervised Grok Build
```

- Start with `cursor_context_engine` for compact, source-anchored project understanding.
- Use the now first-class `cursor_do` path for a bounded Cursor Agent task when delegated execution saves time; your current client still reviews the real diff and tests.
- Turn on `/grok_execute on` when Grok Build should execute while your current client plans, monitors, handles questions, and verifies the result.

This repository is not a separate orchestrator. The plugins add these capabilities to the client you already use, so install only what you need.

## Grok Build Supervisor (New)

**Let Codex, Claude Code, or Pi plan and review the work while automatically coordinating Grok Build to execute tasks, track progress, and verify results.**

It is installed and updated independently from Cursor Bridge.

[Read the introduction, installation, and usage guide →](./plugins/grok-build-supervisor/README.md)

## Cursor Bridge

**Let Codex, Claude Code, Grok Build, or Pi use Cursor CCE to understand the project, locate the right code, and trace relationships automatically; when needed, the optional `cursor_do` feature can execute clearly scoped tasks.**

> [!IMPORTANT]
> **One-time Windows migration:** If the installed Cursor Bridge version is 5.3.6 or earlier, save your work before the first upgrade to 5.4.0 or any later release, then follow [Update an existing installation](#windows-update-migration) to clean up old-cache processes once. Later updates use the normal flow.

> [!NOTE]
> **Live-tested environment:** Windows 11 + Cursor **3.18.25**, identified from the installed executable's product and file versions and cold-launched by Cursor Bridge 5.8.0 with `--remote-debugging-port=9223`. The run passed workspace binding, source-anchored CCE, persistent `cursor_do` create/continue across two adapters with one stable Agent ID, Grok 4.6/high model verification, and `minimal` / `normal` recovery while retaining one top-level Cursor Agents window and one CDP page target. Requires Node.js 18+, Cursor installed and signed in, and a local project Cursor can open. The legacy IDE/workbench target was not exposed, and macOS has not yet been live-tested.

## What is CCE?

**Cursor Context Engine (CCE) exposes Cursor's existing project index and Agent search capabilities to Codex, Claude Code, Grok Build, and Pi through MCP.**

Ask a project question once. Cursor chooses the semantic retrieval, exact search, source reading, reference tracing, or Agent exploration it needs. Cursor Bridge returns compact, source-anchored `path:line` evidence with relevance notes instead of dumping the entire search process into the main Agent's context.

That means fewer blind directory guesses, fewer repeated `grep` calls, and less context-window waste.

Cursor Bridge does not inspect or manage your Cursor subscription. The models, quotas, and BYOK options available to your signed-in Cursor remain part of your own Cursor setup.

## Quick start

### 1. Choose your client and install what you need

The commands are grouped by the client you already use. Cursor Bridge and Grok Build Supervisor are independent: install either one, or both.

#### Codex (recommended)

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref main
codex plugin add cursor-bridge@vanyangyang
# Optional: add the Supervisor for the combined Cursor + Grok Build workflow
codex plugin add grok-build-supervisor@vanyangyang
```

#### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
# Optional: add the Supervisor for the combined Cursor + Grok Build workflow
claude plugin install grok-build-supervisor@vanyangyang
```

#### Grok Build

```bash
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge
```

`grok plugin install Vanyangyang/cursor-bridge --trust` also works without adding the marketplace first.

#### Pi

```bash
pi install npm:pi-cursor-bridge
# Optional: add the Supervisor for the combined Cursor + Grok Build workflow
pi install npm:pi-grok-build-supervisor
```

### 2. Restart or reload your client

Restart Codex and start a new task, restart Claude Code or run `/reload-plugins`, reload Grok through `/plugins` or start a new Grok session, or restart Pi. Grok keeps plugins disabled until you run `grok plugin enable cursor-bridge`; `--trust` allows the plugin's MCP server and hooks to run.

### 3. Initialize the plugin you installed

If you installed Cursor Bridge, Pi automatically binds it to the directory where Pi was started. Other hosts can initialize or switch the project in natural language; Pi can use the same sentence when you intentionally want a different project:

```text
Initialize CCE workspace to C:\absolute\path\to\project
```

Initialization is persistent. Repeat the sentence with another absolute path whenever you want to switch projects.

If you installed Grok Build Supervisor, run `/grok_init` once. Then run `/grok_execute on` in the project where you want the current client to coordinate Grok Build.

### 4. Start with a real task

With Cursor Bridge, ask the real project question:

```text
Who owns this state, and what is the complete path from save loading to runtime use and save write-back?
```

With Grok Build Supervisor enabled, send your normal implementation task; the current client handles planning and verification while Grok Build executes.

> [!TIP]
> **Recommended on Windows 11: minimal runtime**
>
> After initialization, say “Switch CCE to minimal mode.” The real Cursor process, project index, Agent DOM, and task queue keep running in the background while top-level windows stay hidden. You can use Cursor as the capability behind the plugin without visible interruption; `cursor_context_engine` and `cursor_do` remain available.
>
> **Trade-off:** while minimal mode is active, manually opening Cursor reuses the guarded single-instance process and remains hidden. Before you need the Cursor UI again, say “Switch CCE to normal mode.”

## Compatibility

Cursor compatibility targets (Windows 11):

| Cursor | Cursor Bridge | Status |
|---|---|---|
| **3.18.25** | **5.8.0** (`main`, current) | Cold-launched from the user install into one persistent `supervised` Supervisor, one Cursor Agents window, and one CDP page target. Grok 4.6/high passed source-anchored CCE, two-adapter persistent `cursor_do` turns on one exact Agent, and `minimal` / restored `normal`. The 3.18.25 effort-only model trigger is adapted by reporting the verified selected model row. |

Previous Cursor Bridge versions are not actively maintained. See [Compatibility and update history](./COMPATIBILITY.md) for the archived 5.7.1, 5.7.0, 5.6.2, 5.6.1, 5.6.0, 5.5.0, 5.4.2, 5.4.1, and 5.4.0 pairings with exact installation commands. If Agents Window is not available, CCE uses the IDE when Cursor exposes that surface. Running FIFO tasks publish an Agent ID when the current editor exposes one; `cursor_task_control` cancel then stops that exact task. If no ID is published, Bridge does not guess-click Stop.

Supported hosts: **Codex**, **Claude Code**, **Grok Build**, and **Pi**. After installing on Grok, run `grok plugin enable cursor-bridge`, then `/plugins` and `r`, or start a new session.

## Use CCE and `cursor_do`

- **Start with project understanding:** `cursor_context_engine` follows ownership, call chains, data flow, registrations, and cross-module relationships, then returns compact source anchors, coverage, gaps, and confidence.
- **Move to bounded execution with `cursor_do`:** send a clearly scoped Cursor Agent task and receive a stable task ID for collection and recovery. `cursor_do` is optional, but no longer hidden as an edge feature: use it whenever a bounded Cursor pass is the efficient execution path. The primary Agent remains responsible for reviewing the result, real workspace changes, and verification evidence.
- **Keep the model you chose:** say “Use GPT-5.6 Terra with max effort for CCE” or “Use GPT-5.6 Sol with high effort for cursor_do.” `cursor_model` stores independent defaults for CCE and `cursor_do` across host tasks and restarts until you explicitly change or reset them. Before every prompt, Bridge applies and verifies the selection; it fails before sending instead of silently falling back to Auto.

## Full MCP tool reference

| Tool | What it does |
|---|---|
| **`cursor_init`** | Initializes or switches CCE to one absolute workspace path. |
| **`cursor_context_engine`** | Read-only project understanding from one natural-language `query`. |
| **`cursor_do`** | Submits a clear, bounded subtask to Cursor Agent for execution. |
| **`cursor_model`** | Shows, sets, or resets persistent model and reasoning-effort defaults for CCE, `cursor_do`, or both. |
| **`cursor_status`** | Reads connection, queue, runtime, persistent model defaults, and configured/effective task state without changing it. |
| `cursor_runtime` | Switches between visible `normal` mode and Windows 11-tested UI-suppressed `minimal` mode. |
| `cursor_task_control` | Performs targeted `reap`, `cancel`, or explicitly acknowledged `abandon` recovery. |

> [!WARNING]
> Cursor is an Agent, not a filesystem sandbox. CCE strongly prompts read-only investigation, but prompts and allowed paths are not OS-level isolation. Verify consequential anchors and workspace changes.

<a id="windows-update-migration"></a>

## Update Cursor Bridge

Cursor Bridge 5.4.0 and later use the normal update commands below. If the currently installed version is 5.3.6 or earlier, complete the [one-time Windows migration](#one-time-windows-migration) first, then return to these commands.

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

Pi:

```bash
pi update npm:pi-cursor-bridge
```

After updating, start a new Codex task, restart Claude Code or run `/reload-plugins`, reload Grok through `/plugins` or start a new Grok session, or restart Pi. An already open task does not hot-load new MCP, Skill, or command code.

If Codex reports `marketplace 'vanyangyang' is not configured as a Git marketplace`, run `codex plugin marketplace add Vanyangyang/cursor-bridge --ref main` once, then retry the Codex commands above.

<a id="one-time-windows-migration"></a>

### One-time Windows migration from Cursor Bridge 5.3.6 or earlier

> [!WARNING]
> **Only the first Windows upgrade from Cursor Bridge 5.3.6 or earlier needs this cleanup.** Old plugin processes can keep a versioned cache directory open and block replacement. Do not change ACLs or delete the plugin cache.

> [!TIP]
> **Recommended — copy this to your local coding Agent:** “I saved my work. First check the installed Cursor Bridge version. Only if it is 5.3.6 or earlier, inspect processes whose command lines load `cursor-lifecycle-supervisor.mjs` or `dist/cursor-bridge.mjs` from the host's versioned plugin cache. Treat every instance under `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` as the new persistent runtime and do not stop it. After verifying the exact old-cache path and ownership, stop only those old-cache processes without asking again; do not mass-stop Node or PowerShell, change ACLs, delete caches, or touch unrelated processes. The current task's old Cursor Bridge MCP may disconnect when its old adapter stops; that is expected. Then update Cursor Bridge to the latest version using the current host's normal marketplace command, reload the host, and report the installed version, marketplace source, and any old-cache process that remains.”

After this one-time migration, later updates do not need special process cleanup.

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
Codex / Claude Code / Grok Build / Pi
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
- On a cold launch, Bridge starts the CDP-enabled Cursor process without a project or `--new-window` argument, waits for the target list to stabilize, then binds the repository inside Agents v2. A transient first target is never treated as canonical merely because it appeared first.
- When the Agents Window and the workbench are both open, Bridge prefers the Agents Window for the current project. If only the workbench is available, it uses that. It does not create work in `Home`.
- If Agents Window is already open, ensure reuses that CDP page and does not spawn `Cursor.exe --new-window`. A new workbench window is opened only when Cursor is connected and neither Agents Window nor a matching editor title exists.
- `cursor_status` lists CDP page titles only. It does not inspect page DOM. CCE reloads a DOM-blank Agents page once. On Windows normal runtime, reusing an Agents Window also performs a throttled, non-activating native compositor refresh so a healthy DOM cannot remain behind a white Electron surface.
- Stale target IDs are rejected when the title no longer matches the requested project, except for the Agents Window title `Cursor Agents`, which is a valid reusable target.
- Cursor UI preference remains user-owned; Bridge does not force old or new UI on.
- On Windows, the supervisor survives an individual Codex, Claude Code, Grok Build, or Pi session closing.

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
- `session_mode=isolated` remains the default. Use `session_mode=create` only when later turns must keep the same Cursor context; continue through the returned stable `session_id` with `session_mode=continue`.
- Every continued turn receives a new `task_id` and must repeat `read_only=true` or an `allowed_paths` subset. Persistent sessions require `parallel_agent`, allow one active turn, and never downgrade to FIFO.
- `cursor_status(session_id)` inspects the durable association. `cursor_session_control(action=close)` ends Bridge continuity without stopping Cursor; an already-closed mapping may be removed with `action=forget, confirm=true`.
- After an interrupted adapter, `cursor_session_control(action=reconcile)` checks the exact Agent twice and never resends. `abandon` is an explicitly acknowledged last resort when stop evidence cannot be recovered.
- Ready session mappings survive MCP restart and plugin-cache replacement because their atomic registry lives in the user configuration directory. Prompts, replies, credentials, plugin paths, scripts, and CDP target IDs are not persisted.
- `submitting`, `running`, and `collecting` are normal non-terminal states.
- Bridge confirms that Cursor accepted the prompt. A prompt left in the editor gets one exact Send-control fallback, then fails as `submit_not_accepted` instead of silently becoming an orphan.
- Provider-error trays are retained as terminal evidence; Bridge does not click Retry automatically.
- Uncertain post-send work retains its reservation. It is not silently released or resubmitted.
- A parallel Agents v2 task keeps its provisional composer identity reserved until a durable History row is evidenced, then migrates exactly once; another concurrent submission cannot replace that task's `agentId` during convergence.
- `reap` is for a bound parallel orphan. Targeted `cancel` requires the exact published Agent ID. FIFO tasks on Agents Window or workbench that publish an Agent ID can be stopped the same way. If no ID is published, Bridge will not guess-click Stop; confirm the Cursor chat is stopped, then `abandon`.
- Task records remain process-local. After an MCP restart, inspect Agent History and workspace changes before starting overlapping isolated work; a persistent session may continue only when `cursor_status(session_id)` still reports `ready` with its exact Agent binding.

Internal identity, state, recovery, scope, and update invariants are defined in [Cursor Delivery Session Contract](./docs/CURSOR_SESSION_CONTRACT.md).

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
| `CURSOR_BRIDGE_SESSION_FILE` | user config directory | Override the Cursor Delivery Session registry. Never point it into a versioned plugin cache. |
| `CURSOR_BRIDGE_MODEL_PREFERENCES_FILE` | user config directory | Override persistent CCE / `cursor_do` model and effort storage. |
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

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/main/assets/star-history.svg?v=cfb78637bac1)](https://github.com/Vanyangyang/cursor-bridge)
