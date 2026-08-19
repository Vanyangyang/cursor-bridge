---
description: Explicitly turn the task-local Grok executor mode on or off.
---

# Grok Executor Mode Toggle

Use `$grok-executor-mode` for the task-local role contract and `$grok-build-supervisor` for Grok session operations. This command is a prompt-level task policy, not a native host collaboration-mode switch.

Interpret the entire trimmed value of `"$ARGUMENTS"` case-insensitively:

- `on`: bind Grok Executor Mode to the current host task's absolute project directory and immediately ensure its supervised Grok session is ready. Before changing mode state, call `grok_session_inspect` with `view: status`. If the proxy is not initialized, the project directory is unavailable or ambiguous, another workspace owns active Grok work, or session setup fails, leave the mode off and report only the actionable next step. Otherwise reuse the exact attached visible session for this directory or call `grok_session_open` with that absolute `cwd`, `mode: new` when no session is attached, the default `presentation: windows_terminal`, and `confirmation: OPEN_GROK_SESSION`. Use `mode: resume` only with an exact verified attached session UUID. Commit the task-local mode and workspace binding only after the visible TUI is verified ready. Reply briefly, for example `Grok 执行模式已开启，终端已就绪，直接告诉我任务即可。` This activation authorizes opening the terminal but must not call `grok_session_prompt` or send development work. Never ask the user for a separate TUI command. Repeated `on` is idempotent but must still ensure the same workspace and visible session are ready.
- `off`: explicitly deactivate Grok Executor Mode for the current host task, clear its task-local workspace binding, and confirm briefly. Subsequent ordinary tasks use normal host behavior. Do not automatically cancel a running Grok prompt, disconnect ACP, close the visible TUI, or stop the owned Leader; continue any already-required Supervisor monitoring under its normal contract. Repeated `off` is idempotent.
- Empty or any other value: do not change mode state, create a session, or send work. Reply only with the usage `/grok_execute on` or `/grok_execute off`.

Only the most recent exact `/grok_execute on` or `/grok_execute off` in this task controls the mode. The workspace selected by a successful `on` is task-local and must not be written to global proxy settings or silently changed while the mode remains active. Ordinary Grok mentions, task text, direct Skill invocation, partial matches, and every other command must not activate or deactivate it. Activation does not broaden permission for destructive work, publication, external writes, or consequential owner decisions.
