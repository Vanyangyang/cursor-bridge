# Cursor Bridge 6.0.9 verification

Date: 2026-10-09. Scope: model-menu recovery, workspace selection, and native startup preference handling on Windows.

## Observed failures and fixes

On Cursor 3.23.23, a visible Select a project menu covered the model trigger. The released 6.0.8 reader correctly returned `trigger_occluded`, but opening the picker waited until its deadline and failed without dismissing the menu. The fix dismisses only a recognized non-dialog menu, at most three times, then re-reads ownership and clickable coordinates. A real replay opened the picker and confirmed Grok 4.7/high without submitting a task.

The project picker can omit registered workspaces from its short Recents view. Searching the complete path exposed the requested repository and its `dist` subdirectory; the fixed selector selected only the exact repository and independently confirmed its registered local workspace ID. A complete read-only CCE then returned source evidence from that repository with Grok 4.7/high confirmed.

On the subsequently installed Cursor 3.24.9, the official native preference was `agentWindow`, while Bridge's startup resolver previously only considered last-window records. The new resolver gives that explicit preference priority. It queries only `cursor/userWindowRestorationPreference` and `cursor/userOpenAgentsWindowOnStartupPreference`, uses a read-only connection, and closes it. Native main-key precedence and the legacy enum/boolean mapping are covered by regression tests. When built-in `node:sqlite` is unavailable or the database cannot be read, the previous last-window behavior remains available; Node 18 remains supported through that fallback.

## Evidence and limits

- The final 6.0.9 release rebuild passed repository regression 457/457 with no failures or skips. The unchanged Supervisor passed 147/147 and its six-tool protocol smoke. Root, staged Pi, and staged generic MCP protocol smokes each confirmed version 6.0.9, eight tools, two pre-submission workspace rejections, and unchanged isolated model preferences. Both npm tarball file lists were inspected.
- Cursor 3.23.23: real menu obstruction/recovery, filtered exact-workspace selection, and complete CCE submission/result collection passed. This is a focused check, not a repeat of every prior release's acceptance matrix.
- Cursor 3.24.9: installed package version and native startup preference were inspected; the resolver returned `agents_v2` with source `cursor-startup-preference` and launch arguments `--glass`.
- Cursor 3.24.9 cold launch, CCE, FIFO, parallel Agents, cancellation, and normal/minimal live acceptance remain pending. The existing user process was started without the required debug port and was not force-closed. An operating-system reboot was not performed.
- The last completed broader compatibility baseline remains the immutable 6.0.8 record for Cursor 3.23.12. It is not relabeled as new 3.24.9 evidence.
- Repairs to this machine's desktop/Start Menu shortcuts are local configuration changes, not modifications performed by the published npm packages.

## Loading the release

The product version is 6.0.9; Pi and generic MCP wrappers are 0.2.9 and 0.1.7 respectively. Existing host MCP processes must be reloaded before claiming they use the new bundle. A Cursor restart alone does not reload the host adapter. No persisted model or effort default is changed by this release.
