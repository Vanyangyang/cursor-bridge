# Changelog

Notable Grok Build Supervisor changes are documented here. The plugin has its own version and install lifecycle even though it shares this repository and marketplace with Cursor Bridge.

## [Unreleased]

## [0.2.0] - 2026-08-20

### Added

- `/grok_init` discovers, verifies, and persists the local proxy without opening a session.
- `/grok_execute on` binds the current workspace and immediately reuses or opens its visible Windows Terminal TUI; `off` leaves executor mode without cancelling work.
- Compact cursor-based progress delivery suppresses cumulative output. Long terminal results are persisted as artifacts with a path, byte size, SHA-256, and short summary.
- Host identity, writer leases, process identity checks, and durable session ownership prevent unrelated Codex, Claude Code, or Grok processes from being adopted or mislabeled.

### Fixed

- The persistent Supervisor daemon now runs from a content-addressed user runtime instead of a versioned plugin cache directory. Together with the existing persistent TUI runtime, this prevents post-0.2.0 updates from being blocked by the daemon's Windows working-directory lock.
- Idle daemons roll to a new version or runtime fingerprint. Active TUI, ACP, permission, and prompt state is never interrupted merely to apply an update.

### Upgrade note

- The first upgrade from 0.1.0 or earlier may still require fully exiting plugin hosts and stopping old cache-resident processes once. See the README update section for the scoped PowerShell command.

[0.2.0]: https://github.com/Vanyangyang/cursor-bridge/releases/tag/cursor-bridge--v5.4.0
