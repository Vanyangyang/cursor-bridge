# Grok Build Supervisor for Pi

Let Pi plan, monitor, correct, and verify work while a persistent Grok Build session performs implementation, builds, and tests.

```powershell
pi install npm:pi-grok-build-supervisor
```

Restart Pi after installation. Run `/grok_init` once to discover and save the local proxy, then use `/grok_execute on` in the project that Grok should execute for. `/grok_execute off` returns Pi to normal execution.

The package includes the two Supervisor Skills, both prompt templates, the bundled MCP frontend and daemon, and the visible Windows Terminal TUI runtime. It embeds Grok Build Supervisor 0.3.7 and retains the same trust, permission, ownership, compact-progress, and result-artifact boundaries documented by the main plugin. Pi is carried through the authenticated host-identity envelope and is never mislabeled as Codex.

Full documentation: [English](https://github.com/Vanyangyang/cursor-bridge/tree/main/plugins/grok-build-supervisor#readme) · [简体中文](https://github.com/Vanyangyang/cursor-bridge/blob/main/plugins/grok-build-supervisor/README.zh-CN.md)
