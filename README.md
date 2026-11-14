<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/main"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center">If Cursor Bridge helps your workflow, star the repo.</p>

<p align="center"><sub><strong>Compatibility:</strong> Cursor Bridge tracks the latest Cursor releases. For older Cursor releases, check <a href="./COMPATIBILITY.md">compatibility and update history</a> and switch to an archived release if one matches; archived releases receive no further updates.</sub></p>

# Cursor Bridge

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Compatibility](./COMPATIBILITY.md) · [AI install](./docs/ai-install.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

> [!WARNING]
> **Windows primary support:** Cursor Bridge's live-tested runtime and end-to-end acceptance target **Windows**. macOS and Linux have unit and protocol smoke coverage (`macos-basic` CI) for CLI/MCP paths, not full live OS acceptance.

Cursor Bridge connects your coding agent (**Codex**, **Claude Code**, **Grok Build**, **Pi**, or any MCP-capable host) to **Cursor Context Engine (CCE)**—and optionally to bounded `cursor_do` Agent tasks—with verifiable `path:line` evidence.

Starting in **Cursor Bridge 7.0.0**, **CCE CLI (`cli`)** is the **primary maintenance route and fresh-install default**. Existing saved `cce-source.json` selections are preserved intact across upgrades, while upgrades without an existing `cce-source.json` (such as migrating from 6.0.x or never running `/cce` before) adopt `cli` by default; Cursor IDE/Agents over CDP (`ide`) remains available as an explicit fallback source. See [Migrating from 6.x to 7.0.0](#migrate-to-7-0) for exact CLI download and required configuration steps.

> [!IMPORTANT]
> **One-time Windows migration:** If the installed Cursor Bridge version is 5.3.6 or earlier, save your work before the first upgrade to 5.4.0 or any later release, then follow [Update an existing installation](#windows-update-migration) to clean up old-cache processes once. Later updates use the normal flow.

## What changed in 7.0.0

- **CCE CLI is now the primary route and fresh-install default (`cli`):** No Cursor IDE window needs to be launched for CCE queries. Existing upgrades never overwrite a previously saved `cce-source.json`, while upgrades without one adopt `cli` automatically.
- **High-speed isolated CLI pipeline:**
  - **Private MCP isolation (`CURSOR_DATA_DIR` / `mcp-disabled.json`):** Disables external/host MCP startup overhead inside CCE CLI child processes (set `CURSOR_BRIDGE_CCE_CLI_MCP=native` to opt out).
  - **Cached official preflight (`CURSOR_BRIDGE_CLI_INSPECT_TTL_MS=300000`):** Deduplicates concurrent CLI metadata inspections and invalidates automatically on launcher/identity/model/source changes or errors.
  - **Warm persistent single-root ACP sessions (`cursor-cli-acp.mjs`):** Reuses an authenticated Ask-mode ACP session with strict two-step model/effort/fast/`mode="ask"` read-back checks before sending prompts, cleanly falling back to `--print` on cold starts or capability mismatches before dispatch.
  - **Independent concurrency lane (`CURSOR_BRIDGE_CCE_CLI_CONCURRENCY=3`):** Runs up to 3 CLI CCE queries concurrently without blocking IDE FIFO locks.
- **Reliable CLI diagnostics and recoverable initialization:**
  - `cursor_cce(action="doctor")` / `/cce doctor` runs non-mutating launcher, auth/models, explicit model selection, local provider preload, and workspace readiness checks.
  - `cursor_init` in CLI mode validates launcher + model readiness upfront and returns structured recoverable states (`cli-unavailable`, `cli-auth-required`, `cli-model-required` with `availableModelsSample`, `cli-model-unavailable`, `cli-provider-unavailable`) with actionable `nextStep` instead of leaving opaque failures.
- **Hardened installation & CI verification (`npm run verify`):** Deterministic `scripts/verify-install.mjs`, end-to-end stdio CLI/ACP smoke (`npm run smoke:cli`), bundle freshness verification, and fail-closed `CURSOR_EXE` isolation in tests so offline test runs never spawn your desktop Cursor instance.

<a id="migrate-to-7-0"></a>

## Migrating from 6.x to 7.0.0 (Cursor CLI download & required setup)

### Who needs to migrate and how to keep IDE

- **Fresh installs and 6.x upgrades without an existing `cce-source.json`:** Starting in 7.0.0, CCE defaults to `cli` (Cursor Agent CLI). Complete the 3 steps below to install/sign in to Cursor CLI and configure your named model. If you only want desktop Cursor IDE/Agents for now, run `/cce ide` once (or `cursor_cce(action="set", source="ide")`) after upgrading to persist `ide` in `%APPDATA%\cursor-bridge\cce-source.json`.
- **Upgrades with an existing `%APPDATA%\cursor-bridge\cce-source.json`:** Your saved choice (`cli` or `ide`) is preserved across upgrades. If you used early 6.1/6.2 `cli`, run `/cce doctor` once after updating to verify launcher, auth, and model selection.

### Step 1: Download and install the official Cursor CLI (`cursor-agent`)

Run the official installer in a **new terminal**:

- **Windows PowerShell:**

```powershell
irm 'https://cursor.com/install?win32=true' | iex
```

- **macOS / Linux:**

```bash
curl https://cursor.com/install -fsS | bash
```

Reopen your terminal (and restart your AI client so `PATH` refreshes), then verify:

```powershell
cursor-agent --version
```

> On Windows the installer places the CLI under `%LOCALAPPDATA%\cursor-agent` by default. Cursor Bridge probes `%LOCALAPPDATA%\cursor-agent`, `%USERPROFILE%\.local\bin`, `%APPDATA%\cursor-agent`, and `PATH` automatically, or you can pin an absolute launcher path with `CURSOR_BRIDGE_CLI_PATH`.

### Step 2: Sign in and inspect available models

```powershell
cursor-agent login
cursor-agent status
cursor-agent models
```

- Complete authentication in the prompt/browser. For non-interactive environments, export `CURSOR_API_KEY` (or see [`docs/cce-cli-provider.md`](./docs/cce-cli-provider.md) for the experimental own-key `agent-local` Responses route).
- Confirm `cursor-agent models` prints explicit named model variants (such as `grok-4.6-medium-fast`).

### Step 3: Required Cursor Bridge configuration (`cursor_model`, doctor, and init)

1. **Set an explicit named model and effort (`Auto` and `default` are rejected):**
   Run `cursor_model(action="set", target="cce", model="grok-4.6-fast", effort="medium")` (or another named model/effort shown by `cursor-agent models`; persisted in `%APPDATA%\cursor-bridge\model-preferences.json`).
2. **Run `/cce doctor`:**
   Execute `/cce doctor` or `cursor_cce(action="doctor")` and confirm `ready: true` / `status: "ready"`.
3. **Initialize your project workspace:**
   Run `cursor_init(path="C:\\absolute\\path\\to\\project")` to persist the workspace binding and start background Ask-mode ACP warmup.

> [!TIP]
> To return CCE to desktop Cursor IDE (`ide`), or when delegating edits through desktop `cursor_do`, run `/cce ide` (`cursor_cce(action="set", source="ide")`). Both sources share your workspace binding and `cursor_model` defaults across restarts.

## What is CCE?

Cursor Context Engine (CCE) exposes Cursor's project index, semantic retrieval, exact search, reference tracing, and Agent exploration over MCP. Ask a project architecture or ownership question once; Bridge returns compact `path:line` evidence (`CCE_SEARCH_RESULT`), separating verified call chains from similarity or gaps instead of dumping raw search noise into your main Agent context.

CCE and `cursor_do` also accept optional `request_context` (`{"sender":"model","source":"mixed"}`) to record whether the prompt originated from the user or the driving model. Cursor Bridge does not bypass or manage your Cursor subscription; billing, quotas, and BYOK settings stay inside your signed-in Cursor CLI/account or your explicit local `cli_provider`.

> [!NOTE]
> **Historical IDE/Agents acceptance & current pairing:** The last full IDE CDP acceptance remains **Windows 11 + Cursor 3.23.12** (**Grok 4.7/high**, verified across **IDE and Agents Window**, `minimal` and `normal` runtime modes). See [Compatibility and update history](./COMPATIBILITY.md) and the [patch verification scope](./docs/cursor-6.0.8-model-picker-verification.md) for scoped details and evidence boundaries.

## Quick start

> [!IMPORTANT]
> **Prerequisite for the default `cli` route:** Install Cursor CLI in PowerShell with `irm 'https://cursor.com/install?win32=true' | iex` and run `cursor-agent login` (full guide: [Migrating from 6.x to 7.0.0](#migrate-to-7-0)). Prefer desktop Cursor IDE without CLI? Switch persistently with `/cce ide` after installing the plugin.

### 1. Install Cursor Bridge in your AI client

Commands are grouped by the AI client you already chat with:

#### Codex (recommended)

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref main
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge
```

(`grok plugin install Vanyangyang/cursor-bridge --trust` also works directly.)

#### Pi

```bash
pi install npm:pi-cursor-bridge
```

<a id="other-mcp-hosts"></a>

#### Other MCP-capable AI clients

Give this prompt to the AI client you are already using:

```text
Read https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.md completely. Install Cursor Bridge into this AI client. Follow every step. Report against the completion standard at the end. Use only the dedicated generic npm package named in the playbook. Do not invent a marketplace plugin, do not use a Pi package, and do not publish anything.
```

The playbook routes Codex, Claude Code, Grok, and Pi back to their first-class marketplace commands, and instructs any other MCP host to install `vanyangyang-cursor-bridge` into `%LOCALAPPDATA%\cursor-bridge\npm`. It tells the AI client where the bundle and skills landed so this AI client can register them, restart, and initialize the workspace. I do not treat that path as a first-class client and have not live-tested it.

### 2. Restart or reload your AI client

Restart Codex and start a new task, restart Claude Code or run `/reload-plugins`, reload Grok via `/plugins` or a new session, restart Pi, or restart your generic MCP host. Open sessions do not hot-load newly installed MCP tools or skills.

### 3. Configure explicit CCE model, check CLI readiness, and initialize your workspace

Account CLI requires an explicit named model and reasoning effort (`Auto` and `default` are rejected rather than silently selected). Tell your agent or set it once persistently:

```text
Set my CCE default model to grok-4.6-fast with medium effort, verify with /cce doctor, and initialize CCE workspace to C:\absolute\path\to\project
```

- **Pi** automatically binds the directory where Pi was started; pass a new absolute path whenever you want to switch workspaces.
- **If `cursor_init` returns `ready: false` (`cli-unavailable`, `cli-auth-required`, `cli-model-required`, `cli-model-unavailable`, or `cli-provider-unavailable`):** Your workspace binding is still saved (`bindingPersisted: true`), and the response includes `errorCode`, `availableModelsSample` (when available), and the exact `nextStep`. Fix the prerequisite (for example `cursor-agent login` or `cursor_model`) and re-run `cursor_init` or `/cce doctor`. To switch back to Cursor IDE/Agents instead, run `/cce ide`.

### 4. Ask a real project question

```text
Who owns this state, and what is the complete path from save loading to runtime use and save write-back?
```

> [!TIP]
> **Recommended on Windows 11: minimal runtime (when using IDE/Agents or `cursor_do`)**
>
> When routing CCE through `ide` or running `cursor_do`, say “Switch CCE to minimal mode.” Cursor, its project index, Agent DOM, and task queue keep running in the background while top-level Windows windows stay hidden. Cursor 3.23.12 hidden CCE is verified in both UI types; hidden mode verifies the current model and effort (change them in `normal` mode first if the chat uses `Auto`).
>
> **Trade-off:** while minimal mode is active, manually opening Cursor reuses the guarded single-instance process and stays hidden. When you need the Cursor UI again, say “Switch CCE to normal mode.”

## Compatibility

See [Compatibility and update history](./COMPATIBILITY.md) and [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) for current compatibility pairings, evidence scopes, and archived versions.

First-class live-tested AI clients are **Codex**, **Claude Code**, **Grok Build**, and **Pi**. Generic MCP hosts use [`docs/ai-install.md`](./docs/ai-install.md) (`docs/ai-install.md`) without first-class marketplace updates.

## Choose and diagnose the CCE source

Fresh installations default to **`cli`** (Cursor Agent CLI). Existing `cce-source.json` preferences are preserved intact on upgrade. Neither source silently falls back to the other on failure.

| Command / Call | Effect |
|---|---|
| `/cce cli` · `cursor_cce(action="set", source="cli")` | Use local Cursor Agent CLI (fresh-install default). |
| `/cce ide` · `cursor_cce(action="set", source="ide")` | Use Cursor IDE/Agents via CDP. |
| `/cce doctor` · `cursor_cce(action="doctor")` | Non-mutating readiness check (launcher, auth/models, `cursor_model`, preload, ACP, workspace). |
| `/cce` · `cursor_cce(action="show")` | Show the saved source, config file path, and optional `cli_provider` summary. |

Hosts may namespace slash commands (for example `/cursor-bridge:cce doctor`), and the packaged `cce` skill supports the same requests in natural language. Both sources share `workspace_path` verification, `cursor_model` defaults, and `CCE_SEARCH_RESULT` formatting:

- **Account CLI (default on `cli`):** Uses signed-in `cursor-agent` / `agent` in Read-Only Ask mode. Single-root workspaces prewarm and reuse a persistent ACP session after strict parameterized config read-back checks; cold starts, capability mismatches, `CURSOR_BRIDGE_CCE_CLI_ACP=off`, and multi-root `.code-workspace` targets use one-shot `--print`. Up to `3` CLI CCE tasks run concurrently (`CURSOR_BRIDGE_CCE_CLI_CONCURRENCY`), independent of IDE UI locks.
- **Own-key CLI (`agent-local`):** Optional configuration via `cursor_cce(action="set", source="cli", cli_provider={kind:"openai-responses", node_path, entrypoint, base_url, api_key_file})`. Uses Cursor's official `agent-local` build with an adjacent preload helper (prechecked before dispatch) and reads your API key directly from the local credential file—never paste secrets into prompts or MCP arguments. Switching `/cce ide` and `/cce cli` preserves `cli_provider` (`cli_provider=null` clears it). See [`docs/cce-cli-provider.md`](./docs/cce-cli-provider.md).
- **Cursor IDE / Agents (`ide`):** Requires Cursor desktop UI (with optional `minimal` mode on Windows 11). Required if you use `cursor_do` delegation (`CURSOR_BRIDGE_DELEGATION=on`).

## MCP tools

| Tool | What it does |
|---|---|
| `cursor_init` | Persists the workspace binding and verifies CLI/model readiness (`cli`) or CDP connectivity (`ide`). Returns structured recoverable status if CLI setup is incomplete. |
| `cursor_context_engine` | Read-only project understanding from one natural-language `query`; supports `workspace_path` assertion. |
| `cursor_do` | Submits a bounded Cursor Agent task via IDE/Agents (disabled/hidden when `CURSOR_BRIDGE_DELEGATION=off`). Background mode returns a compact receipt; collect full reply via `cursor_status(task_id, detail="result")`. |
| `cursor_model` | Shows, sets, or resets persistent model and effort defaults independently for `cce`, `cursor_do`, or `both`. |
| `cursor_cce` | `show`, `set` (`cli` / `ide`, optional `cli_provider`), or `doctor` (read-only CLI/model/workspace readiness diagnostic). |
| `cursor_status` | Compact by default; reports CLI metadata/concurrency or CDP connection, workspace binding, runtime/model defaults, and tasks (`detail="result"` or `detail="full"`). |
| `cursor_runtime` | Switches IDE presentation between `normal` and Windows 11-tested `minimal` mode. |
| `cursor_task_control` | Targeted `reap`, `cancel`, or explicitly acknowledged `abandon` recovery. |

Pass `workspace_path` on `cursor_context_engine` and `cursor_do` whenever your host knows the target project directory. On pre-send `WORKSPACE_CONFIRMATION_REQUIRED`, `WORKSPACE_INITIALIZATION_REQUIRED`, or `WORKSPACE_MISMATCH`, verify `cursor_status` is idle, run `cursor_init` for the intended path, verify `ready`, and retry once.

> [!WARNING]
> Cursor is an Agent, not an OS filesystem sandbox. CCE enforces Ask mode in ACP and strongly prompts read-only investigation, but consequential anchors and edits should always be verified locally.

## Reliability and verification

For local validation or after modifying source code or bundles:

```bash
npm run build           # Rebuild all 5 committed ESM bundles (Bridge, preload, supervisor, Grok companion)
npm test                # Run isolated test suite (scripts/test.mjs strips host CURSOR_BRIDGE_* env pollution)
npm run smoke:mcp       # Real stdio MCP protocol & admission gate smoke test (cache-shaped cwd)
npm run smoke:cli       # End-to-end CLI init, doctor, model verification & ACP smoke test (fake CLI harness)
npm run verify:install  # Validate bundle manifests, versions, supervisor materialization, and staged npm/Pi bundles
npm run verify          # Run the full build + test + smoke:mcp + smoke:cli + verify:install pipeline
```

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

Other MCP-capable AI clients: ask the current AI to re-read the [AI install playbook](./docs/ai-install.md) and update `vanyangyang-cursor-bridge` to the version pinned in [`docs/ai-install.manifest.json`](./docs/ai-install.manifest.json), then restart this AI client.

After updating, start a new Codex task, restart Claude Code or run `/reload-plugins`, reload Grok through `/plugins` or start a new Grok session, restart Pi, or restart the current AI client.

> [!NOTE]
> **Upgrading from 6.x to 7.0.0:** If no `%APPDATA%\cursor-bridge\cce-source.json` was saved previously, 7.0.0 activates `cli` automatically. Follow [Migrating from 6.x to 7.0.0](#migrate-to-7-0) to install/log in to Cursor CLI, set `cursor_model`, and run `/cce doctor`—or run `/cce ide` once to stay on desktop IDE.

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

`query` carries one focused natural-language project question; optional `workspace_path` asserts the target project before admission.

```text
CCE_SEARCH_RESULT
intent: <normalized intent>
coverage: <focused|extended> | <why this depth was sufficient>
evidence:
- path/to/file.ts:42-67 | symbolOrAnchor | verified relevance or relationship | reference
gaps: none
confidence: high
```

The installed `cce-routing` skill routes unfamiliar architectural or cross-module questions to CCE while keeping known-file reads, builds, tests, logs, and Git commands on native tools.

</details>

<details>
<summary><strong>Workspace, Cursor UI, and IDE lifecycle behavior (`ide` / `cursor_do`)</strong></summary>

- Multiple MCP adapters share one user-level lifecycle supervisor materialized into `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\`, keeping CDP connection management outside versioned plugin caches.
- In `ide` mode or `cursor_do`, Bridge prefers an open Agents Window for the matching repository and falls back to workbench without creating work in `Home`.
- If Cursor is already running without `--remote-debugging-port`, `cursor_init` preserves the workspace binding and returns `close_cursor_and_retry` instead of force-killing Cursor.
- Full session/recovery contracts live in [`docs/CURSOR_SESSION_CONTRACT.md`](./docs/CURSOR_SESSION_CONTRACT.md).

</details>

<details>
<summary><strong>Environment variables and source overrides</strong></summary>

| Variable | Default | Description |
|---|---|---|
| `CURSOR_BRIDGE_CLI_PATH` | auto-discovered | Absolute path to `cursor-agent` / `agent` launcher. |
| `CURSOR_BRIDGE_CLI_INSPECT_TTL_MS` | `300000` | Official CLI preflight cache TTL in ms (`0` disables caching). |
| `CURSOR_BRIDGE_CCE_CLI_MCP` | unset (`isolated`) | Set to `native` to disable private `CURSOR_DATA_DIR` MCP isolation. |
| `CURSOR_BRIDGE_CCE_CLI_ACP` | `on` | Set to `off` to disable persistent ACP sessions and use one-shot `--print`. |
| `CURSOR_BRIDGE_CCE_CLI_ACP_IDLE_MS` | `900000` | Idle recycle timeout in ms for warm ACP processes. |
| `CURSOR_BRIDGE_CCE_CLI_ACP_MAX_AGE_MS` | `3600000` | Maximum lifetime in ms before rotating a warm ACP process. |
| `CURSOR_BRIDGE_CCE_CLI_ACP_FAIL_TTL_MS` | `300000` | Capability-failure cache TTL in ms per CLI identity (`0` disables). |
| `CURSOR_BRIDGE_CCE_CLI_CONCURRENCY` | `3` | Concurrent execution slots on the CLI CCE lane (`1`–`8`). |
| `CURSOR_BRIDGE_DELEGATION` | `on` | Set to `off` to disable and hide `cursor_do`. |
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor IDE remote-debugging port (`ide` / `cursor_do`). |
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | Search timeout in milliseconds. |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | unset | Set to `1` to skip IDE startup prewarming. |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | Initial IDE window mode (`normal` or `minimal`). |
| `CURSOR_EXE` | auto-detected | Override Cursor IDE executable path (fails closed if set to a missing path). |

</details>

<details>
<summary><strong>Companion plugin: Grok Build Supervisor (maintenance-only)</strong></summary>

This repository also still contains the standalone **Grok Build Supervisor** plugin (`0.4.3`) in maintenance-only mode. Existing packages (`grok-build-supervisor`, `pi-grok-build-supervisor`, `vanyangyang-grok-build-supervisor`) remain intact so existing setups keep working, while active development prioritizes Cursor Bridge and CCE CLI.

See the companion documentation if you already use it: [English](./plugins/grok-build-supervisor/README.md) · [简体中文](./plugins/grok-build-supervisor/README.zh-CN.md).

</details>

## Friends

- [LINUX DO](https://linux.do)

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/main/assets/star-history.svg?v=78d133dcb77a)](https://github.com/Vanyangyang/cursor-bridge)
