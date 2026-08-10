---
name: cce-routing
description: "Use Cursor Bridge's read-only cursor_context_engine for unfamiliar project understanding when the exact code location is unknown or the task requires tracing behavior, symbols, callers and callees, data flow, registrations, interface implementations, ownership boundaries, or cross-module relationships. Trigger for questions such as where something is implemented, what owns state, how a project flow works, or when local search would otherwise guess paths or repeat blind queries. Do not use for a known exact file or symbol, content already loaded in context, trivial single-file edits, tests, logs, builds, Git work, external documentation, or when the user opts out of Cursor. Verify returned path:line evidence in the real files."
---

# CCE Routing

Route project-understanding questions to the cheapest evidence surface that can answer them without guessing.

## Choose CCE for project semantics

Call `cursor_context_engine` when one or more of these are true:

- The implementation location is unknown and finding it locally would require guessing directories or repeating broad searches.
- The question asks where or how a project behavior is implemented, what owns a state or responsibility, or why a flow behaves as it does.
- The answer requires tracing callers and callees, producer-consumer flow, configuration and registration, interface implementations, data ownership, or relationships across modules.
- An unfamiliar indexed project needs semantic context before a safe edit or review can begin.

Prefer one CCE investigation over starting an Explore subagent merely to locate or understand project code. Let Cursor choose focused or extended depth from what it discovers.

## Keep deterministic work local

Do not call CCE when any of these apply:

- The exact file, symbol, or location is already known and a direct read or exact search is sufficient.
- The needed code is already present in the current context.
- The work is a trivial single-file edit or only requires running tests, inspecting logs, checking a build, or examining Git state.
- The question concerns external libraries, APIs, current documentation, or the public web.
- The user opted out of Cursor, CCE is unavailable, or the workspace is not initialized.

Do not submit the same lookup to CCE and another semantic system in parallel. Use a second evidence surface only to close a specific gap or verify a consequential claim.

## Submit one natural-language intent

Call `cursor_context_engine` once with the question's real intent. Include a known symbol, subsystem, or path only when it is a useful lead.

- Describe the relationship or behavior to establish and the evidence needed.
- Do not prescribe Cursor's internal search sequence, harness, Explore usage, or number of files.
- Do not invent hidden parameters; the public input is only `query`.
- Allow a cold or large workspace enough time to complete its serialized Cursor UI turn.

## Verify and continue

Treat CCE output as evidence leads, not final authority.

1. Read the returned workspace-relative `path:line` anchors in the real working tree before relying on them.
2. Distinguish exact references and demonstrated flows from semantic similarity.
3. If CCE returns `NOT_FOUND` or names gaps, report those gaps or perform one bounded fallback search; do not guess from framework convention.
4. Keep edits, final review, tests, and acceptance with the primary agent unless a separate bounded delegation is appropriate.

CCE is strongly prompted and audited for read-only investigation, but it is not a filesystem sandbox. Preserve user changes and normal workspace safety boundaries.
