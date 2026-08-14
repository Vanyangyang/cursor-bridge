# Cursor Bridge v5.3.1

## Fixed

- If Agents Window is already open, CCE ensure reuses the `Cursor Agents` page and does not spawn `Cursor.exe --new-window`.
- `cursor_status` reads `/json/list` only. It no longer evaluates page DOM.
- CCE reloads a blank Agents Window once before failing over.

