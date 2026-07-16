---
name: cursor-policy
description: "Inspect or change Cursor Bridge's session-scoped delegation policy through cursor_policy. Use when the user asks how aggressively Cursor should be delegated work, requests off, manual, auto, active, or eager mode, wants to view the effective policy, or asks for a Cursor delegation frequency control. Explain policy as scheduling aggressiveness rather than a numeric call frequency, and do not promise an unsupported slash command."
---

# Cursor Policy

Use `cursor_policy` to inspect or change the effective delegation policy for the current session.

## Apply a policy

1. Map the request to one of the supported modes:
   - `off`: do not delegate execution through `cursor_do`.
   - `manual`: delegate only after an explicit user request.
   - `auto`: use a cautious cost-and-scope heuristic.
   - `active`: recommended default; proactively delegate bounded light-to-medium work.
   - `eager`: maximize safe bounded delegation and non-overlapping parallel work.
2. Call `cursor_policy` with the selected `mode`. Omit `mode` when the user only wants to inspect the current policy.
3. Report the effective policy returned by the tool. If `cursor_status` is used later, keep behavior consistent with its policy echo.

Treat policy as scheduling aggressiveness, not “call Cursor every N tool invocations.” Never let a mode override an explicit user opt-out, path boundaries, task independence requirements, or primary-agent verification.

Do not claim a `/cursor` command. Codex users may invoke `$cursor-policy` when skill invocation is available, or request the change in natural language.
