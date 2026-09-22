---
name: cce-routing
description: "Use Cursor Bridge's read-only cursor_context_engine for unfamiliar project understanding when the exact code location is unknown or the task requires tracing behavior, symbols, callers and callees, data flow, registrations, interface implementations, ownership boundaries, or cross-module relationships. Trigger for questions such as where something is implemented, what owns state, how a project flow works, or when local search would otherwise guess paths or repeat blind queries; for these semantic questions, try CCE before generic context-mode or grep discovery. Do not use when a known exact file or symbol can answer the question through direct reading or exact search, for content already loaded in context, trivial single-file edits, tests, logs, builds, Git work, external documentation, or when the user opts out of Cursor. Verify returned path:line evidence in the real files."
---

# CCE Routing

`cursor_context_engine` automatically inherits the persistent CCE model and reasoning-effort default configured through `cursor_model`. Do not change or reset that default unless the user explicitly asks; if selection cannot be confirmed, report the pre-send failure instead of retrying with Auto.

Route project-understanding questions to the cheapest evidence surface that can answer them without guessing.

## Choose CCE for project semantics

Call `cursor_context_engine` when one or more of these are true:

- The implementation location is unknown and finding it locally would require guessing directories or repeating broad searches.
- The question asks where or how a project behavior is implemented, what owns a state or responsibility, or why a flow behaves as it does.
- The answer requires tracing callers and callees, producer-consumer flow, configuration and registration, interface implementations, data ownership, or relationships across modules.
- An unfamiliar indexed project needs semantic context before a safe edit or review can begin.

Prefer one CCE investigation over starting an Explore subagent merely to locate or understand project code. Let Cursor choose focused or extended depth from what it discovers.

When these semantic conditions match, make CCE the first project-discovery surface. Do not establish the answer through generic context-mode, grep, or blind local exploration before trying CCE. If Claude Code denies an initial context-mode collection call with a CCE routing message, call `cursor_context_engine` once instead of retrying another `ctx_*` tool. A failed, denied, unavailable, or `NOT_FOUND` CCE attempt releases this priority and allows a bounded local fallback. A pre-send workspace-confirmation error may be recoverable; handle it below before falling back.

## Keep deterministic work local

Do not call CCE when any of these apply:

- The exact file, symbol, or location is already known and a direct read or exact search is sufficient.
- The needed code is already present in the current context.
- The work is a trivial single-file edit or only requires running tests, inspecting logs, checking a build, or examining Git state.
- The question concerns external libraries, APIs, current documentation, or the public web.
- The user opted out of Cursor or CCE is unavailable.

Do not submit the same lookup to CCE and another semantic system in parallel. Use a second evidence surface only to close a specific gap or verify a consequential claim.

## Bind a known workspace before sending

Pass the intended absolute `workspace_path` to `cursor_context_engine` when the installed schema supports it. Use the host-provided workspace root/current-task cwd unless the request explicitly targets another project. The field asserts the target before sending; it never switches or registers a project. Do not infer the target from a repository basename or a saved default binding.

For an older schema without `workspace_path`, use `cursor_status` to verify the exact ready project path before sending. `initialized=true` only shows that a binding exists; it does not prove the current request is confirmed for the intended workspace. `cursor_init` is the only explicit operation that may initialize, register, or switch a workspace.

If no target is known, do not infer or add `workspace_path`, and never call `cursor_init` for a guessed path. Existing safe host bindings may still be used; a workspace-confirmation error without a known target cannot use this recovery and should be reported before any necessary local fallback.

## Recover one known workspace

For a pre-send `WORKSPACE_CONFIRMATION_REQUIRED`, `WORKSPACE_INITIALIZATION_REQUIRED`, or `WORKSPACE_MISMATCH` error with a known target:

1. Call `cursor_status`. Continue only when it confirms idle, no queued or blocking work, and `workspaceBusy=false` when that field is exposed.
2. Call `cursor_init` with that exact absolute path. Require `ready=true`, `workspaceConfirmationRequired=false`, and the exact `projectPath`; in Agents Window also check `workspaceBinding.ok`, the local file-URI identity and workspace ID.
3. Retry the original CCE query once.

Do not treat these errors as CCE unavailability before this recovery. Do not initialize when status is busy, identity is ambiguous, `needs_attention` is present, or send state is uncertain; explain the condition and use only the necessary local fallback. Do not cancel other work, change the model, or retry in a loop.

## Submit one natural-language intent

Call `cursor_context_engine` once with the question's real intent. Include a known symbol, subsystem, or path only when it is a useful lead.

- Describe the relationship or behavior to establish and the evidence needed.
- Preserve the language of the user's current substantive request unless the user explicitly asks for another language. Do not infer or persist a different language from the operating system when the conversation already provides a clear signal.
- Do not prescribe Cursor's internal search sequence, harness, Explore usage, or number of files.
- Keep investigation intent in `query`. Use the optional `request_context` only to declare provenance: AI callers use `sender="model"`; `source` is `user`, `model`, `mixed`, or `unknown`. A retrieval question you inferred is model-authored even when it serves a user goal. Separate user requirements and your additions when using `mixed`; never guess missing provenance.
- Allow a cold or large workspace enough time to complete its serialized Cursor UI turn.

## Verify and continue

Treat CCE output as evidence leads, not final authority.

1. Read the returned workspace-relative `path:line` anchors in the real working tree before relying on them.
2. Distinguish exact references and demonstrated flows from semantic similarity.
3. If CCE returns `NOT_FOUND` or names gaps, report those gaps or perform one bounded fallback search; do not guess from framework convention.
4. Keep edits, final review, tests, and acceptance with the primary agent unless a separate bounded delegation is appropriate.

Explain the result in the language of the user's current task unless an explicit language override applies. Preserve `CCE_SEARCH_RESULT`, field names, enum values, `NOT_FOUND`, paths, symbols, line anchors, hashes, IDs, commands, and error/status codes verbatim. When a result was authored in another host task or language, keep the evidence unchanged and explain it in the current task language rather than rewriting the artifact.

CCE is strongly prompted and audited for read-only investigation, but it is not a filesystem sandbox. Preserve user changes and normal workspace safety boundaries.
