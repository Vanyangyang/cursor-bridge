# Cursor 3.22.12 verification

- Date: 2026-10-02
- Platform: Windows 11
- Cursor executable: `D:\tool\cursor\Cursor.exe`
- Cursor evidence: `cursor --version` and the embedded `resources/app/package.json` report `3.22.12`; the CLI reports commit `3a92974361033b2051526321308c2740fe5912c0` and `x64`.
- Cursor Bridge baseline: `6.0.6`, checked out from `origin/main` at `7746001` in an isolated worktree.

## Evidence boundary

The automated and packaging checks below passed. Live Cursor 3.22.12 acceptance is pending. The running Cursor instance has no remote debugging connection, and `cursor_init` reports `running-no-debug`. Cursor Bridge does not force-close it. Save work, exit Cursor normally once, then initialize the exact test workspace again before running the live checks.

At the start of this run, the native host reported Cursor Bridge `6.0.5`, and the configured marketplace pointed to a local checkout containing unrelated uncommitted changes. Reinstalling from that marketplace selected the same `6.0.5+codex.20260922142048` cache. After pushing the checked changes, the normal installation commands switched the marketplace to `Vanyangyang/cursor-bridge` on GitHub `main` and installed the remote `6.0.6` cache. That installed bundle passed the isolated stdio smoke. The originating host task retains its earlier tool registration; exact native pickup of `6.0.6` still requires a fresh host task. No local checkout changes or persistent model preferences were discarded.

The existing Cursor 3.21.16 results are historical evidence. They are not counted as live passes for Cursor 3.22.12, and `compatibility.json` retains the previous verified pairing until current-version acceptance is complete.

## Automated results

| Check | Result | Evidence |
|---|---|---|
| Root unit suite | Pass | `npm test`: 316 passed, 0 failed, 0 skipped. |
| Supervisor unit suite | Pass | `npm --prefix plugins/grok-build-supervisor test`: 147 passed, 0 failed, 0 skipped. |
| Supervisor MCP smoke | Pass | 6 tools discovered, `statusCallPassed=true`, runtime version `0.4.3`. |
| Canonical build | Pass | All four committed runtime bundles rebuilt successfully. |
| Pi and generic MCP staging | Pass | Both products staged through both packaging paths. |
| Claude plugin structures | Pass | Root marketplace, Cursor Bridge plugin manifest, and Supervisor plugin manifest validated. |
| Root Cursor Bridge MCP smoke | Pass | Server/status version `6.0.6`, 8 required tools, 2 pre-submission workspace confirmation rejections, idle task state, unchanged isolated settings. |
| Staged generic Cursor Bridge MCP smoke | Pass | The staged `vanyangyang-cursor-bridge` bundle passed the same stdio checks. |
| Staged Pi Cursor Bridge MCP smoke | Pass | The staged `pi-cursor-bridge` bundle passed the same stdio checks. |
| Packed Cursor Bridge wrappers | Pass | Both `.tgz` archives were unpacked; their embedded generic/Pi bundles passed the same stdio version, schema, and admission checks. |
| Remote installation | Pass | `codex plugin marketplace add Vanyangyang/cursor-bridge --ref main` and `codex plugin add cursor-bridge@vanyangyang` installed the `6.0.6` cache; its bundle passed the isolated stdio smoke. |
| GitHub CI | Pass | Commit `464ea9609cf00d68bdb0767408d288ddca38e1ee`: [Windows and macOS basic checks](https://github.com/Vanyangyang/cursor-bridge/actions/runs/36892539887) both completed successfully. |

`test/smoke-mcp.mjs` uses temporary settings, disables auto-launch, and reserves a private port whose probes are rejected. It never initializes a workspace, sends a real Cursor prompt, or changes persistent model defaults. It skips the runtime tool when its schema requires arguments that could change presentation. The Windows CI job now runs this check after the unit suite.

## Packaged baseline

Local `npm pack` completed for:

- `pi-cursor-bridge-0.2.6.tgz`, embedding Cursor Bridge `6.0.6`.
- `pi-grok-build-supervisor-0.1.9.tgz`, embedding Supervisor `0.4.3`.
- `vanyangyang-cursor-bridge-0.1.4.tgz`, embedding Cursor Bridge `6.0.6`.
- `vanyangyang-grok-build-supervisor-0.1.0.tgz`, embedding Supervisor `0.4.3`.

These are baseline packages, not a new release or a claim of Cursor 3.22.12 live compatibility.

## Pending live acceptance

| Area | Status |
|---|---|
| IDE CCE and read-only FIFO execution | Pending |
| Agents Window CCE and read-only FIFO execution | Pending |
| Exact workspace selection and mismatch rejection | Pending |
| Configured model and reasoning effort before submission | Pending |
| Two independent Agents and exact result collection | Pending |
| Persistent session continuation, adapter restart, and unread-result recovery | Pending |
| Minimal-mode CCE and normal restoration | Pending |
| Last-closed window restoration and attached fallback | Pending |
| Final release version and fresh native host pickup | Pending |

The workspace-binding smoke now accepts an optional third argument containing a read-only CCE query. Its default query locates MCP registrations and permits `NOT_FOUND`, so it no longer assumes the test workspace contains a particular Canvas application.
