# Cursor 3.20.17 / Cursor Bridge 6.0.2 verification

Verified on Windows on 2026-09-13. The installed Cursor executable reported both ProductVersion and FileVersion as `3.20.17`. Pi package `pi-cursor-bridge@0.2.2` embeds Bridge `6.0.2`.

## Adapter change

The live Auto picker exposes a `data-component="menu-popup"` root with `data-testid="selected-auto-menu"` and a `Model Auto` submenu control. Bridge 6.0.1 did not recognize this root: selection could report `Cursor model picker did not open`, and cleanup could mistake the visible popup for a closed picker.

`EXPR_MODEL_PICKER_ROWS` now recognizes that root alongside the existing model and parameter menus. A real no-prompt probe switched Fable 5.1/high → Auto → Fable 5.1/high through the production picker methods, confirmed the effective model/effort, and closed the menu. Persistent preferences were not changed. The DOM regression exercises discovery, Model-control classification and Escape cleanup; it also rejects unrelated visible popups.

Reproducible no-prompt probes, requiring one idle Cursor Agents Window with Fable 5.1/high already selected:

```powershell
node scripts/probes/probe-auto-selection.mjs
node scripts/probes/probe-pinned-selection.mjs
node scripts/probes/probe-pinned-selection.mjs --model-submenu-open
node scripts/probes/probe-pinned-selection.mjs --effort-submenu-open
```

## Real runtime evidence

| Surface | Observed result |
|---|---|
| Installed native Codex MCP, Bridge 6.0.1 | After the user saved and exited a `running-no-debug` Cursor, Bridge launched one supervised Agents Window. Init, CCE and a read-only FIFO task completed with Fable 5.1/high. Task `cursor-mtzbe09g-3` completed, released its reservation, and its reply was explicitly collected. |
| Standalone MCP using the built Bridge 6.0.2 | `status → init → status → CCE → cursor_do → result → final status` passed against real Cursor. Workspace binding used `registered_workspace_file_uri`, with `state=workspace_ready` and the exact intended local repository. |
| CCE from the built MCP | Returned `CCE_SEARCH_RESULT` with verified `server.mjs:623-626` evidence for `EXPR_MODEL_PICKER_ROWS`. |
| FIFO from the built MCP | Task `cursor-mtzbh68q-2`, Agent `local:182b2322-f2fc-481b-95bf-59030d69fa8b`, completed with `modelSelection.applied=true`, Fable 5.1/high, and the correct Bridge/Pi manifest versions. |
| Result contract | Compact status showed `resultUnread=true` without a result body. Explicit `detail=result` returned the reply; a repeat read was identical, and compact status then showed `resultUnread=false`. |
| Final built-MCP status | `pluginVersion=6.0.2`, `connected=true`, `idle=true`, `queued=0`, `lifecycleMode=supervised`, `persistent=true`, `degradedReason=null`. |

## Verification boundary

The standalone test used the actual built MCP and real Cursor; it is not proof that a fresh Codex host has loaded native Bridge 6.0.2. That native pickup remains pending. Parallel execution, persistent-session recovery, minimal mode, attached fallback, and the legacy IDE workbench were not revalidated on 3.20.17; their prior evidence remains inherited.

The first native CCE attempt immediately after launch reported `CURSOR_MODEL_MODEL_UNAVAILABLE` at `verify_effort` before submitting. A later native attempt passed, and the separate Auto-root defect was deterministically reproduced and fixed. The initial model-row disappearance was not traced to a proven root cause and remains `UNKNOWN`. The historical `ETIMEDOUT` root cause also remains `UNKNOWN`; this release does not claim to cure either observation.
