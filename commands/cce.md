---
description: "Persistently select the CCE source: cli or ide; show the current source without an argument."
argument-hint: "[cli|ide]"
---

Manage Cursor Context Engine's local source preference. User argument: `$ARGUMENTS`.

For exactly `cli`, call `cursor_cce` with `{"action":"set","source":"cli"}`.
For exactly `ide`, call `cursor_cce` with `{"action":"set","source":"ide"}`.
Without an argument, call `cursor_cce` with `{"action":"show"}`.
For any other argument, explain `/cce cli`, `/cce ide` and `/cce` without modifying the preference.

Report `cceSource` and the local `cceSourceFile` in the user's language. The saved choice survives restarts and plugin updates, applies to later CCE queries, and keeps CCE's existing model/effort and evidence contract. Do not submit a query or change native Cursor settings. If the tool is unavailable, report that Bridge must be updated/reloaded instead of claiming the switch succeeded.
