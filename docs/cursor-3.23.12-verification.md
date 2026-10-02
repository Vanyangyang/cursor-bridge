# Cursor 3.23.12 verification

- Date: 2026-10-02
- Platform: Windows 11
- Cursor executable: `D:\tool\cursor\Cursor.exe`
- Installed Cursor evidence: `cursor --version` and embedded `resources/app/package.json` report `3.23.12`; the CLI reports commit `2d29876d567da1607532b23bbf2cd5ddbca496f0`, `x64`.
- Starting repository baseline: `9ed7d9a`, Cursor Bridge `6.0.6`.
- Native host version: `6.0.6`, observed through `cursor_status` in this run.
- Candidate status: unreleased recovery-diagnostics fix; source and rebuilt bundles retain the baseline version label until final release preparation.

## Evidence boundary

Automated regression and the real unconnected initialization recovery path passed. Connected Cursor 3.23.12 acceptance remains pending. The actual running Cursor process has no remote-debugging argument, the configured Bridge port is unavailable, and native `cursor_init` reports `running-no-debug`. Save work and exit Cursor normally once before letting Bridge start the connected instance. The checks below do not force-close the user's Cursor or submit a prompt.

The installed native `6.0.6` adapter exposed the original missing recovery fields. The real recovery smoke executed the rebuilt candidate through a separate MCP stdio client; it establishes the candidate fix, not a hot upgrade of the native host's already-loaded adapter. Persistent model selections remain `grok-4.7` / `high` for both targets.

No connected pass from Cursor 3.21.16 or 3.22.12 is transferred to 3.23.12. `compatibility.json` retains the previous verified pairing, and no new compatibility release is tagged from this preflight.

## Fixed defect

The lifecycle core already returns `needsAction`, `nextStep`, `retryable`, `cursorExecutable`, and `cursorExecutableSource`. The Supervisor preserves those fields in its IPC response, but `ensureCursorViaSupervisor` omitted them when projecting that response. The MCP layer then reported empty recovery fields and `retryable=false`.

The client now forwards those five fields using the existing nullable-string and boolean conventions. The launch policy, normal-exit requirement, model settings, and successful startup behavior are unchanged.

## Results

| Check | Result | Evidence |
|---|---|---|
| Initial Bridge regression | Pass | 316 passed, 0 failed, 0 skipped. |
| Final Bridge regression after fix | Pass | 320 passed, 0 failed, 0 skipped; four added recovery regressions. |
| Supervisor regression | Pass | 147 passed, 0 failed, 0 skipped. |
| Real Supervisor IPC failure regressions | Pass | Both new cases failed against the original client, then passed after the five-field fix; `retryable=true/false` both preserved. |
| Initialization consumer regressions | Pass | Explicit recovery step and retryability retained, workspace binding saved, admission released, no tasks created. |
| Supervisor MCP smoke | Pass | 6 tools, `statusCallPassed=true`, protocol version 1. |
| Root and staged Cursor Bridge MCP smoke | Pass | Root, Pi, and generic bundles expose 8 tools and reject both unconfirmed workspace requests before submission without changing isolated settings. |
| Canonical build and staging | Pass | All four runtime bundles rebuilt; both products staged for Pi and generic MCP. |
| Real unconnected Cursor initialization | Pass | Rebuilt candidate returned `ready=false`, `running-no-debug`, `retryable=true`, `close_cursor_and_retry`, and the concrete normal-exit instruction; zero tasks and unchanged model preferences. |

The real initialization smoke is opt-in:

```powershell
node test/live-init-recovery-smoke.mjs <absolute-project>
```

It requires an already-running Cursor without the Bridge connection and uses temporary adapter settings. It deliberately does not close Cursor, run CCE, or accept a connected instance as a recovery-path pass.

## Pending connected acceptance

- Exact workspace registration/selection and mismatched-workspace rejection in the live UI.
- CCE and read-only FIFO execution in both the IDE and Agents Window.
- Requested model and reasoning effort applied before every submission.
- Independent Agents, exact task/result identity, repeated result collection, and targeted cancellation.
- Persistent-session continuation, adapter restart, and unread-result recovery.
- Minimal-mode CCE, normal restoration, and both last-closed window orders.
- Attached fallback, final release packaging, and fresh native host pickup of the new release.
