# Cursor Bridge for Pi

> **Windows only:** Cursor Bridge currently supports Windows only. macOS and Linux are not supported or covered by end-to-end acceptance.

Use Cursor's project index and Agent search from Pi, with compact `path:line` evidence and optional bounded Cursor task execution.

⭐ If Cursor Bridge helps you, please consider giving it a Star on GitHub—it helps others discover the project.

```powershell
pi install npm:pi-cursor-bridge
```

Restart Pi after installation. Initialize the current project by asking Pi to initialize Cursor Bridge for the absolute project path, then use it normally. The package includes the `cce-routing`, `cursor-delegate`, and `cce` Skills and the `prompts/cce.md` prompt and registers the native Cursor Bridge MCP tools directly in Pi.

Pi wrapper 0.3.0 embeds Cursor Bridge 6.1.0, including Cursor 3.21 model-provider alias matching and `reasoning_effort` verification for Grok 4.7/high. Its result contract returns a compact receipt for background `cursor_do` work: poll `cursor_status(task_id)` normally, retrieve the terminal raw reply with `cursor_status(task_id, detail="result")`, check `isError` before using its content, and use `detail="full"` only when diagnostics are needed. Cursor must be installed and signed in. Current end-to-end compatibility claims remain scoped to the environments documented in the main repository.

Full documentation: [English](https://github.com/Vanyangyang/cursor-bridge#readme) · [简体中文](https://github.com/Vanyangyang/cursor-bridge/blob/main/README.zh-CN.md)

Use `/cce cli` or `/cce ide` to persist the CCE source. If slash commands are unavailable, use `cursor_cce(action="set", source="cli"|"ide")`; use `action="show"` to inspect it. The default is `ide`. Switching sources preserves the model and shared CCE request/result contract. CLI use requires an installed, authenticated Cursor CLI; selecting it alone does not verify a live CLI request.
