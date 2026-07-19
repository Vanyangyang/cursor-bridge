---
name: cursor-delegate
description: "Delegate bounded light-to-medium implementation, limited investigation, documentation, configuration, testing, and tooling work to Cursor Bridge after the primary agent owns the direction and risk boundaries. Use proactively when a bounded Cursor pass can save primary-agent time, reduce omissions, or run alongside non-conflicting work; the task needs a clear purpose, allowed scope, invariants, and checkable outcome, but not a fully pre-solved implementation. Follow the current manual, auto, active, or eager mode, collect work by task_id or agent_id, and verify it in the primary agent. Do not use when the user opts out, cursor_do is unavailable or administrator-disabled, or for product direction, architecture decisions, exclusive GUI operations, formal verification verdicts, governance state decisions, or unbounded investigation."
---

# Cursor Delegate

Use Cursor as an execution partner. Keep direction, scope decisions, risk ownership, result review, and final verification with the primary agent.

## Respect delegation controls

- Do not call `cursor_do` when the user explicitly says not to use Cursor or not to delegate. A direct user opt-out overrides every policy mode.
- If `cursor_do` is unavailable, or `cursor_status` reports delegation as disabled, do not bypass the setting, repeatedly retry, or ask Cursor to re-enable itself. Complete the work in the primary agent.
- Treat `CURSOR_BRIDGE_DELEGATION=off` as a legacy administrator-level host switch, not a user policy. It disables delegated execution but does not by itself disable `cursor_search`, `cursor_status`, `cursor_policy`, or `cursor_launch`.

## Follow the user's chosen level of involvement

Use `cursor_policy` when the user asks to inspect or change the mode. Confirm the returned choice and follow the effective value injected into the live tool descriptions and echoed by `cursor_status` later. Policy changes persist by default; `scope: session` is only for an explicit temporary override.

The mode answers “how readily should I hand suitable work to Cursor?” It is not a fixed frequency such as “call Cursor every N tool invocations.”

- `manual`: wait for the user to ask for Cursor.
- `auto`: hand off only when the scope is clean and the likely benefit clearly outweighs dispatch and review time.
- `active`: recommended default; for a non-trivial task, normally find one useful bounded implementation, test, documentation, configuration, or second-check slice to hand off.
- `eager`: use Cursor whenever a safe bounded slice exists, including small read-only probes and independent non-overlapping parallel work.

Do not offer `off` as a normal user mode. A user who wants no automatic handoff should choose `manual`; a direct “do not use Cursor” instruction still overrides the mode. The environment-level `CURSOR_BRIDGE_DELEGATION=off` switch is reserved for administrators who need to disable the tool entirely.

Do not assume that the host provides a `/cursor` slash command. Use the MCP policy tool or ordinary user instructions unless the current host exposes a verified wrapper.

## Follow the default workflow

Use this responsibility chain:

`primary agent defines purpose, invariants, and risk boundaries -> form a bounded task envelope -> Cursor investigates locally and executes within the envelope -> collect by task_id -> primary agent inspects the real changes and verifies them`

- Decide what should be achieved, why it matters, what must not change, where Cursor may work, and what evidence makes the result acceptable. Do not delegate product direction, architecture boundaries, or state verdicts.
- Allow Cursor to locate relevant implementation, compare local approaches, and complete code, documentation, configuration, scripts, tests, and tooling inside those boundaries. Do not require the primary agent to pre-solve the task line by line.
- Once a task has been selected for delegation, normally call `cursor_do` once with `background=true` and `new_chat=true`, then continue non-conflicting primary-agent work.
- Prefer `execution=fifo` unless the parallel contract is clearly satisfied.
- Do not inject a unique completion marker or impose a minimum response length. Rely on task state, stable `task_id` or `agent_id`, and the actual result.

## Decide whether this task should go to Cursor

Send a bounded part of the task to Cursor when one or more of these are true:

- The task can be bounded to a path set or subsystem and checked through a diff, test, count, or documentation assertion.
- The work includes repeated lookup, mechanical edits, test or documentation completion, adapter wiring, configuration cleanup, or an independent second pass.
- The primary agent has higher-value design, cross-system judgment, or non-conflicting work to continue.
- Delegation value is uncertain, but a small `read_only=true` implementation-location probe or single-path task can measure it without transferring an unresolved product decision.

Keep the work in the primary agent when any of these are true:

- The user said not to use Cursor, or the current mode is `manual` and the user has not asked for it.
- It is a tiny direct edit whose dispatch and review would cost more than doing it locally.
- Cursor would have to decide product direction, architecture, creative intent, or governance state.
- The task requires exclusive GUI state or shared mutable runtime state.
- A safe scope, path boundary, checkable result, or way to preserve existing user changes cannot be established.

Before dispatch, make sure the purpose, invariants, allowed scope, and checkable outcome are reasonably clear. Cursor may resolve local implementation details inside that envelope; the primary agent does not need to prescribe every step.

In `active` or `eager`, do not keep suitable work local merely because dispatch has some overhead. Still keep it local whenever one of the exclusions above applies.

For project understanding, establish the cheapest deterministic local baseline first. Use Cursor for semantic candidates, a bounded second evidence surface, or the subsequent implementation. Do not submit the same exact lookup through multiple systems.

## Choose the execution mode

- Use `execution=fifo` for one ordinary task, dependent tasks, overlapping write scopes, shared mutable state, or any case where independence is uncertain. Submit the next dependent task only after accepting the previous result.
- Use `execution=parallel_agent` only for at least two independent, separately verifiable tasks whose write paths do not overlap.
- Set `read_only=true` for analysis-only work. Do not run read-only tasks in parallel against the same mutable external state.
- Set `read_only=false` only with a non-empty set of workspace-relative `allowed_paths` that contains no globs and cannot escape the workspace. Keep the set as small as practical. It is a scheduling declaration and prompt constraint, not a filesystem sandbox.

Do not choose parallel execution merely because there are many tasks. When dependency or path relationships are unclear, use `fifo`.

## Dispatch a task

1. Record the relevant pre-dispatch workspace state so later review can distinguish existing user changes.
2. Form one independent task envelope per task using [delegation-contract.md](references/delegation-contract.md).
3. Call `cursor_do` with `background=true` and `new_chat=true` by default.
4. Save each returned `task_id`; also save `agent_id` for `parallel_agent`.
5. If a parallel submission does not return a usable `agent_id`, stop expanding the parallel batch and use `fifo` or report the ambiguous state.

The envelope may contain a small number of local implementation `open_questions`, but it must also provide `fixed_decisions`, `allowed_paths`, prohibitions, and acceptance checks. Cursor may solve local questions; it must stop and report any branch that would change product direction, architecture, or scope.

## Collect and verify

1. Always query `cursor_status(task_id)` for the exact task. Do not treat the currently visible Cursor chat as task identity.
2. Treat `submitting`, `running`, and `collecting` as normal in-progress states. More than two minutes is not itself a failure; wait for an explicit terminal state.
3. Compare Cursor's claimed work with the real diff, `allowed_paths`, and acceptance contract.
4. Run risk-proportionate verification in the primary agent. Cursor's response alone cannot support a formal pass, verified state, or governance transition.
5. Record each task as complete, partial, failed, timed out, or ambiguous before summarizing the batch.

Read [delegation-contract.md](references/delegation-contract.md) for state interpretation and recovery details.

## Handle abnormal states

- For `needs_attention`, `orphaned`, ambiguous state, or an unbound session, assume the real Cursor Agent may still be running. Preserve path ownership and never resubmit automatically.
- For a parallel orphan with a bound `agent_id`, first call `cursor_task_control(action=reap)`. This explicitly rechecks and, when possible, resumes monitoring or collects that exact Agent. `cursor_status` is read-only and does not reap automatically.
- For a FIFO or unbound orphan, do not call `reap` as if an identity existed. It globally blocks delegation; manually verify Cursor has stopped, then use the explicitly acknowledged `abandon` path.
- To stop a bound task, use `cursor_task_control(action=cancel, confirm=true, expected_agent_id=<exact id>)`. If Stop cannot be confirmed, the reservation remains held.
- Use `action=abandon` only after manual verification and an explicit user decision to accept the risk. It requires `confirm=true`, a non-empty reason, `acknowledge_may_still_write=true`, and the exact `expected_agent_id` when one is already bound; report that the underlying Agent may still run or write.
- If Cursor shows a final UI response but Bridge has not collected it, use explicit `reap` against the original bound task. A `terminal_uncollected` result keeps the reservation for retry. Do not add a completion marker, increase a response-length requirement, or submit the same task again.
- Task identity and reservations are process-local. After an MCP/Codex restart, do not claim the old `task_id` is recoverable; inspect Cursor Agent History and workspace changes manually before overlapping work.
- If a timed-out task changed files, inspect the changes before deciding whether to continue, retry, or revert.
- If changes exceed `allowed_paths`, stop accepting the result and report the scope violation.
- If parallel tasks conflict, stop further integration and return to primary-agent review or serial execution.
