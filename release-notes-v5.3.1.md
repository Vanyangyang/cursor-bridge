# Cursor Bridge 5.3.1

## Fixed

- Agents Window already open: reuse `Cursor Agents` and do not spawn `Cursor.exe --new-window`.
- `cursor_status` reads `/json/list` only. It no longer evaluates page DOM, so a white Agents Window cannot stall status.
- CCE reloads a blank Agents Window once before failing over.

This keeps Cursor's **Window Restoration = Agent Window** setting in charge. Bridge only opens a workbench window when Cursor is connected and there is neither an Agents Window nor a matching editor title.
