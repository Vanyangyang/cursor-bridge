# Cursor Bridge v5.3.4

Packaging release. Runtime behavior is the same as **5.3.3**.

## Changed

- Published plugin version is now **5.3.4**, so Grok / marketplace registry records a version change after the 5.3.3 live pass.

## Includes (from 5.3.1–5.3.3)

- Reuse an already-open Agents Window; do not spawn `Cursor.exe --new-window`.
- `cursor_status` reads `/json/list` only, times out in 8 seconds, and reports `pluginVersion`.
- Never launch Cursor on a privileged CDP port such as `1`.

## Update

```bash
grok plugin update cursor-bridge
```

Then `/plugins` and press `r`, or start a new session.
