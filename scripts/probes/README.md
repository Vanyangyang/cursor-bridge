# Cursor diagnostic probes

These scripts are manual diagnostics and are not part of the installed plugin runtime or the automated test suite.

- Run them from the repository root with `node scripts/probes/<script>.mjs`.
- Review each script before use. Some probes only inspect CDP state, while others open Cursor UI or send a bounded diagnostic query.
- Generated JSON is written to the ignored repository-local `.artifacts/` directory.
