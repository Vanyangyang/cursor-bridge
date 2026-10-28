# Cursor Bridge 6.0.10 verification

Date: 2026-10-28. Scope: searchable local-project selection and model parameter controls in Cursor Agents Window on Windows.

## Reproduced failures

The installed Cursor package and executable both report 3.27.22. Its project selector opens a `search-menu-popup` dialog containing a listbox. Recent rows show project names rather than complete paths. The released 6.0.9 selector returned `workspace_project_option_unavailable` with `menuCount: 0` against this dialog.

Selecting an already-current project can leave the project dialog and its backdrop open. Workspace identity verification still succeeds, but the backdrop covers the model trigger. The repair closes only the unique expanded project trigger whose displayed complete path matches the requested target, then rejects a dialog that remains open.

The model menu exposes a row-owned `parameter-edit-btn`. It can remain hidden until that row is hovered; hovering alone opens a preview instead of the effort submenu. Moving the pointer to the exact composer trigger before Escape prevents the preview from repeatedly consuming menu dismissal.

## Selection boundaries

Project rows retain the existing committed React parent/child proof, local file-URI checks, conflicting-identity rejection, and final root-current check. The selector additionally matches the registered workspace ID, distinguishes same-path Worktree entries, and obtains a search input from the owning dialog even when it is outside the listbox. Missing, ambiguous, remote, disabled, or stale identities remain pre-submission failures.

Model menus remain linked to the unique writable composer through the existing accessibility ownership checks. Edit controls must be unique and enabled within the matched model row; hidden controls are revealed before obtaining fresh coordinates. Lost or duplicate row identity cannot reuse a previous Edit position. Cleanup rejects an owner change.

## Validation

- All four runtime bundles rebuilt from the release checkout. Repository regression passed 479/479 without failures or skips. The unchanged Supervisor passed 147/147 and its six-tool stdio smoke.
- Root, staged Pi 0.2.10, and staged generic MCP 0.1.8 stdio checks confirmed embedded version 6.0.10, eight tools, two pre-submission workspace rejections, and unchanged isolated model settings. Both package file lists contain the dependency-free bundle and skills.
- Claude plugin and marketplace validation passed. Codex manifest and version synchronization passed the repository contract tests; the installed Codex CLI does not expose a separate validate subcommand.
- A new stdio adapter running the rebuilt 6.0.10 bundle initialized the exact registered local workspace in Cursor 3.27.22 Agents Window. A CCE query returned its `CCE_SEARCH_RESULT` evidence block; the definition anchor was independently verified in that selected checkout.
- Read-only FIFO task `cursor-mvs1jyw9-2` completed with `sendState=sent`, requested `grok-4.7/high`, applied `Grok 4.7 High`, and explicit terminal result collection. Its reply confirmed receipt of the connectivity check. No implementation work was delegated to that live task.
- A separate read-only review reproduced a composer switch during hidden Edit reveal; the added owner checks and two regression cases now reject both cross-owner coordinates and parameter results.

All new live checks used Grok 4.7/high. The local model policy is managed separately from the published Bridge package; this patch does not alter another installation's saved model defaults.

The completed broader 6.0.8 / Cursor 3.23.12 baseline remains unchanged in `compatibility.json`. This patch does not claim a complete 3.27.22 IDE, parallel-Agent, persistent-session, cancellation, startup, or hidden-mode acceptance matrix. Existing host MCP processes must reload before they use a rebuilt bundle.
