# Changelog

All notable changes to Cursor Bridge are documented here.

The project follows [Semantic Versioning](https://semver.org/).

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
