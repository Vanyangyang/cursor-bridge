# Cursor 3.23.12 verification

- Date: 2026-10-02
- Platform: Windows 11
- Cursor executable: `D:\tool\cursor\Cursor.exe`
- Installed Cursor evidence: `cursor --version` and embedded `resources/app/package.json` report `3.23.12`; the CLI reports commit `2d29876d567da1607532b23bbf2cd5ddbca496f0`, `x64`.
- Starting repository baseline: `9ed7d9a`, Cursor Bridge `6.0.6`.
- Native host version: `6.0.6`, observed through `cursor_status` in this run.
- Release target: Cursor Bridge `6.0.7`, `pi-cursor-bridge` `0.2.7`, and `vanyangyang-cursor-bridge` `0.1.5`; both wrappers embed `6.0.7`. Grok Build Supervisor remains `0.4.3`.

## Evidence boundary

The user saved work and explicitly authorized normal restart. Connected acceptance then exercised the actual Cursor 3.23.12 IDE and Agents Window through source adapters and rebuilt MCP stdio bundles. Both UI types passed CCE, FIFO execution, explicit Grok 4.7/high selection, exact cancellation, and hidden CCE followed by normal restoration. Agents Window parallel execution, persistent sessions, new-workspace admission, and both normal window-close orders also passed.

The installed native `6.0.6` adapter exposed the original missing recovery fields and obsolete project-row matching. Candidate acceptance used separate source/stdio adapters; most live checks ran before the release label changed from `6.0.6` to `6.0.7`. A rebuilt release bundle and remote artifacts are checked separately below. This does not establish hot replacement of the native adapter already loaded in this Codex chat. Persistent model selections remain `grok-4.7` / `high` for both targets; runtime mode remains `normal`.

No connected pass from Cursor 3.21.16 or 3.22.12 is transferred to 3.23.12. The new maintained pairing is `3.23.12 / 6.0.7`; `3.21.16 / 6.0.6` is archived with its original evidence.

## Compatibility changes

1. **Initialization recovery:** the lifecycle core and Supervisor already returned `needsAction`, `nextStep`, `retryable`, `cursorExecutable`, and `cursorExecutableSource`; the IPC client omitted them. It now preserves the five fields, including both true and false retryability. Actual unconnected initialization returns the concrete normal-exit retry instruction without creating tasks.
2. **Project selection:** Cursor 3.23 project rows show basenames. Bridge reads exact local file-URI workspace metadata, proves the committed React path from `root.current` through child/sibling edges, and rejects stale alternates, remote identities, conflicting paths, and duplicate matches. A real row required 148 ancestor levels; the bounded limits are 256 levels and 2048 traversed nodes. The existing after-create, before-fill, and before-send workspace guards remain active.
3. **Collapsed History:** a collapsed repository lacks the old list-container anchor. Collection now also inspects section headers, with deduplicated anchors and the existing schema/callback checks. This restored durable Agent identity promotion and parallel scheduling without expanding the sidebar.
4. **Exact Stop controls:** the new conversation-shell container is normalized by exact Agent ID. Modern cancellation requires confirmed generating state and one owned visible Stop button, excludes nested Agents, and retains the legacy IDE and expected-Agent checks.
5. **IDE hidden model verification:** the IDE input is Solid, but its closed model trigger exposes the exact composer's selections in mounted React props. Bridge scopes to one attributed composer and one owned trigger, proves the committed tree, and accepts only one explicit named selection with typed parameters and Auto disabled. It reads without opening the picker or invoking selection callbacks. Unknown, stale, or conflicting configuration fails closed.
6. **Live cancellation harnesses:** the scripts explicitly bind their workspace, refresh the same task after draft identity promotion, and request full IDE diagnostics before cancellation. Production mismatch guards were not relaxed to make the tests pass.

The first parallel run exposed the collapsed-History defect: A was submitted and completed, while B remained queued and was never sent. A's exact durable Agent and complete marker reply were recovered before starting a fresh independent acceptance run. The failed tasks were not automatically resubmitted. Earlier cancellation harness failures likewise did not count as cancellation passes; exact underlying completion was confirmed before fresh tests.

## Results

| Check | Result | Evidence |
|---|---|---|
| Initial Bridge regression | Pass | 316 passed, 0 failed, 0 skipped. |
| Recovery-fix regression | Pass | 320 passed, 0 failed, 0 skipped; four added recovery regressions. |
| Final release Bridge regression | Pass | 381 passed, 0 failed, 0 skipped; includes project, collapsed-History, Stop, and hidden-model verification fixtures. |
| Supervisor regression | Pass | 147 passed, 0 failed, 0 skipped. |
| Real Supervisor IPC failure regressions | Pass | Both new cases failed against the original client, then passed after the five-field fix; `retryable=true/false` both preserved. |
| Initialization consumer regressions | Pass | Explicit recovery step and retryability retained, workspace binding saved, admission released, no tasks created. |
| Supervisor MCP smoke | Pass | 6 tools, `statusCallPassed=true`, protocol version 1. |
| Root and staged Cursor Bridge MCP smoke | Pass | All three bundles report version 6.0.7, expose 8 tools, and reject both unconfirmed workspace requests before submission without changing isolated settings. |
| Canonical build and staging | Pass | All four runtime bundles rebuilt; both products staged for Pi and generic MCP. |
| Package contents and equality | Pass | Pi Cursor has 13 packed files, generic Cursor 10; required bundles/Skills/manifests present, no outputs/tests/node_modules. Staged Cursor, lifecycle, and unchanged Supervisor bundles match their source-tree counterparts byte for byte. |
| Plugin contracts and validators | Pass | Version/schema contracts passed; Claude root plugin, marketplace, and Supervisor validation passed. Official Codex remote installation is checked after publication; this CLI has no separate plugin-validation subcommand. |
| Portable CI selection on Windows | Pass | 52 tests passed; the model-config suite is also included in the macOS basic CI selection. This is not macOS Cursor UI acceptance. |
| Real unconnected Cursor initialization | Pass | Rebuilt candidate returned `ready=false`, `running-no-debug`, `retryable=true`, `close_cursor_and_retry`, and the concrete normal-exit instruction; zero tasks and unchanged model preferences. |
| Agents Window CCE and FIFO | Pass | `test/live-model-preference.mjs`; both applied `Grok 4.7 High` / `high`. |
| IDE CCE and FIFO | Pass | Same source test in the sole IDE window; FIFO reported `uiFlavor=legacy`, both applied the requested model and effort. |
| Two independent simultaneous Agents | Pass | `test/live-parallel-agent.mjs`; two active jobs with separate durable IDs, complete independent marker replies, no FIFO fallback. |
| Persistent-session restart and unread recovery | Pass | `test/live-session-continuity.mjs`; three turns reused one exact Agent across adapter restart; repeated result collection did not read or switch the UI. |
| Agents Window hidden CCE / normal restoration | Pass | `test/live-minimal-smoke.mjs`; complete `CCE_SEARCH_RESULT`, normal visibility restored in `finally`, persistent mode unchanged. |
| IDE hidden model/effort verification | Pass | With Grok 4.7/high selected in normal mode, the closed trigger returned exact `reasoning_effort=high` while hidden; the production preference verifier accepted high, rejected low, invoked no selection callback, and created zero tasks. |
| IDE hidden CCE / normal restoration | Pass | After the new reader was integrated under source version 6.0.7, the live minimal smoke returned complete `CCE_SEARCH_RESULT`; five source anchors were verified locally and normal visibility restored. |
| Exact cancellation in both UI types | Pass | Both live FIFO cancellation scripts returned `state=cancelled`, `underlyingStopConfirmed=true`; modern Agents shell and legacy IDE paths both exercised. |
| New-workspace admission and adapter restart | Pass | Built stdio test rejected unconfirmed and mismatched CCE/Do with no task; explicit init registered the exact fixture, CCE read its package name/version, restart retained its workspace ID. |
| Both last-closed window orders | Pass | Normal target closes and cold launch restored exactly one IDE when IDE closed last and exactly one Agents Window when Agents closed last. |
| Window presentation scope | Pass | One owned Cursor window changed; foreground preserved. No unrelated protected window existed in this test. |
| Attached fallback | Pass with controlled injection | Injected Supervisor IPC `EPERM`, then attached to real existing CDP. `lifecycleMode=attached`, `launchReason=attached-after-supervisor-blocked`, launch/open-window capabilities false. Not a real OS AppContainer denial. |

The real initialization smoke is opt-in:

```powershell
node test/live-init-recovery-smoke.mjs <absolute-project>
```

It requires an already-running Cursor without the Bridge connection and uses temporary adapter settings. It deliberately does not close Cursor, run CCE, or accept a connected instance as a recovery-path pass.

## Exact live identities

The test workspace was `C:/Users/Administrator/.codex/worktrees/cursor-3-21-16/cursor-bridge`, with exact registered ID `d37abfbf7a774f6e5470cc8cdd1c140e`. IDs below are durable identities, not the earlier provisional draft IDs.

| Test | Durable identity |
|---|---|
| Agents CCE | `bbba6c67-c52b-4c07-818d-7f67ac5d8eb8` |
| Agents FIFO | `26b6a65c-cae8-4249-a342-16b9aa7c91f3` |
| Parallel A / B | `local:c07229a6-d1ef-4f60-abde-e8ea78887915` / `local:37419dea-7656-4201-a603-1a071dccea7e` |
| Persistent session | `cursor-session-4062e3c5-d420-4624-8489-6ca99ca08c9e`; Agent `local:1823f210-440d-4557-9901-334f27433ef7` |
| Agents cancellation | `local:7c5b3b3b-ce9f-4c2e-89c6-c6870368a55d` |
| IDE CCE / FIFO | `local:b6d8fed6-228f-4b39-9a47-91f2b04856ee` / `local:164cc1b3-5d66-4450-b86b-7f19f80caf7c` |
| IDE cancellation | `local:c9a523ce-5baf-4a80-931c-6c7dfeab6a74` |
| Final IDE hidden CCE | `local:e8ba922d-5c57-4205-8ce9-ee2a41216f4a`; exact composer completed, Stop count 0, input empty, Grok 4.7/high still selected. |
| New fixture workspace | `c4e928141dc7de4f78636b7fd9e9981b` |

Local evidence is retained under the private `outputs/` directory, including `cursor-3.23.12-agents-model-live-recheck.log`, `parallel-live-fixed.log`, `session-live.log`, `minimal-live.log`, `ide-model-live.log`, both `cancel-*-fixed.log` files, `window-orders.log`, and `new-workspace-live.log` (all with the `cursor-3.23.12-` prefix). These logs are not distribution contents.

Final IDE evidence is in `cursor-3.23.12-ide-hidden-config.log` and `cursor-3.23.12-ide-minimal-recheck-final.log`. The earlier pre-reader IDE minimal attempt could not confirm the model and rejected before sending. One later attempt was blocked by a transient dialog before sending; after a clear chat-surface probe, the independent recheck completed. Neither rejected attempt is counted as a CCE pass.

## Release checks and remaining limits

- Versioned build, root/wrapper stdio smoke, package-content checks, byte equality, and plugin contracts passed. Formal distribution packages are generated from a clean remote checkout of the immutable release tag after the reviewed commit is pushed; the primary checkout's unrelated dirty changes and private outputs are excluded. Remote artifact verification follows publication.
- The current Codex chat retains its already-loaded native `6.0.6` adapter. Installing `6.0.7` requires a fresh host task or host reload to prove native pickup; standalone `6.0.7` stdio smoke is separate evidence.
- Hidden CCE is live verified in both UI types. Minimal mode verifies the current composer selection; it does not change the model while hidden. Select the requested model and effort in normal mode first. Auto or a mismatched/unconfirmed selection rejects before submission.
- Real OS policy denial and macOS Cursor UI acceptance remain untested. The historical `ETIMEDOUT` root cause remains unknown; this release makes no claim to resolve it.
