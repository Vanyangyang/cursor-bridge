# Cursor Bridge for Pi

> **Windows only:** Cursor Bridge currently supports Windows only. macOS and Linux are not supported or covered by end-to-end acceptance.

Use Cursor's project index and Agent search from Pi, with compact `path:line` evidence and optional bounded Cursor task execution.

⭐ If Cursor Bridge helps you, please consider giving it a Star on GitHub—it helps others discover the project.

```powershell
pi install npm:pi-cursor-bridge
```

Restart Pi after installation. Initialize the current project by asking Pi to initialize Cursor Bridge for the absolute project path, then use it normally. The package includes the `cce-routing`, `cursor-delegate`, and `cce` Skills and the `prompts/cce.md` prompt and registers the native Cursor Bridge MCP tools directly in Pi.

Pi wrapper 0.5.0 embeds Cursor Bridge 7.0.0, including the CLI-first CCE route (isolated ACP + Ask mode with preflight checks and explicit model selection), the optional official agent-local own-key Responses route and its adjacent provider preload, and IDE/Agents fallback over CDP. IDE/account modes require Cursor login; an explicitly configured local provider uses the authless Cursor harness. Its result contract returns a compact receipt for background `cursor_do` work: poll `cursor_status(task_id)` normally, retrieve the terminal raw reply with `cursor_status(task_id, detail="result")`, check `isError` before using its content, and use `detail="full"` only when diagnostics are needed. Current end-to-end compatibility claims remain scoped to the environments documented in the main repository.

Full documentation: [English](https://github.com/Vanyangyang/cursor-bridge#readme) · [简体中文](https://github.com/Vanyangyang/cursor-bridge/blob/main/README.zh-CN.md)

Use `/cce cli`, `/cce ide`, or `cursor_cce(action="doctor")` to configure or verify CCE readiness. If slash commands are unavailable, use `cursor_cce(action="set", source="cli"|"ide")`; use `action="show"` to inspect it. Fresh installations and upgrades without an existing `cce-source.json` default to `cli` (existing saved `cce-source.json` preferences are preserved). Switching sources preserves the model and shared CCE request/result contract. For the default `cli` route (including 6.x → 7.0.0 migration), install Cursor CLI in PowerShell with `irm 'https://cursor.com/install?win32=true' | iex`, restart your terminal/Pi, sign in with `cursor-agent login`, configure an explicit named model via `cursor_model(action="set", target="cce", model="grok-4.6-fast", effort="medium")` (`Auto` and `default` are rejected), and verify readiness with `/cce doctor` (or run `/cce ide` once to stay on desktop IDE).
