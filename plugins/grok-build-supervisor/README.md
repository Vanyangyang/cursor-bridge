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

## Use it

The first time you use the plugin, initialize the local proxy once:

```text
/grok_init
```

The plugin first tries the local proxy settings already on your computer. If none works, it checks a limited set of local listening ports. It saves a choice only after proving that the proxy can actually carry an HTTPS connection; an open port by itself is not enough. There is no hard-coded default. If more than one proxy works, choose one:

```text
/grok_init http://127.0.0.1:<port>
```

The choice is saved outside the plugin cache, so plugin updates do not erase it. Run `/grok_init` again if your proxy port changes. Initialization never opens Grok or sends it a task, and it will not change the proxy while Grok is busy.

Turn supervised execution on:

```text
/grok_execute on
```

Then ask for work normally. Codex or Claude Code decides whether to reuse the current Grok session or open the right one for the project, sends the approved task, and keeps watching until Grok finishes, fails, asks a question, or needs a permission decision. You do not manage the TUI, session ID, or process yourself.

Turning the mode on does not open Grok or send a task by itself; it changes how the next ordinary tasks are handled. The first task that needs Grok causes the plugin to reuse or open the session automatically.

> [!TIP]
> Grok opens in a visible Windows Terminal window by default. If you do not want to see it for a particular task, say “Run this one without showing the Grok terminal.” The plugin never hides the window unless you ask, and it does not quietly switch to background mode when a visible launch fails.

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
- Status checks return small updates while Grok is working. They do not keep returning the full answer accumulated so far.
- Short final answers are returned once. A longer report is saved as a local file, and the plugin returns its location, size, checksum, truncation status, and a short summary. Context-mode can process that file when already installed, but it is optional.
- Grok is told whether the sender is Codex, Claude Code, or another host, instead of always being told that Codex sent the task.
- The scripts needed by an already-running session are copied to persistent storage, so refreshing the plugin cache cannot remove them mid-session.
- A newer plugin waits until an older busy Supervisor is idle before replacing it. Existing work stays connected during the transition.
- Before reusing or stopping a process, the plugin checks the session, project, process identity, Grok's active-session record, and its own ownership record. A matching process number alone is not enough.

## Safety rules

- The plugin never turns on approve-everything modes or chooses a permission for you.
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
