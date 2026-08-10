# Changelog

All notable changes to Cursor Bridge are documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[3.0.0]: https://github.com/Vanyangyang/cursor-bridge/compare/cursor-bridge--v2.2.3...cursor-bridge--v3.0.0
