# Cursor Bridge MCP

> **Windows only:** Cursor Bridge currently supports Windows only. macOS and Linux are not supported or covered by end-to-end acceptance.

Generic stdio MCP package for AI clients that are not Codex, Claude Code, Grok Build, or Pi. This is not a Pi package and is not a first-class AI client.

The unscoped name `cursor-bridge-mcp` is already taken on npm by an unrelated package. Install this package instead. Releases are published from the repository's package-specific GitHub Actions workflow through npm Trusted Publishing.

```powershell
npm install --prefix "$env:LOCALAPPDATA\cursor-bridge\npm" vanyangyang-cursor-bridge@0.2.0
```

The MCP bundle and executable entry are `dist/cursor-bridge.mjs`. The skills are `skills/cce-routing`, `skills/cursor-delegate`, and `skills/cce`; the source-switch prompt is `prompts/cce.md`. The current AI client registers those paths itself, then restarts. Wrapper 0.2.0 embeds Cursor Bridge 6.1.0.

Do not publish the private repository root, and do not restore `cursor-mcp-bridge`.

Full install playbook: [English](https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.md) · [简体中文](https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.zh-CN.md)

Use `/cce cli` or `/cce ide` to persist the CCE source. If slash commands are unavailable, use `cursor_cce(action="set", source="cli"|"ide")`; use `action="show"` to inspect it. The default is `ide`. Switching sources preserves the model and shared CCE request/result contract. CLI use requires an installed, authenticated Cursor CLI; selecting it alone does not verify a live CLI request.
