---
description: Explicitly turn the task-local Grok executor mode on or off.
---

# Grok Executor Mode Toggle

Use `$grok-executor-mode` for the task-local role contract and `$grok-build-supervisor` for Grok session operations. This command is a prompt-level task policy, not a native host collaboration-mode switch.

Interpret the entire trimmed value of `"$ARGUMENTS"` case-insensitively:

- `on`: explicitly activate Grok Executor Mode for the current host task. Do not open a TUI or send work merely to activate it. Reply only with a short confirmation such as `Grok 执行模式已开启，直接告诉我任务即可。` Never ask the user to run a separate command or give a separate instruction to create, open, show, resume, or select a TUI. From the next ordinary user task onward, automatically apply `$grok-executor-mode`; when that task needs Grok, internally reuse the matching supervised session or open the default visible TUI before dispatch. Keep applying this mode until an exact `/grok_execute off` or the host task ends. Repeated `on` is idempotent.
- `off`: explicitly deactivate Grok Executor Mode for the current host task and confirm briefly. Subsequent ordinary tasks use normal host behavior. Do not automatically cancel a running Grok prompt, disconnect ACP, or stop the owned Leader; continue any already-required Supervisor monitoring under its normal contract. Repeated `off` is idempotent.
- Empty or any other value: do not change mode state, create a session, or send work. Reply only with the usage `/grok_execute on` or `/grok_execute off`.

Only the most recent exact `/grok_execute on` or `/grok_execute off` in this task controls the mode. Ordinary Grok mentions, task text, direct Skill invocation, partial matches, and every other command must not activate or deactivate it. Activation does not broaden permission for destructive work, publication, external writes, or consequential owner decisions.
