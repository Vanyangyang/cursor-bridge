<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/main"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center"><sub><strong>Compatibility:</strong> Cursor Bridge tracks the latest Cursor releases; archived pairings live in <a href="./COMPATIBILITY.md">compatibility history</a>.</sub></p>

# Cursor Bridge

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Compatibility](./COMPATIBILITY.md) · [AI install](./docs/ai-install.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases) [![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge) [![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

> [!WARNING]
> **Windows primary support:** Live-tested runtime and end-to-end acceptance target **Windows**. macOS and Linux have unit and protocol smoke coverage (`macos-basic` CI) for CLI/MCP paths, not full live OS acceptance.

Cursor Bridge connects your coding agent (**Codex**, **Claude Code**, **Grok Build**, **Pi**, **AGY / Antigravity**, or any MCP-capable host) to **Cursor Context Engine (CCE)**—and optionally to bounded `cursor_do` Agent tasks—returning compact verified `path:line` evidence (`CCE_SEARCH_RESULT`) without flooding main context or touching Cursor billing.

Starting in **7.0.0**, **CCE CLI (`cli`)** is the **primary maintenance route and fresh-install default** (existing saved `cce-source.json` selections stay intact; desktop IDE over CDP remains selectable via `/cce ide`). Warm Ask-mode ACP sessions cut single-query latency to **19.8s** (vs. 42.9–45.3s in 6.2.0, **2.2x faster**) and 3-query concurrent wall-clock to **30.4s** (vs. 82.6s serial sum). Setup & CLI download: [Migrating from 6.x to 7.0.0](#migrate-to-7-0).

> [!IMPORTANT]
> **One-time Windows migration:** If the installed Cursor Bridge version is 5.3.6 or earlier, save your work before the first upgrade to 5.4.0 or any later release, then follow [Update Cursor Bridge](#windows-update-migration) to clean up old-cache processes once.

## Why CLI-first CCE?

Moving to **CCE CLI (`cli`)** as the primary route is driven by **time efficiency**: our focus is an across-the-board upgrade to the CCE retrieval experience while **gradually fading out peripheral features**—heavy desktop IDE/CDP window coupling (`/cce ide` stays an opt-in fallback), `cursor_do` task delegation (disableable via `CURSOR_BRIDGE_DELEGATION=off`), and companion plugins in maintenance-only mode.

What prompted this decision is low native tool-use efficiency in many current coding agents—**especially AGY (Antigravity)**—where low `read_file` hit rate, wrong-file detours, and whole-file dumps rapidly stuff the context window on unfamiliar codebases:

| Measured project benchmark | Native `read_file` / pre-7.0.0 cost | With 7.0.0 CCE CLI (`cli`) |
|---|---|---|
| **AGY 447-step coding session** (19-file, +328 / -70 line diff) | Blindly pre-read **20+ unrelated files** before editing (1st compaction at step 59); **60 / 67 (90%)** batch reads overflowed inline caps; **93 `read_file` calls** dumped **2.73M of 3.51M total chars (~78% waste)** into context, triggering **5 compactions** and **6–11x re-reads** of the same 24–59 KB files | **1 `cursor_context_engine` call** returns **~1–2 KB** of verified `path:line` anchors (`CCE_SEARCH_RESULT`), followed only by targeted line-range reads |
| **AGY 4-child + parent blind audit** & **360+ step 0-CCE run** | When pre-7.0.0 CCE hit 180s host MCP timeouts in 3 / 4 rounds, local fallback issued **172 child (~1.63M chars) + 134 parent (~1.14M chars) `read_file` calls**; disk I/O took **14–17s**, while **254K–263K token** prompts consumed **8.6–14.2 min** per child and up to **220–265s** per model step (a 360+ step 0-CCE run likewise chained blind `read_file` hops past **260K tokens**) | Sub-20s CLI turnaround avoids 180s host MCP timeouts and stops blind `import`-hopping before context bloat starts |
| **Windows CCE CLI speed** (`grok-4.6-fast`, `medium` effort) | 6.2.0 `--print` paid **~21s** pre-dispatch shell/MCP overhead (**42.9–45.3s** single query; **82.6s** serial sum for 3 queries) | Warm Ask-mode ACP + private `CURSOR_DATA_DIR` + preflight cache cut pre-dispatch overhead to **0.0–0.2s**: **19.8s** single query (**~2.2x faster**) and **30.4s** wall-clock across 3 concurrent queries (**~2.7x throughput**) |

Pairing CCE CLI with **AGY** and similar agents replaces dozens of low-hit-rate `read_file` guesses and multi-megabyte context reloads with one ~20s semantic lookup plus exact line-bounded verification—delivering a major upgrade in localization accuracy, turn speed, and context cleanliness.

<a id="migrate-to-7-0"></a>

## Cursor CLI setup & 6.x → 7.0.0 migration

Upgrades keep any existing `%APPDATA%\cursor-bridge\cce-source.json`; upgrades without one switch to `cli` by default (run `/cce ide` once to keep desktop IDE/Agents).

1. **Install Cursor CLI** in a new terminal (`irm 'https://cursor.com/install?win32=true' | iex` on Windows PowerShell, or `curl https://cursor.com/install -fsS | bash` on macOS/Linux), reopen your terminal/client so `PATH` refreshes, and confirm `cursor-agent --version` (override path with `CURSOR_BRIDGE_CLI_PATH`).
2. **Sign in & inspect models:** `cursor-agent login`, `cursor-agent status`, `cursor-agent models` (use `CURSOR_API_KEY` for headless auth, or see [`docs/cce-cli-provider.md`](./docs/cce-cli-provider.md) for own-key `agent-local`).
3. **Configure model, doctor & workspace** in your client (`Auto`/`default` are rejected): `cursor_model(action="set", target="cce", model="grok-4.6-fast", effort="medium")` → `/cce doctor` (`cursor_cce(action="doctor")`) → `cursor_init(path="C:\\absolute\\path\\to\\project")`.

## Quick start

### 1. Install Cursor Bridge in your AI client

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
grok plugin install cursor-bridge@vanyangyang --trust
grok plugin enable cursor-bridge
```

#### Pi

```bash
pi install npm:pi-cursor-bridge
```

<a id="other-mcp-hosts"></a>

#### Other MCP-capable AI clients

Send this prompt to your MCP host:

```text
Read https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.md completely. Install Cursor Bridge into this AI client. Follow every step. Report against the completion standard at the end. Use only the dedicated generic npm package named in the playbook. Do not invent a marketplace plugin, do not use a Pi package, and do not publish anything.
```

That playbook routes first-class hosts back to their marketplace commands and directs other hosts to install `vanyangyang-cursor-bridge` into `%LOCALAPPDATA%\cursor-bridge\npm` so this AI client can register them, restart, and initialize the workspace; I do not treat that path as a first-class client or live-test it.

### 2. Restart or reload your AI client

Restart Codex and start a new task, restart Claude Code or run `/reload-plugins`, reload Grok via `/plugins` or a new session, restart Pi, or restart your generic MCP host.

### 3. Configure explicit CCE model, check CLI readiness, and initialize your workspace

```text
Set my CCE default model to grok-4.6-fast with medium effort, verify with /cce doctor, and initialize CCE workspace to C:\absolute\path\to\project
```

- **Pi** binds its startup directory automatically; pass another absolute path to switch repositories.
- **If `cursor_init` returns `ready: false`** (`cli-unavailable`, `cli-auth-required`, `cli-model-required` with `availableModelsSample`, `cli-model-unavailable`, `cli-provider-unavailable`), the binding is still saved (`bindingPersisted: true`) with an actionable `nextStep`; complete login/model setup and re-run `cursor_init` or `/cce doctor` (or run `/cce ide` to stay on desktop IDE).

### 4. Ask a real project question

```text
Who owns this state, and what is the complete path from save loading to runtime use and save write-back?
```

> [!TIP]
> **Recommended on Windows 11: minimal runtime** (when using `ide` or `cursor_do`): say “Switch CCE to minimal mode.” Cursor keeps running in the background while top-level windows stay hidden; manually opening Cursor reuses the hidden instance—say “Switch CCE to normal mode” to restore UI (verified on Cursor 3.23.12; change `Auto` model/effort in `normal` mode first).

## Compatibility

First-class live-tested clients are **Codex**, **Claude Code**, **Grok Build**, and **Pi**; other MCP hosts follow [`docs/ai-install.md`](./docs/ai-install.md). Last full desktop IDE CDP acceptance covered **Windows 11 + Cursor 3.23.12** (**Grok 4.7/high**, **IDE and Agents Window**, `minimal` and `normal` modes). See [Compatibility history](./COMPATIBILITY.md) and [patch verification scope](./docs/cursor-6.0.8-model-picker-verification.md).

## CCE sources & MCP tools

| Command / Call | Effect |
|---|---|
| `/cce cli` · `cursor_cce(action="set", source="cli")` | Use local Cursor Agent CLI (fresh-install default, 3-slot concurrent lane, ACP + `--print` fallback). |
| `/cce ide` · `cursor_cce(action="set", source="ide")` | Use desktop Cursor IDE/Agents via CDP (also required for `cursor_do`). |
| `/cce doctor` · `cursor_cce(action="doctor")` | Non-mutating check covering launcher, auth/models, `cursor_model`, preload, ACP, and workspace. |
| `/cce` · `cursor_cce(action="show")` | Show active source, config file path, and optional own-key `cli_provider` summary ([setup](./docs/cce-cli-provider.md)). |

| Tool | Role |
|---|---|
| `cursor_init` | Bind workspace and verify CLI/model (`cli`) or CDP (`ide`) readiness. |
| `cursor_context_engine` | Read-only semantic search (`query`, `workspace_path`, optional `request_context`). |
| `cursor_do` | Submit bounded Cursor Agent task via IDE/Agents (hidden if `CURSOR_BRIDGE_DELEGATION=off`; collect via `cursor_status`). |
| `cursor_model` | Show, set, or reset persistent model/effort for `cce`, `cursor_do`, or `both`. |
| `cursor_cce` | `show`, `set` (`cli`/`ide`, `cli_provider`), or `doctor`. |
| `cursor_status` | Compact status by default (`detail="result"` or `"full"` for task output). |
| `cursor_runtime` | Toggle IDE mode between `normal` and `minimal`. |
| `cursor_task_control` | `reap`, `cancel`, or explicit `abandon` recovery. |

Pass `workspace_path` when known (on `WORKSPACE_CONFIRMATION_REQUIRED` / `WORKSPACE_INITIALIZATION_REQUIRED` / `WORKSPACE_MISMATCH`, check idle status and run `cursor_init`). Cursor is an Agent, not an OS sandbox—ACP enforces Ask mode, and callers should still verify returned citations locally.

<a id="windows-update-migration"></a>

## Update Cursor Bridge

```bash
# Codex (run `codex plugin marketplace add Vanyangyang/cursor-bridge --ref main` first if unconfigured)
codex plugin marketplace upgrade vanyangyang && codex plugin add cursor-bridge@vanyangyang

# Claude Code
claude plugin marketplace update vanyangyang && claude plugin update cursor-bridge@vanyangyang

# Grok Build
grok plugin marketplace update cursor-bridge && grok plugin update cursor-bridge

# Pi
pi update npm:pi-cursor-bridge
```

Other MCP hosts: ask the AI to update `vanyangyang-cursor-bridge` per [`docs/ai-install.md`](./docs/ai-install.md) and [`docs/ai-install.manifest.json`](./docs/ai-install.manifest.json). After updating, start a new Codex task, reload Claude Code (`/reload-plugins`) or Grok (`/plugins`), restart Pi, or restart your MCP host.

<a id="one-time-windows-migration"></a>

### One-time Windows migration from Cursor Bridge 5.3.6 or earlier

Only needed when upgrading from **5.3.6 or earlier** (5.4.0+ skips this step because adapters share the user-level lifecycle runtime outside plugin caches).

**Recommended: copy this to your local coding Agent:** “I saved my work. First check the installed Cursor Bridge version. Only if it is 5.3.6 or earlier, inspect processes whose command lines load `cursor-lifecycle-supervisor.mjs` or `dist/cursor-bridge.mjs` from the AI client's versioned plugin cache. Treat every instance under `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` as the new persistent runtime and do not stop it. After verifying the exact old-cache path and ownership, stop only those old-cache processes without asking again; do not mass-stop Node or PowerShell, change ACLs, delete caches, or touch unrelated processes. The current task's old Cursor Bridge MCP may disconnect when its old adapter stops; that is expected. Then update Cursor Bridge to the latest version using the current AI client's normal marketplace command, reload the AI client, and report the installed version, marketplace source, and any old-cache process that remains.”

<details>
<summary><strong>CCE output format & IDE lifecycle contract</strong></summary>

- `cursor_context_engine` returns compact `CCE_SEARCH_RESULT` blocks (`intent`, `coverage`, `evidence` with `path:line` anchors, `gaps`, `confidence`); the `cce-routing` skill delegates unfamiliar project discovery while keeping known-file reads, builds, tests, logs, and Git on native tools.
- Multiple MCP adapters share `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` ([`docs/CURSOR_SESSION_CONTRACT.md`](./docs/CURSOR_SESSION_CONTRACT.md)); `ide` mode prefers the repo's Agents Window (never `Home`) and returns `close_cursor_and_retry` rather than killing Cursor if `--remote-debugging-port` is absent.

</details>

<details>
<summary><strong>Environment variables & verification commands</strong></summary>

```bash
npm run build           # Rebuild all 5 ESM bundles
npm test                # Isolated unit suite (scripts/test.mjs strips host CURSOR_BRIDGE_* env)
npm run smoke:mcp       # Real stdio MCP protocol & admission smoke
npm run smoke:cli       # End-to-end fake-CLI init -> doctor -> cursor_model -> ACP smoke
npm run verify:install  # Validate manifests, versions, supervisor materialization, and staged npm/Pi packages
npm run verify          # Full build + test + smoke:mcp + smoke:cli + verify:install pipeline
```

| Variable | Default | Description |
|---|---|---|
| `CURSOR_BRIDGE_CLI_PATH` | auto | Explicit path to `cursor-agent` / `agent` launcher. |
| `CURSOR_BRIDGE_CLI_INSPECT_TTL_MS` | `300000` | Official CLI preflight cache TTL ms (`0` disables). |
| `CURSOR_BRIDGE_CCE_CLI_MCP` | isolated | Set `native` to disable private `CURSOR_DATA_DIR` MCP isolation. |
| `CURSOR_BRIDGE_CCE_CLI_ACP` | `on` | Set `off` to disable persistent ACP sessions and use `--print`. |
| `CURSOR_BRIDGE_CCE_CLI_ACP_IDLE_MS` / `_MAX_AGE_MS` / `_FAIL_TTL_MS` | `900000` / `3600000` / `300000` | Warm ACP idle recycle, max lifetime, and failure cache TTL (ms). |
| `CURSOR_BRIDGE_CCE_CLI_CONCURRENCY` | `3` | Concurrent CLI CCE lane slots (1–8). |
| `CURSOR_BRIDGE_DELEGATION` | `on` | Set `off` to disable and hide `cursor_do`. |
| `CURSOR_BRIDGE_CDP_PORT` / `_TIMEOUT` / `_NO_AUTOLAUNCH` / `_RUNTIME_MODE` | `9223` / `300000` / unset / `normal` | IDE CDP port, query timeout (ms), skip autolaunch (`1`), and startup mode. |
| `CURSOR_EXE` | auto | Override Cursor IDE binary path (fails closed if missing). |

</details>

<details>
<summary><strong>Companion plugin: Grok Build Supervisor (maintenance-only)</strong></summary>

This repository also still contains the standalone **Grok Build Supervisor** plugin (`0.4.3`) in maintenance-only mode; active development prioritizes Cursor Bridge and CCE CLI. Docs: [English](./plugins/grok-build-supervisor/README.md) · [简体中文](./plugins/grok-build-supervisor/README.zh-CN.md).

</details>

## Friends & License

- [LINUX DO](https://linux.do) · [MIT License](./LICENSE)

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/main/assets/star-history.svg?v=29909232eb40)](https://github.com/Vanyangyang/cursor-bridge)
