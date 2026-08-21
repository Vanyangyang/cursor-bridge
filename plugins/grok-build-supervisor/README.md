# Grok Build Supervisor

[简体中文](./README.zh-CN.md) · [Repository overview](../../README.md)

**Let Codex or Claude Code plan, supervise, correct, and verify persistent Grok Build execution through MCP.**

Grok Build Supervisor is a separate plugin for Codex and Claude Code. It opens or resumes a real Grok Build window in Windows Terminal and keeps the connection alive in the background, even when a host task ends or the plugin is reloaded. Codex or Claude Code can send work, follow its status, handle questions and permissions, cancel it, and check the final result.

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

## Update

> [!WARNING]
> **The first upgrade from Grok Build Supervisor 0.1.0 or earlier to 0.2.0 or any later release needs a one-time Windows cleanup.** Old plugin processes can keep a versioned cache directory open, which prevents Windows from replacing it. This is not an ACL problem and does not require deleting the plugin cache.

> [!TIP]
> **Recommended — copy this to your local coding Agent:** “I saved my work. Upgrade the installed Grok Build Supervisor plugin to the latest version currently available from its marketplace. Check its current version first; if it is 0.1.0 or earlier, inspect old-cache instances of `server.mjs`, `supervisor-daemon.mjs`, `tui-host.mjs`, or `Start-GrokTui.ps1`. After verifying ownership and the old-cache path, stop those processes without asking again; leave new persistent runtimes and unrelated processes alone. Do not mass-stop Node or PowerShell, change ACLs, or delete caches. Run the normal update and report the installed version, marketplace source, and any old-cache process that remains.”

After this migration, both the daemon and TUI run from persistent user state, so 0.2.0 and later releases use the normal update commands:

```powershell
# Codex
codex plugin marketplace upgrade vanyangyang
codex plugin add grok-build-supervisor@vanyangyang

# Claude Code
claude plugin marketplace update vanyangyang
claude plugin update grok-build-supervisor@vanyangyang
```

If Codex reports `marketplace 'vanyangyang' is not configured as a Git marketplace`, run `codex plugin marketplace add Vanyangyang/cursor-bridge --ref master` once, then retry the commands above. Start a new task or reload plugins afterward; the currently open task remains on its loaded version.

## Use it

The first time you use the plugin, initialize the local proxy once:

```text
/grok_init
```

The plugin first tries the local proxy settings already on your computer. If none works, it checks a limited set of local listening ports. It saves a choice only after proving that the proxy can actually carry an HTTPS connection; an open port by itself is not enough. There is no hard-coded default. If more than one proxy works, choose one:

```text
/grok_init http://127.0.0.1:<port>
```

The proxy choice is saved outside the plugin cache, so plugin updates do not erase it. Run `/grok_init` again if your proxy port changes. Initialization never opens Grok, chooses a project, or sends a task, and it will not change the proxy while Grok is busy.

Open the project you want to work on, then turn supervised execution on:

```text
/grok_execute on
```

At that moment Codex or Claude Code binds executor mode to the current project directory and immediately reuses or starts its visible Grok terminal. Activation does not send a coding task. When the terminal is ready, ask for work normally; the host sends the separately approved task and keeps watching until Grok finishes, fails, asks a question, or needs a permission decision. You do not manage the TUI, session ID, or process yourself.

The first time Grok sees a project containing local automation, its own terminal may ask whether you trust that directory. The Supervisor recognizes this exact screen, keeps the same terminal and session, and tells you to confirm there; do not run `/grok_execute on` again. It never presses `y` or adds `--trust` for you. After you answer in Grok, activation continues automatically.

The project binding lasts only for the current Codex or Claude Code task. Turning the mode off clears that binding but does not close the terminal or cancel work already in progress.

> [!TIP]
> `/grok_execute on` opens Grok in a visible Windows Terminal window by default. If this activation should be headless, say so before running `on`, for example: “Do not show the Grok terminal this time.” The plugin never hides the window unless you ask, and it does not quietly switch to background mode when a visible launch fails.

While the mode is on:

- Codex or Claude Code plans the work, breaks it down, watches it, corrects course, and checks the result.
- Grok performs implementation, mutating commands, builds, and tests.
- Codex or Claude Code checks the actual files and test evidence before accepting completion.

Turn the mode off when you want Codex or Claude Code to handle tasks normally again:

```text
/grok_execute off
```

Only the exact `on` and `off` forms change the mode. Turning it off does not cancel work that is already running; the plugin finishes supervising that work safely.

## How it stays connected

```text
Codex or Claude Code
        ↓
Background Supervisor
        ↓
Grok Build + the Windows Terminal window
```

The Supervisor handles the connection details. Users do not manage the underlying Leader, ACP connection, process IDs, or event cursor.

- Closing one Codex or Claude Code task, or updating the plugin, does not immediately disconnect the background Supervisor.
- More than one host can view the same Grok session, but only one can send commands at a time. This prevents two agents from writing over each other.
- Status checks return compact stages such as locating, modifying, and verifying, with bounded file and tool counts. Silent Supervisor heartbeats do not pretend that Grok made progress, and raw tool logs or the answer accumulated so far are not repeated.
- Short final answers are returned once. A longer report is saved as a local file, and the plugin returns its location, size, checksum, truncation status, and a short summary. [context-mode (recommended)](https://github.com/mksglu/context-mode) can process that file when installed, but the Supervisor does not require it.
- Grok is told whether the sender is Codex, Claude Code, or another host, instead of always being told that Codex sent the task.
- The scripts needed by an already-running session are copied to persistent storage, so refreshing the plugin cache cannot remove them mid-session.
- A newer plugin waits until an older busy Supervisor is idle before replacing it. Existing work stays connected during the transition.
- Before reusing or stopping a process, the plugin checks the session, project, process identity, Grok's active-session record, and its own ownership record. A matching process number alone is not enough.

## Safety rules

- The plugin never turns on approve-everything modes or chooses a permission for you.
- It never trusts a workspace for you; Grok's native directory-trust choice remains yours.
- It does not type into the terminal, take over an unrelated Grok process, or stop a process it cannot prove it owns.
- It does not hide the terminal unless you explicitly ask for no visible window.
- It accepts only a local proxy that can actually carry the required connection. It does not store proxy passwords or assume one fixed port.
- Grok cannot choose its own sender label; the local MCP connection supplies it.
- “Grok says it is done” is not proof. Codex or Claude Code still checks the files, diff, tests, and other evidence you requested.
- Installing the plugin does not grant permission to delete data, publish code, send outside messages, read secrets, or make product decisions.

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
