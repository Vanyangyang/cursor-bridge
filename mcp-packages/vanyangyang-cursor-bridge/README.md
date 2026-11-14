# Cursor Bridge MCP

> **Windows only:** Cursor Bridge currently supports Windows only. macOS and Linux are not supported or covered by end-to-end acceptance.

Generic stdio MCP package for AI clients that are not Codex, Claude Code, Grok Build, or Pi. This is not a Pi package and is not a first-class AI client.

The unscoped name `cursor-bridge-mcp` is already taken on npm by an unrelated package. Install this package instead. Releases are published from the repository's package-specific GitHub Actions workflow through npm Trusted Publishing.

```powershell
npm install --prefix "$env:LOCALAPPDATA\cursor-bridge\npm" vanyangyang-cursor-bridge@0.4.0
```

The MCP bundle and executable entry are `dist/cursor-bridge.mjs` (plus adjacent `dist/cursor-cli-provider-preload.mjs` and `dist/cursor-lifecycle-supervisor.mjs`). The skills are `skills/cce-routing`, `skills/cursor-delegate`, and `skills/cce`; the source-switch prompt is `prompts/cce.md`. The current AI client registers those paths itself, then restarts. Wrapper 0.4.0 embeds Cursor Bridge 7.0.0.

Do not publish the private repository root, and do not restore `cursor-mcp-bridge`.

Full install playbook: [English](https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.md) · [简体中文](https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.zh-CN.md)

Use `/cce cli`, `/cce ide`, or `cursor_cce(action="doctor")` to configure or verify CCE readiness. If slash commands are unavailable, use `cursor_cce(action="set", source="cli"|"ide")`; use `action="show"` to inspect it. Fresh installations and upgrades without an existing `cce-source.json` default to `cli` (existing saved `cce-source.json` preferences are preserved). Switching sources preserves the model and shared CCE request/result contract. For the default `cli` route (including 6.x → 7.0.0 migration), install Cursor CLI in PowerShell with `irm 'https://cursor.com/install?win32=true' | iex`, restart your terminal/client, sign in with `cursor-agent login`, configure an explicit named model via `cursor_model(action="set", target="cce", model="grok-4.6-fast", effort="medium")` (`Auto` and `default` are rejected), and verify readiness with `/cce doctor` (or run `/cce ide` once to stay on desktop IDE).
