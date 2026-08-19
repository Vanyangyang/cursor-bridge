# Grok Build Supervisor

[简体中文](./README.zh-CN.md) · [Repository overview](../../README.md)

**Let Codex or Claude Code plan, supervise, correct, and verify persistent Grok Build execution through MCP.**

Grok Build Supervisor is an independently installable plugin for Codex and Claude Code in the Cursor Bridge + Grok Build Supervisor repository. It opens or resumes a real Grok Build TUI in Windows Terminal, keeps a daemon-owned ACP connection alive across host tasks and plugin reloads, and gives the host agent a bounded control plane for progress, permissions, clarification, cancellation, and final evidence.

> [!NOTE]
> Live-tested on Windows 11 with Windows Terminal, PowerShell, and Grok Build 1.0.6. Other operating systems are not currently claimed as end-to-end supported.

## Install

Requirements:

- Codex or Claude Code with plugin support
- Node.js 20 or newer
- Grok Build installed and authenticated
- Windows Terminal with a PowerShell profile

Codex:

```powershell
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add grok-build-supervisor@vanyangyang
```

Claude Code:

```powershell
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install grok-build-supervisor@vanyangyang
```

Start a new Codex task, or restart Claude Code / run `/reload-plugins`, after installation or update. Skills and slash commands do not hot-load into an existing task.

Installing Grok Build Supervisor does not install or start Cursor Bridge.

## Use it

Initialize the user-level proxy setting once before opening the first session:

```text
/grok_init
```

The Supervisor checks current local proxy candidates first, then performs a bounded loopback listener scan only when necessary. It persists a port only after the endpoint completes an HTTP CONNECT probe; there is no fixed default port. If multiple proxies verify, select one explicitly:

```text
/grok_init http://127.0.0.1:<port>
```

The setting lives in the persistent Supervisor state root rather than the plugin cache. Re-run `/grok_init` when the local proxy port changes. Initialization never opens a TUI or sends a prompt, and it is refused while the Supervisor owns active work.

Create a guarded visible TUI in natural language:

```text
Create a new Grok TUI in this project.
```

The host agent can then send an authorized task through ACP and keep waiting until Grok completes, fails, asks for input, or requests an exact permission decision.

Visible Windows Terminal TUI is the default. ACP-only `presentation: none` is permitted only when the user explicitly asks for headless or invisible operation; the plugin requires a separate headless confirmation and never chooses it as a fallback.

### Task-local executor mode

Enable the explicit task-local mode:

```text
/grok_execute on
```

After it is enabled, ordinary implementation requests in that host task follow this role contract:

- The host agent plans, decomposes, supervises, corrects, and verifies.
- Grok performs implementation, mutating commands, builds, and tests.
- The host agent independently checks the resulting workspace evidence before accepting completion.

Disable it explicitly:

```text
/grok_execute off
```

Only the exact `on` and `off` forms change the task-local state. Enabling the mode does not itself open a TUI or send a task, and disabling it does not automatically cancel a running Grok prompt or stop the owned Leader.

## Control plane

```text
Host task(s)
      │ authenticated local Named Pipe
      ▼
Persistent Supervisor daemon
      ├─ owned Grok Leader
      ├─ long-lived ACP session
      ├─ bounded event journal
      └─ verified Windows Terminal TUI process
```

- The daemon survives an individual host frontend exiting or being replaced during a plugin update.
- Multiple host tasks may inspect the same session; a writer lease and fencing token keep one active writer.
- ACP continuously records progress, completion, permission, and clarification events. The host agent uses bounded interaction waits while its turn remains active.
- Operational polls coalesce routine events to one high-water cursor and suppress cumulative Grok prose while work is active. Raw message chunks become throttled activity metadata in the durable journal, and the final response is delivered only when completion is newer than the caller cursor, so advancing that cursor prevents repeated context ingestion.
- Completed responses over 4000 UTF-8 bytes are atomically stored under the persistent Supervisor state root. The host receives a path, byte size, SHA-256, truncation flag, and short summary instead of the long body. Context-mode may process that file when already installed, but it is neither bundled nor required; bounded local reading remains the fallback.
- Each MCP frontend carries its actual host identity in the authenticated daemon envelope, so Grok sees a Codex, Claude Code, or neutral host supervision contract matching the sender.
- TUI launcher files are content-addressed into the persistent Supervisor runtime directory before use; a plugin-cache refresh cannot remove the script underneath a live daemon.
- When a pre-capability daemon is still busy during an update, the new frontend keeps safe observation/control available but refuses new initialization, session opens, or a host-mislabeled prompt. Exit the visible TUI normally and retry so the daemon can roll forward.
- Windows Terminal is presentation only. Leader ownership, ACP, process fingerprints, and the active-session registry are the authority layer.

## Safety

- No `--yolo`, `--always-approve`, or silent permission selection.
- No keyboard simulation and no adoption or termination of unrelated Grok processes.
- No silent headless fallback; normal sessions always use a visible Windows Terminal TUI.
- No remote proxy, stored proxy credentials, fixed port, or TCP-listener-only acceptance; initialization requires a verified loopback HTTP CONNECT endpoint.
- No model-supplied host identity; the daemon trusts only the bounded identity attached by the MCP frontend.
- PID liveness alone is never ownership proof; rollback requires a matching durable process fingerprint.
- Grok completion text is an agent claim. The host agent must verify files, diffs, tests, and other requested evidence.
- The plugin does not broaden authorization for destructive commands, publication, external messages, secrets, or product decisions.

## Compatibility note

Some Grok builds print:

```text
warning: --subagents has no effect in leader mode (agent config is set at leader startup)
```

The plugin passes neither `--subagents` nor `--no-subagents`. The notice comes from Grok's default Leader-mode handling. It is intentionally not filtered because the fullscreen TUI requires native terminal handles; filtering stderr can stall rendering. Leader-scoped agent configuration remains the source of truth.

## Development

From this plugin directory:

```powershell
npm install
npm test
npm run smoke:mcp
```

The plugin is versioned, tested, and installed independently from Cursor Bridge even though both are published from the same repository marketplace.
