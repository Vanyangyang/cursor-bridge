# Changelog

Notable Grok Build Supervisor changes are documented here. The plugin has its own version and install lifecycle even though it shares this repository and marketplace with Cursor Bridge.

## [Unreleased]

### Fixed

- Repeated `/grok_execute on` can now repair an idle, exact plugin-recorded Grok TUI whose Leader ownership was lost after human verification or a connection-driven Leader restart. The Supervisor verifies the session, workspace, active registry PID, durable process fingerprint, and absence of supervised work before stopping only that recorded host tree and resuming the same session.
- Dead PIDs left behind in Grok's `active_sessions.json` no longer block the same-session resume after an orphan repair. Raw registry residue is retained as diagnostic evidence after the exact recorded process identity has stopped instead of being treated as a second failure.
- Public status retains the 20 most recently updated TUI records, while daemon-busy checks consume an aggregate computed across every durable record. An older verified live terminal therefore still blocks daemon shutdown or runtime replacement even when its detail row is outside the public window.
- Orphan repair now holds a crash-released operating-system named-pipe mutex for the exact session/workspace; revalidates both Grok and host process fingerprints after acquiring it; and refuses to terminate any process tree that contains the current Supervisor daemon.
- Windows process-tree termination resolves both PowerShell and `taskkill.exe` from `System32`, preserves command diagnostics, attempts graceful shutdown first, and redirects forced shutdown to the exact Grok PID if the recorded host exits without its child.
- A live PID whose process identity cannot currently be read is no longer treated as stopped. Repair retries the probe and fails closed with `GROK_ORPHAN_REPAIR_IDENTITY_UNKNOWN` instead of marking the TUI repaired or opening a duplicate session.

## [0.3.4] - 2026-08-22

### Fixed

- Grok Leader's gateway-wrapped `_x.ai/folder_trust/request` now unwraps its nested logical method and `params` before validation, so a real native trust screen is reported as `needs_workspace_trust` instead of the compatibility fallback `awaiting_session_registration`.
- Interaction waits flush pending dirty progress before blocking, preventing an unreferenced heartbeat timer from leaving fresh agent activity invisible until a later poll.

## [0.3.3] - 2026-08-21

> Development milestone included in the 0.3.4 release; no standalone 0.3.3 tag was published.

### Added

- The ACP client now advertises Grok's structured `x.ai/folderTrust.interactive` capability for visible sessions and handles both the logical `x.ai/folder_trust/request` method and its ACP-prefixed `_x.ai/folder_trust/request` wire form. Payloads contain the session, cwd, workspace, and gated config kinds.
- Interaction and status views expose `needs_workspace_trust` separately from ordinary tool permissions and form elicitation.

### Fixed

- A visible TUI waiting at Grok's workspace-trust screen is persisted as a live activation state, remains busy across daemon/frontend restarts, and is reused by repeated `/grok_execute on` calls instead of opening duplicate terminals.
- Supervisor never auto-trusts a workspace: it answers the ACP trust request only after the owned visible TUI registers the session, proving the user passed Grok's native confirmation screen.

## [0.3.2] - 2026-08-21

### Added

- Terminal progress now exposes bounded `changedFiles` and `commandsRun` candidate lists, matching truncation flags, and `needsHostVerification` for targeted host acceptance.
- Completed runs report the number of distinct ACP agent messages captured. Split multi-message responses are preserved in order before the existing inline-versus-artifact handoff.
- Tool and plan updates that arrive after cancellation, completion, or without a matching active run leave throttled `inactive_run_activity` metadata without journaling raw payloads.

### Changed

- The host skill and supervision data-flow reference now define `phase`, `responseChars`, `messageCount`, `lastChunkAt`, `heartbeatAt`, `newActivity`, terminal acceptance hints, and the structured journal events.
- Plain diff inspection is classified as locating, while `diff --check` remains verifying; `checkout` no longer matches the check verifier heuristic.

### Fixed

- Completion no longer replaces a multi-message response with only its last `messageId`, preventing earlier report sections from being silently discarded.

## [0.3.1] - 2026-08-21

### Fixed

- Codex now receives the Supervisor MCP server through an inline plugin-manifest entry with a plugin-relative bundled entrypoint. The separate `.mcp.json` remains unchanged for Claude Code, so both hosts resolve the same server in their native format.

## [0.3.0] - 2026-08-21

### Added

- ACP plan and tool-call updates now produce compact `locating`, `modifying`, `verifying`, `executing`, and terminal progress stages with bounded file, tool, and response counters.
- Progress snapshots distinguish Supervisor liveness from actual Grok activity through `heartbeatAt`, `lastChunkAt`, and `newActivity` semantics.

### Changed

- Repeated `available_commands_update` payloads are hashed per session. Unchanged capability lists are omitted from the journal, while changes record only bounded names, counts, and hashes.
- The compatibility frontend preserves structured progress from current daemons while still suppressing cumulative text from older daemon versions.

### Fixed

- Silent heartbeats no longer claim new Grok activity or create unbounded journal traffic.
- Prompt completion, failure, cancellation, and disconnect stop progress timers without interrupting persistent session data.

## [0.2.0] - 2026-08-20

### Added

- `/grok_init` discovers, verifies, and persists the local proxy without opening a session.
- `/grok_execute on` binds the current workspace and immediately reuses or opens its visible Windows Terminal TUI; `off` leaves executor mode without cancelling work.
- Compact cursor-based progress delivery suppresses cumulative output. Long terminal results are persisted as artifacts with a path, byte size, SHA-256, and short summary.
- Host identity, writer leases, process identity checks, and durable session ownership prevent unrelated Codex, Claude Code, or Grok processes from being adopted or mislabeled.
- The installed MCP frontend and persistent daemon are bundled entrypoints; Codex and Claude Code do not need to run `npm install` inside the plugin cache.

### Fixed

- The persistent Supervisor daemon now runs from a content-addressed user runtime instead of a versioned plugin cache directory. Together with the existing persistent TUI runtime, this prevents post-0.2.0 updates from being blocked by the daemon's Windows working-directory lock.
- Idle daemons roll to a new version or runtime fingerprint. Active TUI, ACP, permission, and prompt state is never interrupted merely to apply an update.

### Upgrade note

- The first upgrade from 0.1.0 or earlier may still require fully exiting plugin hosts and stopping old cache-resident processes once. See the README update section for the scoped PowerShell command.

[0.2.0]: https://github.com/Vanyangyang/cursor-bridge/releases/tag/cursor-bridge--v5.4.0
[0.3.0]: https://github.com/Vanyangyang/cursor-bridge/releases/tag/grok-build-supervisor--v0.3.0
[0.3.1]: https://github.com/Vanyangyang/cursor-bridge/releases/tag/grok-build-supervisor--v0.3.1
[0.3.2]: https://github.com/Vanyangyang/cursor-bridge/releases/tag/grok-build-supervisor--v0.3.2
[0.3.3]: https://github.com/Vanyangyang/cursor-bridge/compare/grok-build-supervisor--v0.3.2...grok-build-supervisor--v0.3.4
[0.3.4]: https://github.com/Vanyangyang/cursor-bridge/releases/tag/grok-build-supervisor--v0.3.4
