---
name: cursor-policy
description: "Help the user choose, inspect, or change how readily the primary agent delegates work to Cursor through cursor_policy. Use when the user asks when Cursor will be used, wants more or less Cursor involvement, asks which of manual, auto, active, or eager fits their workflow, wants to view the current mode, or asks for a delegation frequency control. Explain the choice with concrete examples rather than a numeric call frequency, and do not promise an unsupported slash command."
---

# Cursor Policy

Help the user choose how much initiative the primary agent should take when handing work to Cursor, then use `cursor_policy` to inspect or change the current session.

## Explain the choices plainly

- `manual`: choose this when the user wants to approve every handoff. Cursor is used only after an explicit request.
- `auto`: choose this when the user wants occasional help. Cursor is used only for a clearly bounded task whose likely benefit exceeds dispatch and review time.
- `active`: recommend this to most users. For a non-trivial task, normally look for one useful bounded implementation, test, documentation, configuration, or review slice to delegate.
- `eager`: choose this when the user wants Cursor used whenever a safe bounded slice exists, including small read-only probes and independent parallel work.

These modes do not count tool calls. They guide judgment about the current task.

## Say when Cursor will and will not be used

Use Cursor when the task has a clear goal, a limited path or subsystem, and a result the primary agent can verify. Keep the work local when it is a tiny direct edit, requires an unresolved product or architecture decision, depends on exclusive GUI or mutable runtime state, lacks a safe path boundary, or cannot be checked afterward. Always respect a direct user opt-out.

## Apply the choice

1. If the user only asks what is active now, call `cursor_policy` without `mode`.
2. If the user chooses a mode, call `cursor_policy` with `manual`, `auto`, `active`, or `eager`.
3. Report the effective mode returned by the tool in one plain sentence, followed by a short description of what will change in practice.
4. Keep later behavior consistent with the mode echoed by `cursor_status`.

Do not offer `off` as a user mode. If the user wants no automatic delegation, recommend `manual` and honor their explicit instruction not to use Cursor. `CURSOR_BRIDGE_DELEGATION=off` is a legacy administrator-level host switch for fully disabling `cursor_do`, not a normal policy choice. If inspection reports an administrator-disabled state, explain it rather than trying to override it.

Do not claim a `/cursor` command. Codex users may invoke `$cursor-policy` when skill invocation is available, or request the change in natural language.
