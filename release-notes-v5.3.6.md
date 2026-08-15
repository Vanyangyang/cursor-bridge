# Cursor Bridge v5.3.6

Live-tested on **Cursor 3.16.17** (workbench and Agents Window) and previously on **3.7.42**. Installable in **Grok Build**, Codex, and Claude Code.

## Fixed

- A running FIFO task can publish an Agent ID. `cursor_task_control` cancel then uses that exact ID to Stop.
- This works on **Agents Window** and on **workbench** when the current editor exposes an identity.
- FIFO tasks that never publish an Agent ID still do not guess-click Stop. Confirm the Cursor chat is stopped, then `abandon`.

## Compatibility

Supported Cursor versions (Windows 11):

| Cursor | Status |
|---|---|
| **3.16.17** | Live-tested. Workbench and Agents Window, including running FIFO cancel. |
| **3.7.42** | Live-tested. Workbench and Agents Window. |

Other Cursor versions have not been tested.

## Update

Grok Build:

```bash
grok plugin update cursor-bridge
```

Then fully quit Grok Build and start a **new** session. `/plugins` + `r` in an old session keeps the previous MCP process. Check `cursor_status` for `pluginVersion` **5.3.6**.

Claude Code:

```bash
claude plugin marketplace update vanyangyang
claude plugin update cursor-bridge@vanyangyang
```

Codex:

```bash
codex plugin marketplace upgrade vanyangyang
codex plugin add cursor-bridge@vanyangyang
```

Then restart Codex and start a new task.
