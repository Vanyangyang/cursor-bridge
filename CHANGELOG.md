# Changelog

All notable changes to Cursor Bridge are documented here.

The project follows [Semantic Versioning](https://semver.org/).

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
