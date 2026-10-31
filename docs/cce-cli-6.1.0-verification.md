# Cursor Bridge 6.1.0 CCE source verification

Date: 2026-10-31. Scope: persistent CCE CLI/IDE source selection and the Windows Cursor Agent CLI `2026.10.22-27dcf5f`.

## Contract

`cursor_cce(action="set", source="cli"|"ide")` writes the user-config `cursor-bridge/cce-source.json` atomically. Missing settings default to IDE; malformed or future settings fail explicitly. The `cce` skill and command implement `/cce cli`, `/cce ide`, and read-only `/cce`. Some hosts namespace plugin commands. No native Cursor model or permission configuration is rewritten.

Both sources share CCE's query/provenance prompt, workspace admission, FIFO scheduling, model snapshot, normalized `CCE_SEARCH_RESULT` and explicit result collection. A source switch affects later requests. CLI uses native Ask mode and advertised explicit model/effort selection, with stdin rather than shell interpolation. Initialization validates the filesystem scope without launching IDE. Multi-root JSONC workspace files map every directory to `--workspace` or `--add-dir`; filesystem shares follow the existing workspace-binding semantics, while SSH/cloud provider URIs are rejected.

CLI output must prove one initialization, the exact model and effort, canonical working directory, consistent session identity and one successful terminal result followed by exit code zero. Intermediate text is never returned as a complete answer. Timeout, cancellation and malformed streams attempt owned-process-tree cleanup. An unexpectedly exited parent cannot by itself prove that detached descendants stopped: uncertain termination holds the existing global reservation and exposes the CLI task/process identity. It never drives IDE Agent History to recover a CLI task. Error diagnostics suppress raw provider stderr.

The official CLI persists `--model` into its native preferences. Both metadata checks and retrieval therefore use a private `CURSOR_CONFIG_DIR`, copying `cli-config.json` and `permissions.json` so original permission semantics are preserved. Only private Bridge-recursion deny rules are added. Native authentication, global/project MCP configuration and project rules keep their native paths; auth/session files are not copied. Confirmed completion removes the private copy; uncertain termination retains its path with diagnostics. A native Auto default affected during early discovery was restored before the isolated acceptance below.

## Evidence

- Native metadata advertised `grok-4.7-high`; an initial no-tools Ask probe returned `model:"Grok 4.7 256K High"`, the exact working directory, one consistent session and a successful result, exit code 0. No other model was submitted.
- Regression verifies source persistence across independent Node processes, identical CCE prompts/results, queued-source/model snapshots, workspace rejection before dispatch, CLI-only initialization, cancellation/disconnect, all multi-root arguments, explicit model/effort and malformed-stream boundaries.
- A local Node parent/child regression proves that a truncated stream after parent exit remains uncertain when its detached child survives. The regression terminates its own child afterward. Timeout regressions verify owned-process cleanup. Standard Authorization headers and JSON API-key stderr are not exposed.

- The rebuilt 6.1.0 MCP bundle initialized and retrieved real source evidence with CDP port 1 unavailable and IDE autolaunch disabled. CLI task `cursor-mvw8ftgh-1`, session `a8d4eca7-5793-44de-9d39-8f9a42a42de3`, completed with `cursor_cli_init`, `grok-4.7-high`, a complete collected `CCE_SEARCH_RESULT`, and the exact expected workspace. Returned `server.mjs` and preference-module anchors were checked against source.
- Setting CLI survived a server restart, then setting IDE survived another restart. These acceptance runs used isolated source/workspace/model settings. Real user model preferences were byte-for-byte unchanged. All actual model requests used Grok 4.7/high.
- The private-profile run `cursor-mvw98szb-1`, session `143c8c5e-602d-4b50-8acd-4785044a71a5`, completed real retrieval with `grok-4.7-high`. Both native CLI configuration/permissions and Bridge model-preference files remained byte-for-byte unchanged. Its source anchors were checked against the live files.
- Final repository regression: 548/548 passed. Unchanged Supervisor regression: 147/147 passed. Rebuilt MCP protocol smoke passed with nine tools and unchanged isolated model settings; plugin/skill validators and wrapper staging passed. Closing-race regressions confirm that cancelled metadata checks cannot enqueue new work, queued cancellation settles immediately, and unconfirmed cancellation retains its structured task/process identity.

The broader historical IDE acceptance baseline remains unchanged. A development IDE CCE request timed out and recovered an unrelated answer; that answer was rejected as evidence and was not used to validate this feature. This release does not claim a new full IDE, macOS or Linux real-device acceptance matrix.

Cursor's [CLI parameters](https://cursor.com/docs/cli/reference/parameters) and [output protocol](https://cursor.com/docs/cli/reference/output-format) document the native invocation and terminal stream contract. Native capabilities remain those provided by the selected Cursor surface; Ask mode is not an operating-system filesystem sandbox.
