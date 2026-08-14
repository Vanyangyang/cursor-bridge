# Cursor Bridge 5.3.2

## Fixed

- `cursor_status` cannot run past 8 seconds. The MCP handler races the snapshot against a hard timeout and returns `pluginVersion` so hosts can confirm they loaded this build.
