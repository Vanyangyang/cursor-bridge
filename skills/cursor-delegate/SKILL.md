---
name: cursor-delegate
description: "Delegate bounded light-to-medium implementation, limited investigation, documentation, configuration, testing, and tooling work to Cursor Bridge after the primary agent owns the direction and risk boundaries. Use proactively when a bounded Cursor pass can save primary-agent time, reduce omissions, or run alongside non-conflicting work; the task needs a clear purpose, allowed scope, invariants, and checkable outcome, but not a fully pre-solved implementation. Supports execution=fifo and execution=parallel_agent for independent tasks with non-overlapping write paths, followed by collection through task_id/agent_id and primary-agent verification. Do not use when the user opts out, cursor_do is unavailable, CURSOR_BRIDGE_DELEGATION=off, or for product direction, architecture decisions, exclusive GUI operations, formal verification verdicts, governance state decisions, or unbounded investigation."
---

# Cursor Delegate

Use Cursor as an execution partner. Keep direction, scope decisions, risk ownership, result review, and final verification with the primary agent.

## Respect delegation controls

- Do not call `cursor_do` when the user explicitly says not to use Cursor or not to delegate. A direct user opt-out overrides every policy mode.
- If `cursor_do` is unavailable, or `cursor_status` reports delegation as disabled, do not bypass the setting, repeatedly retry, or ask Cursor to re-enable itself. Complete the work in the primary agent.
- Treat `CURSOR_BRIDGE_DELEGATION=off` as an execution kill switch. It does not by itself disable `cursor_search`, `cursor_status`, `cursor_policy`, or `cursor_launch`.

## Apply the session policy

Use `cursor_policy` to inspect or set the session-scoped scheduling policy when the user requests a change. Confirm the returned effective policy, and use the value echoed by `cursor_status` for later decisions.

Policy controls delegation **aggressiveness**, not a fixed frequency such as “call Cursor every N tool invocations.” It never relaxes user intent, task boundaries, path isolation, or primary-agent verification.

- `off`: do not delegate execution to `cursor_do`.
- `manual`: delegate only after an explicit user request or direct invocation of this workflow.
- `auto`: use a cautious heuristic; delegate when the scope and payoff are clear and collection overhead is likely worthwhile.
- `active`: recommended default; proactively delegate bounded light-to-medium work, limited implementation discovery, tests, documentation, configuration, and independent second passes when doing so saves time or reduces omissions.
- `eager`: maximize safe bounded delegation and non-overlapping parallel work, including small read-only probes and independent mechanical tasks; keep every normal safety boundary.

Do not assume that the host provides a `/cursor` slash command. Use the MCP policy tool or ordinary user instructions unless the current host exposes a verified wrapper.

## Follow the default workflow

Use this responsibility chain:

`primary agent defines purpose, invariants, and risk boundaries -> form a bounded task envelope -> Cursor investigates locally and executes within the envelope -> collect by task_id -> primary agent inspects the real changes and verifies them`

- Decide what should be achieved, why it matters, what must not change, where Cursor may work, and what evidence makes the result acceptable. Do not delegate product direction, architecture boundaries, or state verdicts.
- Allow Cursor to locate relevant implementation, compare local approaches, and complete code, documentation, configuration, scripts, tests, and tooling inside those boundaries. Do not require the primary agent to pre-solve the task line by line.
- When delegation is enabled, normally call `cursor_do` once per independent task with `background=true` and `new_chat=true`, then continue non-conflicting primary-agent work.
- Prefer `execution=fifo` unless the parallel contract is clearly satisfied.
- Do not inject a unique completion marker or impose a minimum response length. Rely on task state, stable `task_id` or `agent_id`, and the actual result.

## Evaluate delegation proactively

Consider delegation as soon as any of the following applies; do not wait until the primary agent has already completed most of the implementation investigation:

- The task can be bounded to a path set or subsystem and checked through a diff, test, count, or documentation assertion.
- The work includes repeated lookup, mechanical edits, test or documentation completion, adapter wiring, configuration cleanup, or an independent second pass.
- The primary agent has higher-value design, cross-system judgment, or non-conflicting work to continue.
- Delegation value is uncertain, but a small `read_only=true` implementation-location probe or single-path task can measure it without transferring an unresolved product decision.

Delegate only when all safety conditions still hold:

- Purpose, invariants, allowed scope, and a checkable outcome are reasonably clear. Cursor may resolve local implementation details inside the envelope.
- Each task can be collected independently. The acceptance contract may describe behavior, tests, and prohibitions rather than implementation steps.
- Cursor does not need to decide product direction, architecture, worldbuilding, or governance state.
- The task does not require exclusive GUI state or other operations the primary agent must own.
- Existing user changes can be identified and preserved.

Do not reject delegation merely because dispatch has some overhead. Work directly only when the edit is truly immediate, tightly coupled to the primary agent's current writes, or more expensive to collect and verify than to complete locally.

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

- For `needs_attention`, `orphaned`, ambiguous state, or an unbound session, assume the real Cursor Agent may still be running. Preserve path ownership and inspect history by `task_id` and `agent_id` before resubmitting.
- If Cursor shows a final UI response but Bridge has not collected it, continue querying the original `task_id`. Do not add a completion marker, increase a response-length requirement, or submit the same task again. Let Bridge retry against the same `agent_id`; escalate only after a persistent `needs_attention` state.
- If a timed-out task changed files, inspect the changes before deciding whether to continue, retry, or revert.
- If changes exceed `allowed_paths`, stop accepting the result and report the scope violation.
- If parallel tasks conflict, stop further integration and return to primary-agent review or serial execution.
