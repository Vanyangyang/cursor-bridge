<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/main"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center">If you use this, star the repo.</p>

<p align="center"><sub><strong>Compatibility:</strong> I only keep Cursor Bridge working against the latest Cursor. Older Cursor versions are not something I actively support. If you need a historical Cursor, open the <a href="./COMPATIBILITY.md">compatibility and update history</a> and switch to the archived Bridge release listed for that Cursor, if one exists. Archived releases get no further fixes. If nothing there fits, use <strong>Fork</strong> in the top-right corner and keep the adaptation in your own fork.</sub></p>

# Cursor Bridge + Grok Build Supervisor

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [AI install](./docs/ai-install.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

> [!WARNING]
> **Windows only:** Cursor Bridge and Grok Build Supervisor currently support Windows only. macOS and Linux are not supported or covered by end-to-end acceptance.

I maintain two MCP plugins. They install separately. Both work with Codex, Claude Code, Grok Build, and Pi. If your AI client speaks MCP but is not one of those four, have the current AI read the [AI install playbook](./docs/ai-install.md) and install the MCP server plus skills itself.

| Plugin | Use it for | Documentation |
|---|---|---|
| Cursor Bridge | Codex, Claude Code, Grok Build, or Pi can ask Cursor CCE about a project and get source-anchored answers. Optional `cursor_do` can run a clearly scoped Cursor Agent task. | [Continue below](#cursor-bridge) |
| Grok Build Supervisor | Codex, Claude Code, or Pi keep the plan and the review. Grok Build does the implementation. The supervisor follows the run and the checks. | [English](./plugins/grok-build-supervisor/README.md) · [简体中文](./plugins/grok-build-supervisor/README.zh-CN.md) |

## Use Cursor and Grok Build from the client you already have

I still use Codex as my daily client, and that is the one I recommend. Claude Code and Pi work the same way. By AI client I mean the coding app you already chat with, not the Cursor Agent that `cursor_do` can run, and not an MCP protocol client.

The plugins do not depend on each other. Install Cursor Bridge if you want that client to use Cursor, or Grok Build Supervisor if you want it to coordinate Grok Build. Installing both is how you get both in one conversation.

```text
Codex (recommended) / Claude Code / Pi
      your existing AI client
              │
          optional plugins
          ┌───┴──────────────┐
          ▼                  ▼
    Cursor Bridge     Grok Build Supervisor
   CCE + cursor_do       supervised Grok Build
```

I usually start with `cursor_context_engine` when I need compact, source-anchored project context. I reach for `cursor_do` when a bounded Cursor Agent pass is faster than doing the edit myself. The current AI client still reviews the real diff and tests. `/grok_execute on` is when Grok Build should implement. The current client still plans, watches progress, answers questions, and verifies.

The plugins attach to the client you already use. I did not add a separate orchestrator.

## Grok Build Supervisor (New)

Codex, Claude Code, or Pi stay on planning and review, and Grok Build does the implementation. The supervisor follows the run and the checks.

It installs and updates separately from Cursor Bridge.

[Read the introduction, installation, and usage guide →](./plugins/grok-build-supervisor/README.md)

## Cursor Bridge

This is the plugin I use when I want Codex, Claude Code, Grok Build, or Pi to go through Cursor CCE for project questions. `cursor_do` is optional: it sends a clearly scoped task to Cursor Agent.

> [!IMPORTANT]
> **One-time Windows migration:** If the installed Cursor Bridge version is 5.3.6 or earlier, save your work before the first upgrade to 5.4.0 or any later release, then follow [Update an existing installation](#windows-update-migration) to clean up old-cache processes once. Later updates use the normal flow.

> [!NOTE]
> See [Compatibility and update history](./COMPATIBILITY.md) and the [latest release](https://github.com/Vanyangyang/cursor-bridge/releases) for the current pairing and its evidence boundary.

CCE and `cursor_do` accept optional `request_context`, for example `{"sender":"model","source":"mixed"}`. `sender` declares who directly sends the request (`user/model/unknown`); `source` distinguishes user requirements from model additions (`user/model/mixed/unknown`). Separate both in mixed prompt text. Omitted values remain unknown, are not inferred from the selected model, and never grant extra permission. Task status reports the declaration for that turn.
>
> **Live-tested environment:** Windows 11 + Cursor **3.21.16**, verified from Cursor's embedded package metadata and the current-user uninstall registry. The Cursor Bridge 6.0.5 release code passed native exact workspace binding and read-only FIFO `cursor_do` with Grok 4.7/high after cache refresh; CDP confirmed internal model `grok-4.7` and `reasoning_effort=high` before submission. The native host still reported the pre-bump 6.0.4 label, so exact 6.0.5 label pickup remains pending a fresh host task after publication. The broader IDE and Agents Window acceptance inherited from 6.0.4 covers CCE, two simultaneous independent Agents, persistent-session restart recovery, unread-result collection, `minimal` CCE followed by normal restoration, and both close orders restoring exactly one last-closed window type. Requires Node.js 18+, Cursor installed and signed in, and a local project Cursor can open. macOS has not yet been live-tested.

## What is CCE?

Cursor Context Engine (CCE) is Cursor's existing project index and Agent search, exposed to Codex, Claude Code, Grok Build, and Pi over MCP.

Ask the project question once. Cursor picks semantic retrieval, exact search, source reading, reference tracing, or Agent exploration as needed. Bridge returns compact `path:line` evidence with relevance notes. It does not dump the whole search into the main Agent context.

I wrote Bridge so the main agent does not have to guess directories or repeat `grep` just to find the same code.

Cursor Bridge does not inspect or manage your Cursor subscription. Models, quotas, and BYOK options stay whatever your signed-in Cursor already has.

## Quick start

### 1. Choose your AI client and install what you need

Commands are grouped by the AI client you already use. Cursor Bridge and Grok Build Supervisor install separately: take one, or both.

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

<a id="other-mcp-hosts"></a>

#### Other MCP-capable AI clients

Give this sentence to the AI client you are already using:

```text
Read https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.md completely. Install Cursor Bridge into this AI client. Follow every step. Report against the completion standard at the end. Use only the dedicated generic npm package named in the playbook. Do not invent a marketplace plugin, do not use a Pi package, and do not publish anything.
```

The playbook tells the current AI to detect the client. Codex, Claude Code, Grok, and Pi stay on their marketplace commands. Anything else installs `vanyangyang-cursor-bridge` into `%LOCALAPPDATA%\cursor-bridge\npm`. It then says where the MCP bundle and skills landed, so this AI client can register them, restart, and initialize the workspace. I do not treat that path as a first-class client, and I have not live-tested it. Cursor Bridge is still Windows-only.

### 2. Restart or reload your AI client

Restart Codex and start a new task, restart Claude Code or run `/reload-plugins`, reload Grok through `/plugins` or start a new Grok session, restart Pi, or restart the current AI client. Grok keeps plugins disabled until you run `grok plugin enable cursor-bridge`; `--trust` allows the plugin's MCP server and hooks to run.

### 3. Initialize the plugin you installed

If you installed Cursor Bridge, Pi automatically binds it to the directory where Pi was started. Other AI clients can initialize or switch the project in natural language; Pi can use the same sentence when you intentionally want a different project:

```text
Initialize CCE workspace to C:\absolute\path\to\project
```

Initialization is persistent. Repeat the sentence with another absolute path whenever you want to switch projects.

If you installed Grok Build Supervisor, initialize once (`$grok-build-supervisor init` in Codex), then select **Enable Grok Execution** in the project where Grok should work. **Disable Grok Execution** returns the AI client to normal execution without closing the terminal. Neither control needs an extra argument. See the [Grok guide](./plugins/grok-build-supervisor/README.md#install) for other AI clients and compatibility commands.

### 4. Try a real question

With Cursor Bridge, ask the actual project question:

```text
Who owns this state, and what is the complete path from save loading to runtime use and save write-back?
```

With Grok Build Supervisor enabled, send your normal implementation task; the current AI client handles planning and verification while Grok Build executes.

> [!TIP]
> **Recommended on Windows 11: minimal runtime**
>
> After initialization, say “Switch CCE to minimal mode.” The real Cursor process, project index, Agent DOM, and task queue keep running in the background. Top-level windows stay hidden. `cursor_context_engine` and `cursor_do` still work; you just do not see the Cursor UI.
>
> **Trade-off:** while minimal mode is active, manually opening Cursor reuses the guarded single-instance process and remains hidden. Before you need the Cursor UI again, say “Switch CCE to normal mode.”

## Compatibility

See [Compatibility and update history](./COMPATIBILITY.md) and the [latest release](https://github.com/Vanyangyang/cursor-bridge/releases) for the current pairing, evidence boundary, and archived installation instructions. If Agents Window is not available, CCE uses the IDE when Cursor exposes that surface. Running FIFO tasks publish an Agent ID when the current editor exposes one; `cursor_task_control` cancel then stops that exact task. If no ID is published, Bridge does not guess-click Stop.

Supported AI clients are Codex, Claude Code, Grok Build, and Pi. Those are the ones I live-test. Other MCP-capable AI clients can use the [AI install playbook](./docs/ai-install.md). They do not get marketplace updates, and they are not in the live-tested set. After installing on Grok, run `grok plugin enable cursor-bridge`, then `/plugins` and `r`, or start a new session.

## Using CCE and `cursor_do`

`cursor_context_engine` follows ownership, call chains, data flow, registrations, and cross-module relationships. It comes back with compact source anchors, coverage, gaps, and confidence.

`cursor_do` sends a clearly scoped Cursor Agent task and returns a stable task ID for collection and recovery. It is optional. I use it when a bounded Cursor pass is the faster path. The primary Agent still reviews the result, the real workspace changes, and the verification evidence.

Model choice sticks if you say it out loud: “Use GPT-5.6 Terra with max effort for CCE” or “Use GPT-5.6 Sol with high effort for cursor_do.” `cursor_model` stores separate defaults for CCE and `cursor_do` across AI client tasks and restarts until you change or reset them. Before every prompt, Bridge applies the selection and checks it. If that check fails, it stops instead of silently falling back to Auto.

## MCP tools

| Tool | What it does |
|---|---|
| `cursor_init` | Initializes or switches CCE to one absolute workspace path. |
| `cursor_context_engine` | Read-only project understanding from one natural-language `query`; it can assert an intended workspace before sending. |
| `cursor_do` | Submits a clear, bounded subtask to Cursor Agent for execution. Background submissions return a compact receipt; synchronous `background=false` returns the full result. It can assert an intended workspace before sending. |
| `cursor_model` | Shows, sets, or resets persistent model and reasoning-effort defaults for CCE, `cursor_do`, or both. |
| `cursor_status` | Reads connection, queue, runtime, persistent model defaults, and configured/effective task state. Task views are compact by default; `cursor_status(task_id, detail="result")` returns the plain complete reply and records receipt. `detail="full"` retains diagnostic task detail plus the reply. |
| `cursor_runtime` | Switches between visible `normal` mode and Windows 11-tested UI-suppressed `minimal` mode. |
| `cursor_task_control` | Performs targeted `reap`, `cancel`, or explicitly acknowledged `abandon` recovery and returns an action/state summary; retrieve the reply separately with `cursor_status(task_id, detail="result")`. |

| Parameter | Used by | Meaning |
|---|---|---|
| `workspace_path` | `cursor_context_engine`, `cursor_do` | Optional absolute workspace assertion. A mismatch or unconfirmed target fails before sending; it never switches or registers a project. |

When the AI client knows the target project, pass `workspace_path`. Use the host-provided workspace root/current-task cwd unless the request explicitly targets another project; never infer it from a repository name or a saved default. `cursor_init` remains the explicit operation for initialization, registration, and switching. `initialized=true` only means a binding exists, not that this request's target is confirmed.

For pre-send `WORKSPACE_CONFIRMATION_REQUIRED`, `WORKSPACE_INITIALIZATION_REQUIRED`, or `WORKSPACE_MISMATCH` with a known target, first inspect `cursor_status`. If it is idle with no queued or blocking work and `workspaceBusy=false` when exposed, run `cursor_init` for that exact path, verify ready status and the exact path, then retry the original call once. Busy, ambiguous, `needs_attention`, or uncertain send state requires reporting the condition and using the necessary local fallback instead.

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

Other MCP-capable AI clients: ask the current AI to re-read the [AI install playbook](./docs/ai-install.md) and update the installed npm package, then restart this AI client.

After updating, start a new Codex task, restart Claude Code or run `/reload-plugins`, reload Grok through `/plugins` or start a new Grok session, restart Pi, or restart the current AI client. An already open task does not hot-load new MCP, Skill, or command code.

If Codex reports `marketplace 'vanyangyang' is not configured as a Git marketplace`, run `codex plugin marketplace add Vanyangyang/cursor-bridge --ref main` once, then retry the Codex commands above.

<a id="one-time-windows-migration"></a>

### One-time Windows migration from Cursor Bridge 5.3.6 or earlier

> [!WARNING]
> **Only the first Windows upgrade from Cursor Bridge 5.3.6 or earlier needs this cleanup.** Old plugin processes can keep a versioned cache directory open and block replacement. Do not change ACLs or delete the plugin cache.

> [!TIP]
> **Recommended: copy this to your local coding Agent:** “I saved my work. First check the installed Cursor Bridge version. Only if it is 5.3.6 or earlier, inspect processes whose command lines load `cursor-lifecycle-supervisor.mjs` or `dist/cursor-bridge.mjs` from the AI client's versioned plugin cache. Treat every instance under `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` as the new persistent runtime and do not stop it. After verifying the exact old-cache path and ownership, stop only those old-cache processes without asking again; do not mass-stop Node or PowerShell, change ACLs, delete caches, or touch unrelated processes. The current task's old Cursor Bridge MCP may disconnect when its old adapter stops; that is expected. Then update Cursor Bridge to the latest version using the current AI client's normal marketplace command, reload the AI client, and report the installed version, marketplace source, and any old-cache process that remains.”

After this one-time migration, later updates do not need special process cleanup.

<details>
<summary><strong>How CCE searches and returns evidence</strong></summary>

`query` carries the project question. The optional absolute `workspace_path` asserts the target project before CCE sends; Cursor adapts the investigation depth to the evidence it discovers.

It can combine:

- indexed semantic retrieval;
- exact text search;
- symbol and reference tracing;
- targeted source inspection;
- Cursor Explore when cross-file verification actually needs it.

I reuse Cursor because it already has the index and the agent search. Bridge connects that to another coding Agent. I did not want a second code-search stack.

A simple “where is this symbol” question should finish quickly. Call chains, data flows, registrations, interface implementations, and ownership questions can keep walking modules until the evidence is enough.

The installed `cce-routing` Skill offers bounded guidance for selecting CCE on unfamiliar-project semantic questions while leaving known-file reads, tests, logs, builds, Git work, and external documentation on native tools. Grok Build loads the same plugin skills after the plugin is enabled. Claude Code also has a narrow, fail-open routing guard for competing context collection. The AI client's model still controls tool selection.

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

- `cursor_init` validates and persists one workspace for the current AI client context. In Agents Window, it registers a missing local workspace through Cursor's workspace service and verifies the exact path before reporting ready. Re-running it switches that context to another workspace; status checks never register projects.
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
- An asynchronous `cursor_do(background=true)` returns a compact submission receipt. Save its `task_id`, poll `cursor_status(task_id)` with the default compact view, and after a terminal state call `cursor_status(task_id, detail="result")` to retrieve the raw complete reply and record receipt. It has no JSON wrapper: check `isError` before treating its content as a reply. Use `detail="full"` only when the diagnostic task detail is also needed. Repeating either explicit read returns the same retained result. `cursor_do(background=false)` is synchronous and still returns the complete result body.
- `cursor_task_control` returns only its action and compact task state, never a result body. After a terminal recovery action, retrieve the normal reply with `cursor_status(task_id, detail="result")`; use `detail="full"` for diagnostics.
- `session_mode=isolated` remains the default. Use `session_mode=create` only when later turns must keep the same Cursor context; continue through the returned stable `session_id` with `session_mode=continue`.
- Every continued turn receives a new `task_id` and must repeat `read_only=true` or an `allowed_paths` subset. Persistent sessions require `parallel_agent`, allow one active turn, and never downgrade to FIFO.
- `cursor_status(session_id)` inspects the durable association. `cursor_session_control(action=close)` ends Bridge continuity without stopping Cursor; an already-closed mapping may be removed with `action=forget, confirm=true`.
- After an interrupted adapter, `cursor_session_control(action=reconcile)` checks the exact Agent twice and never resends. `abandon` is an explicitly acknowledged last resort when stop evidence cannot be recovered.
- After reconciliation confirms completion, use `cursor_session_control(action=collect_result)` before continuing to retrieve that turn's complete reply. It always returns the full reply, restores the previous Agent selection, never sends a prompt, and never persists the reply. A changed epoch invalidates collection; repeating a successful collection returns `already_collected`. Numeric reply signatures and read receipts cover restart recovery, including completion before the first read. Older continuation turns without a saved signature require manual inspection.
- Up to 50 task records are retained. Unread replies are protected: `TASK_RETENTION_FULL` rejects new submissions instead of dropping them. For each ID in `cursor_status().unreadResultTaskIds`, call `cursor_status(task_id, detail="result")`; compact status calls do not record receipt, while either explicit result or full read makes the record eligible for eviction.
- `timeout_ms` is one post-submission monitoring budget shared by FIFO and automatic recovery. Expiry does not cancel Cursor; explicit `reap` may grant a fresh monitoring budget.
- If the AI client supplies no workspace identity, every new adapter requires `cursor_init` to confirm the intended project before submission, whether or not a shared `default` path was saved. `initialized=true` does not by itself confirm a request's target. Identity-scoped bindings retain their normal restart behavior. Supply `workspace_path` on each request when the intended path is known.
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

For a generic MCP-capable AI client, prefer the [AI install playbook](./docs/ai-install.md). The commands below are for local development.

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

- [LINUX DO](https://linux.do)

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/main/assets/star-history.svg?v=5ad31826af84)](https://github.com/Vanyangyang/cursor-bridge)
