# Changelog

All notable changes to Cursor Bridge are documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [5.5.0] - 2026-08-25

### Added

- `pi-cursor-bridge` and `pi-grok-build-supervisor` are now available as independent npm packages for Pi. Each package embeds only its own product, tools, and Skills.
- Cursor Bridge now defines one language contract across CCE, `cursor_do`, recovery, and host Skills: narrative output follows the current task language while machine fields and exact options remain stable.

### Changed

- CCE and `cursor_do` use canonical English internal scaffolds, preserve the original multilingual query or task, and explicitly request a matching-language result unless the user asks otherwise.
- Recovery, validation, task-control, and direct adapter diagnostics now use canonical English so every host can localize them consistently instead of inheriting Chinese-only messages.
- `cursor_do` is presented as a first-class bounded execution path while CCE remains the default project-understanding route and the supervising host retains final verification.

### Fixed

- The Cursor Bridge Pi package now isolates its host and workspace identity from inherited Codex or Claude Code environment variables, so launching Pi from another Agent still binds Cursor to Pi's actual working directory.
- Pi MCP calls now have a bounded 15-minute client timeout instead of the SDK's 60-second default, allowing cold Cursor CCE searches and other legitimately long plugin operations to finish without an adapter-side timeout.
- The Pi publisher no longer skips an existing version by number alone; it compares the local dry-run tarball shasum with npm and fails when immutable contents differ.
- A custom `completion_contract` no longer drops the `cursor_do` response-language contract; task language and immutable machine tokens remain explicit on every delegated path.
- CCE result normalization restores a missing evidence bullet when Cursor returns a valid `path:line | ...` row without `-`, keeping the machine envelope stable without changing evidence content.
- Cursor Agents v2 distinguishes a selected-composer provisional ID from a durable History row. An uncertain submitted Agent now keeps its exact provisional identity under a global reservation, preventing another parallel submission from replacing it before it can be safely monitored or recovered.
- The opt-in legacy Workbench cancellation smoke test now checks that Cursor actually exposes a legacy CDP target before submitting. Agents-Window-only launches report a clean skip instead of sending a Workbench test into Agents v2.

### Compatibility

- Live-tested Cursor **3.17.19** on Windows 11 through a fresh Bridge/CDP launch for workspace binding, CCE with source-anchored evidence, read-only FIFO, independent `parallel_agent` execution, exact Agent IDs, matching-language results, and CCE across normal/minimal presentation changes.
- The fresh 3.17.19 launch exposed only the Agents Window as a CDP page target. Legacy IDE/workbench behavior is therefore not claimed for this pairing; the dedicated Workbench smoke now skips before submission when that surface is absent.

## [5.4.2] - 2026-08-22

### Fixed

- Cursor 3.17.8 Agents v2 now works when `section.headers` exposes selection through `rowHandlers.onSelect` instead of colocating `onSelectAgent` on the same React props object. The earlier Cursor shape remains supported.
- A newly created Cursor 3.17.8 Agent can exist first only as the current `selectedAgentId` and visible composer before History inserts its header. Cursor Bridge now exposes that draft identity with its live composer status, so `parallel_agent` can bind, monitor, collect, and cancel the exact Agent without falling back to FIFO.

### Compatibility

- Live-tested Cursor **3.17.8** on Windows 11 IDE/workbench and Agents Window for fresh Bridge/CDP launch, workspace binding, CCE, FIFO, independent parallel Agent execution, asynchronous status, exact cancellation, and CCE across normal/minimal presentation changes.

## [5.4.1] - 2026-08-20

### Fixed

- Cursor 3.16.29 provider-error trays no longer depend solely on the removed `.ui-tray-header__title` class. Cursor Bridge now falls back to the visible tray title text while preserving the earlier selector path, and still never clicks `Try again` or dismisses the tray.

### Compatibility

- Live-tested Cursor **3.16.29** on Windows 11 through the IDE/workbench for CCE, FIFO, parallel Agent execution, task status/control terminal guards, and normal/minimal presentation. Agents Window selector contracts were checked against the installed 3.16.29 bundle, but Agents Window has not yet completed live acceptance on this patch.

## [5.4.0] - 2026-08-20

### Fixed

- Windows normal runtime now applies a throttled, non-activating compositor refresh when it reuses Cursor Agents. This covers the white Electron surface case where CDP, the workbench DOM, and the prompt input are all healthy, so a DOM reload would not trigger.
- Cursor Bridge now runs its persistent lifecycle supervisor from a content-addressed user runtime and moves the MCP adapter out of the versioned plugin cache after startup. After the one-time migration from 5.3.6 or earlier, a running supervisor no longer blocks normal plugin cache replacement on Windows.
- Grok Build Supervisor 0.2.0 applies the same cache-independent lifecycle to its daemon while preserving its already persistent TUI runtime. Idle daemons roll forward by version and runtime fingerprint; active Grok work is left alone until it is safe to switch.
- Grok Build Supervisor now ships bundled MCP and daemon entrypoints, so a marketplace install does not depend on `node_modules` being present inside the plugin cache.

### Upgrade note

- The first upgrade from Cursor Bridge 5.3.6 or earlier, or Grok Build Supervisor 0.1.0 or earlier, can still require fully closing plugin hosts and stopping the old cache-resident supervisors once. Future updates use the normal marketplace commands; open tasks still need a reload or a new task before they consume newly installed MCP and Skill code.

## [5.3.6] - 2026-08-15

### Fixed

- Workbench FIFO can publish an Agent ID and use targeted cancel when that identity is available. If it is not, cancel stays on the previous unbound FIFO path and does not guess-click Stop.

## [5.3.5] - 2026-08-15

### Fixed

- Running FIFO tasks can publish an Agent ID. `cursor_task_control` cancel then uses that exact ID to Stop. FIFO tasks that never publish an ID still do not guess-click Stop.

### Compatibility

- Live-tested Cursor versions remain **3.16.17** and **3.7.42** (workbench and Agents Window). Other versions have not been tested.

## [5.3.4] - 2026-08-14

### Changed

- Bump the published plugin version to **5.3.4** so Grok / marketplace registry records a version change after the 5.3.3 live pass and GitHub release notes. Runtime behavior is unchanged from 5.3.3.

## [5.3.3] - 2026-08-14

### Fixed

- Cursor is never launched with a privileged CDP port. `CURSOR_BRIDGE_CDP_PORT=1` (used by tests as a sinkhole) can no longer steal the real Cursor instance onto `127.0.0.1:1`. Launch args fall back to `9223`.

## [5.3.2] - 2026-08-14

### Fixed

- `cursor_status` now has an 8-second hard timeout at the MCP boundary and always reports `pluginVersion`. A wedged CDP page can no longer keep the tool running until the host's one-hour client timeout.

## [5.3.1] - 2026-08-14

### Fixed

- When Agents Window is already open, CCE ensure reuses the `Cursor Agents` page instead of spawning `Cursor.exe --new-window`. That extra workbench ignored Cursor's Window Restoration setting, often restored an unrelated last folder, and could blank Agents Window.
- `cursor_status` now reads `/json/list` only. It no longer runs `Runtime.evaluate` on every page, so a white Agents Window cannot stall the tool for minutes.
- CCE page selection times out probes in 5 seconds and reloads a blank Agents Window once before failing over.

## [5.3.0] - 2026-08-14

### Added

- Official Grok Build plugin support: install from this repository, `--trust` plus `enable`, and `/plugins` reload. Grok loads the same `cce-routing` and `cursor-delegate` skills after the plugin is enabled.

### Fixed

- Cursor 3.16.17 Agents Window can use the current project again. If Agents Window is unavailable, CCE uses the workbench.

### Compatibility

- Live-tested Cursor versions: **3.16.17** and **3.7.42** (workbench and Agents Window). Other versions have not been tested.

## [5.2.1] - 2026-08-10

### Fixed

- Switching from `minimal` to `normal` now wakes stale Windows Electron composition surfaces with a non-activating, one-pixel size pulse for ordinary windows, then restores the exact original geometry. It does not call foreground APIs or use activating `SW_RESTORE`.
- Long-lived Codex and Claude Code adapters now re-read the persisted runtime mode before status and Cursor lifecycle operations, preventing an adapter that cached `minimal` from hiding Cursor again after another adapter switched to `normal`.

## [5.2.0] - 2026-08-10

### Added

- Added a narrow Claude Code routing hook that recognizes high-confidence project-semantic questions and asks Claude to try `cursor_context_engine` before generic context collection.
- Added a bounded, session-scoped guard for competing context-mode calls: at most two are redirected, a CCE attempt clears the guard immediately, and every lock or state failure falls open.

### Changed

- CCE routing now treats known symbols as valid starting points for callers, data-flow, registration, and cross-module tracing while leaving direct known-file and known-symbol reads on native tools.
- Explicit Cursor/CCE opt-outs, external-document lookups, tests, logs, builds, Git inspection, and direct deterministic work are never intercepted.

## [5.1.0] - 2026-08-10

### Added

- Added one shared `cce-routing` Skill for Codex and Claude Code. It routes unknown implementation locations, behavior tracing, ownership, registrations, interfaces, data flow, and cross-module project understanding to `cursor_context_engine`, while keeping exact known-file work and non-project lookups on cheaper native paths.

### Changed

- The public CCE tool description now exposes explicit use and skip conditions before invocation, while continuing to let Cursor choose the internal investigation depth.
- Codex `defaultPrompt` entries are now three short user-facing starters; automatic routing guidance lives in the versioned Skill instead of being presented as UI starter text.

## [5.0.1] - 2026-08-10

### Fixed

- Windows lifecycle startup now fails closed when the hidden WMI launch is unavailable. The former opt-in `cmd.exe start` trampoline was removed so Bridge-owned recovery cannot flash a Node console or leave an unreliable orphan.
- Windows Cursor discovery and running-process probes now call `reg.exe` and `tasklist.exe` directly with hidden stdio instead of passing command strings through `cmd.exe`.
- Showing Cursor or returning to normal runtime now uses a non-activating window restore and no longer calls `SetForegroundWindow`, so Bridge does not deliberately take keyboard focus from Codex, Claude Code, or a terminal.

## [5.0.0] - 2026-08-10

### Removed

- Removed public `cursor_launch`; initialization and every CCE/execution request already ensure Cursor automatically. The unlisted compatibility handler remains for clients that cached the old tool.
- Reduced public `cursor_runtime` to one persistent `mode` parameter (`normal` or `minimal`). Temporary `show` / `hide` actions and session scope remain internal implementation details.
- Removed public `new_chat` from `cursor_do`; FIFO now consistently presents itself as a first-in, first-out serial queue that starts bounded work in a clean chat.

### Changed

- `cursor_init` now represents complete CCE initialization rather than a raw binding step: it validates and persists the workspace, discovers Cursor, ensures the lifecycle connection, and verifies the correct project target.
- An already-running Cursor without CCE access now returns a structured, child-friendly recovery result. The binding stays saved, Cursor is never force-closed, and the only required action is to save, exit Cursor once, and repeat the same initialization sentence.
- Cursor executable overrides accept quoted Windows paths, Windows installation directories, macOS `.app` bundles, or direct executable paths. Standard Windows registry/install locations and standard macOS application locations remain automatic.
- `cursor_init` now accepts only an absolute project directory or `.code-workspace` file, while still normalizing Windows extended paths, quoted paths, and macOS home-relative paths.

### Fixed

- Corrected README and tool wording for workspace/environment precedence, FIFO clean-chat behavior, minimal-mode recovery, and Cursor-owned project indexing.

## [4.0.0] - 2026-08-10

### Removed

- Removed `cursor_policy`, its four participation levels, persistent policy storage, environment overrides, and policy skill. `cursor_do` now has one fixed bounded-execution contract, while the administrator-only `CURSOR_BRIDGE_DELEGATION=off` kill switch remains.
- Removed the plugin init slash wrapper. Codex and Claude Code now use the same natural-language instruction, `Initialize CCE workspace to ...`, mapped to `cursor_init({path})`.

### Changed

- Fresh installations now default to visible `normal` runtime. `minimal` is an explicit, persistent opt-in whose warning explains that the single-instance window remains hidden until CCE shows it or switches back to normal.

## [3.2.0] - 2026-08-10

### Added

- Added one-parameter `cursor_init({path})` workspace initialization. Bindings are isolated per Codex task or Claude Code project, persist outside plugin caches, and can be replaced by re-running init.

### Fixed

- New Agents Window requests are now created from the initialized repository section instead of the global `Home` context; missing or ambiguous repositories fail closed.
- Cached Editor target IDs are revalidated against the requested project before reuse, preventing a surviving `cursor-bridge` window from being selected for another workspace.

### Changed

- Cursor UI preference remains user-owned. Bridge prefers Agents v2 only when it is already available and otherwise adapts to the legacy workbench.

## [3.1.0] - 2026-08-10

### Fixed

- Minimal mode now prewarms the hidden CDP runtime before ordinary **Open in Cursor** actions can claim Cursor's default single-instance slot without port 9223.
- Adapter project paths are forwarded explicitly through the persistent lifecycle supervisor instead of depending on the supervisor's working directory.
- When a shared CDP Cursor is already serving another project, Bridge now opens the requesting adapter's project in a new Cursor window, waits for its CDP target, and selects that target. It fails closed as `workspace-not-ready` instead of searching the wrong index.
- Installed Codex adapters now resolve the real task workspace through `CODEX_THREAD_ID` and read-only local thread metadata before falling back to process cwd, preventing plugin-cache cwd from silently selecting the wrong Cursor window.
- The Windows window guard follows the actual CDP listener PID, remains owned by the supervisor for that Cursor lifetime, and still supports reversible `show` / `hide` overrides.
- Showing a minimal-runtime Cursor now forces native restore/redraw on existing Electron windows, fixing populated Agents targets that reopened as a white compositor surface.
- FIFO and parallel submissions now require positive UI acknowledgement. A prompt that remains in Cursor's input editor gets one exact Send-button fallback and then fails quickly as `submit_not_accepted` without being treated as a sent orphan.

### Changed

- Fresh installations now default to the silent `minimal` runtime; `normal` remains available explicitly through `cursor_runtime` or `CURSOR_BRIDGE_RUNTIME_MODE`.
- Replaced the advertised `cursor_search` / `cursor_search_deep` split with one adaptive `cursor_context_engine`. Its public schema now exposes only `query`; Cursor chooses its own investigation depth and available harness capabilities.

## [3.0.0] - 2026-08-10

### Added

- Added `cursor_search_deep` for read-only, minimum-sufficient investigation of call chains, data flows, registrations, interfaces, and cross-module relationships.
- Added persistent `normal` / `minimal` runtime control. On Windows, minimal mode keeps the real Cursor process, project index, Agent DOM, and task queue available while suppressing top-level Cursor windows.
- Added evidence-oriented CCE output with workspace-relative ranges, anchors, verified relevance, evidence types, explicit gaps, and confidence.
- Added Cursor Agents v2 adapters and provider-error terminal evidence.

### Changed

- Refined `cursor_search` into a balanced, lower-cost locator with an explicit escalation boundary for deep investigation.
- Reworked the English and Chinese documentation around search routing, architecture, trust boundaries, recovery semantics, and professional project onboarding.
- Increased the default search completion timeout to five minutes for cold or large indexed workspaces.

### Fixed

- A partial Markdown response is no longer accepted at the timeout boundary while Cursor is still generating or the final Stop state cannot be confirmed.
- Uncertain post-send failures retain their FIFO/Agent reservation instead of silently releasing or resubmitting work.
- Cursor Agents v2 provider errors are retained as terminal evidence with Request IDs when available.

### Compatibility

- No existing MCP tool was removed.
- `cursor_search` keeps its `query`, `scope`, and `max_results` schema.
- `cursor_search_deep` uses the same schema and lifecycle path.

[5.5.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.4.2...cursor-bridge--v5.5.0
[5.4.2]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.4.1...cursor-bridge--v5.4.2
[5.4.1]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.4.0...cursor-bridge--v5.4.1
[5.4.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.3.6...cursor-bridge--v5.4.0
[5.3.6]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.3.5...cursor-bridge--v5.3.6
[5.3.5]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.3.4...cursor-bridge--v5.3.5
[5.3.4]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.3.3...cursor-bridge--v5.3.4
[5.3.3]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.3.2...cursor-bridge--v5.3.3
[5.3.2]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.3.1...cursor-bridge--v5.3.2
[5.3.1]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.3.0...cursor-bridge--v5.3.1
[5.3.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.2.1...cursor-bridge--v5.3.0
[5.2.1]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.2.0...cursor-bridge--v5.2.1
[5.2.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.1.0...cursor-bridge--v5.2.0
[5.1.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.0.1...cursor-bridge--v5.1.0
[5.0.1]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v5.0.0...cursor-bridge--v5.0.1
[5.0.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v4.0.0...cursor-bridge--v5.0.0
[4.0.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v3.2.0...cursor-bridge--v4.0.0
[3.2.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v3.1.0...cursor-bridge--v3.2.0
[3.1.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v3.0.0...cursor-bridge--v3.1.0
[3.0.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v2.2.3...cursor-bridge--v3.0.0
