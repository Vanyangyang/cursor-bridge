# Cursor Bridge v5.3.3

Live-tested on **Cursor 3.16.17** after a clean Cursor quit and plugin reload. Status, workspace init, and CCE all returned on CDP **9223** without opening an extra IDE window.

## Fixed

- If Agents Window is already open, CCE ensure reuses the `Cursor Agents` page and does **not** spawn `Cursor.exe --new-window`. That extra workbench ignored Cursor's Window Restoration setting, often restored an unrelated last folder, and could blank Agents Window.
- `cursor_status` reads `/json/list` only. It no longer runs `Runtime.evaluate` on every page.
- `cursor_status` has an 8-second MCP hard timeout and always reports `pluginVersion`, so a wedged page cannot run until the host's one-hour client timeout.
- CCE page selection times out probes in 5 seconds and reloads a blank Agents Window once before failing over.
- Cursor is never launched with a privileged CDP port. Test sinkhole `CURSOR_BRIDGE_CDP_PORT=1` can no longer steal the real Cursor instance onto `127.0.0.1:1`. Launch args fall back to `9223`.

## Compatibility

Supported Cursor versions (Windows 11):

| Cursor | Status |
|---|---|
| **3.16.17** | Live-tested. Workbench and Agents Window. |
| **3.7.42** | Live-tested earlier in 5.3.0. Workbench and Agents Window. |

Other Cursor versions have not been tested.

## Update

```bash
# Grok Build
grok plugin update cursor-bridge
# then /plugins and press r, or start a new session

# Claude Code
claude plugin update cursor-bridge

# Codex
codex plugin marketplace upgrade vanyangyang
```
