---
description: Persistently bind Cursor Bridge to the current project workspace
argument-hint: '<absolute-project-path>'
allowed-tools: mcp__plugin_cursor-bridge_cursor-bridge__cursor_init
---

Use `$ARGUMENTS` as the workspace path. If it is empty, use the current Claude Code project root.

Call `mcp__plugin_cursor-bridge_cursor-bridge__cursor_init` exactly once with that absolute path. Report the saved `projectPath`, workspace source, Cursor lifecycle result, and whether the new Agents Window or legacy workbench will be selected. Do not submit a CCE query or execution task as part of initialization.

