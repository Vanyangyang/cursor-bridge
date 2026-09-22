# Cursor Bridge MCP

> **Windows only:** Cursor Bridge currently supports Windows only. macOS and Linux are not supported or covered by end-to-end acceptance.

Generic stdio MCP package for AI clients that are not Codex, Claude Code, Grok Build, or Pi. This is not a Pi package and is not a first-class AI client.

The unscoped name `cursor-bridge-mcp` is already taken on npm by an unrelated package. Install this package instead. Releases are published from the repository's package-specific GitHub Actions workflow through npm Trusted Publishing.

```powershell
npm install --prefix "$env:LOCALAPPDATA\cursor-bridge\npm" vanyangyang-cursor-bridge@0.1.3
```

The MCP bundle and executable entry are `dist/cursor-bridge.mjs`. The skills are `skills/cce-routing` and `skills/cursor-delegate`. The current AI client registers those paths itself, then restarts. Wrapper 0.1.3 embeds Cursor Bridge 6.0.5.

Do not publish the private repository root, and do not restore `cursor-mcp-bridge`.

Full install playbook: [English](https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.md) · [简体中文](https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.zh-CN.md)
