# Cursor diagnostic probes

These scripts are manual diagnostics and are not part of the installed plugin runtime or the automated test suite.

- Run them from the repository root with `node scripts/probes/<script>.mjs`.
- Review each script before use. Some probes only inspect CDP state, while others open Cursor UI or send a bounded diagnostic query.
- Some probes write JSON to the ignored repository-local `.artifacts/` directory; the CDP probes below emit JSON to stdout.

- `probe-cdp-health.mjs --extended`: HTTP and per-page WebSocket checks for 30 seconds, without input or lifecycle changes.
- `probe-pinned-selection.mjs [--model-submenu-open]`: validates the already-selected Fable 5.1/high using the production picker path; opens/closes menus but refuses a model or effort change and sends no prompt.
- `probe-fresh-task-cdp.mjs`: creates one read-only FIFO task and captures menu hit tests, phase timing and concurrent HTTP health. This operates the real Cursor UI; do not run alongside another UI-owning task. Its prompt reads only package.json.
