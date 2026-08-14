# Cursor Bridge 5.3.3

## Fixed

- Never launch Cursor with a privileged CDP port. Test sinkhole `CURSOR_BRIDGE_CDP_PORT=1` can no longer bind the real Cursor to `127.0.0.1:1`.
- `cursor_status` has an 8-second MCP hard timeout and reports `pluginVersion` (5.3.2).
- Reuse an already-open Agents Window instead of `Cursor.exe --new-window` (5.3.1).
