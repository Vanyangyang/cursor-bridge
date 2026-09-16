# Grok Build Supervisor MCP

> **Windows only:** Grok Build Supervisor currently supports Windows only. macOS and Linux are not supported or covered by end-to-end acceptance.

Generic stdio MCP package for hosts that are not Codex, Claude Code, or Pi. This is not a Pi package and is not a first-class host. Until npm Trusted Publishing is configured for this name, `npm install` may return `E404`; the AI playbook then falls back to a durable git checkout.

```powershell
npm install --prefix "$env:LOCALAPPDATA\cursor-bridge\npm" vanyangyang-grok-build-supervisor@0.1.0
```

Then point the host's MCP settings at the installed `dist/grok-build-supervisor.mjs` and copy the bundled skills. Wrapper 0.1.0 embeds Grok Build Supervisor 0.4.3.

Full install playbook: [English](https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.md) · [简体中文](https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.zh-CN.md)
