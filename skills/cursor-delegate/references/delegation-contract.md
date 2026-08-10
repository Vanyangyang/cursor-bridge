# Cursor Delegation Contract

Read this file only when constructing a task envelope, choosing an `execution` mode, or recovering from an abnormal state.

## Delegation controls

- When `CURSOR_BRIDGE_DELEGATION=off`, Bridge does not expose `cursor_do`, and direct invocation must fail. Initialization, search, and status tools remain available.
- When the user opts out, `cursor_do` is unavailable, or `cursor_status.delegationMode=off`, complete the task in the primary agent. Do not ask the user to re-enable delegation or bypass the setting through another call.
- Re-enable the environment-level kill switch by starting a new MCP server process with `CURSOR_BRIDGE_DELEGATION=on` or with the variable unset. A running process does not dynamically change this environment setting.
- There is one fixed public delegation contract. No participation levels or call-frequency settings exist. `CURSOR_BRIDGE_DELEGATION=off` is an administrator-level compatibility switch and never relaxes the task-envelope, path, independence, or verification contracts below.

## Task envelope

Provide every task independently:

| Field | Requirement |
|---|---|
| `prompt` | State one objective, the necessary context, prohibited actions, and the expected report. Do not ask Cursor to repeat the primary agent's scope decision. |
| `execution` | Use only `fifo` or `parallel_agent`. Use `fifo` when safe parallelism cannot be demonstrated. |
| `read_only` | Use `true` for lookup and analysis; use `false` for any file modification. |
| `allowed_paths` | Required when `read_only=false`. Provide the smallest workspace-relative path set, with no glob, absolute path, or workspace-escaping `..`. Omit it when `read_only=true`. This is not a filesystem sandbox. |
| `completion_contract` | State the deliverables, validation commands, permitted incomplete items, and final report format. |
| `background` | Default to `true` so the primary agent may continue independent work. |

## Routing contract

Choose `parallel_agent` only when all conditions hold:

1. Tasks have no data, ordering, or decision dependency.
2. Normalized `allowed_paths` for write tasks are pairwise non-overlapping.
3. Tasks do not share Unity, browser, database, or other mutable runtime state.
4. Each result can be accepted independently; one failure does not invalidate the other results.

Use `fifo` when any condition fails. For ordered work, do not pre-submit the full queue. Collect and accept the predecessor before deciding whether to submit its dependent task.

## Call examples

Parallel read-only task:

```json
{
  "prompt": "Read the specified files and return conclusions without modifying any file.",
  "execution": "parallel_agent",
  "read_only": true,
  "background": true,
  "completion_contract": "Return conclusions, evidence files, and unresolved questions."
}
```

Bounded write task:

```json
{
  "prompt": "Implement the specified tool script under the fixed design without expanding scope.",
  "execution": "parallel_agent",
  "read_only": false,
  "background": true,
  "allowed_paths": ["Tools/Example/"],
  "completion_contract": "List changed files and run the specified static check; preserve the original error when validation fails."
}
```

For dependent or path-overlapping work, change `execution` to `fifo` and submit the next task only after accepting its predecessor.

## Identity and collection contract

- `task_id` is the stable identity used by the primary agent to query and summarize a task. Save it immediately after dispatch.
- `agent_id` binds a `parallel_agent` task to an independent top-level session in the Agents Window. Do not assume safe identity when a parallel task lacks it.
- Determine task state only through `cursor_status(task_id)`, not the currently selected chat or latest visible response.
- A collected result should include at least task state, summary, changed files, validation performed, failures or blockers, and the raw Cursor response.
- Do not require a unique completion marker or minimum response length. Bridge determines completion from Agent state, stopped generation, and response stability.

### State table

| State or phase | Primary-agent action |
|---|---|
| `queued/submitting/running/collecting` | Keep the original task and continue polling by `task_id`. More than two minutes is not a failure. |
| `completed` | Read the raw response, then inspect the real diff, allowed paths, and completion contract. |
| `failed` | Read the explicit error and determine whether the Cursor Agent actually failed before deciding to rework. |
| `needs_attention/orphaned` with bound `agent_id` | Preserve path ownership and explicitly call `cursor_task_control(action=reap)` for the same in-memory task. Do not resubmit automatically. |
| FIFO or unbound orphan | A global reservation blocks all new delegation. Manually verify Cursor has stopped, then use explicitly acknowledged `abandon`; there is no safe `reap` target. |
| `terminal_uncollected` | Agent History is stably terminal but the final response extraction failed. Keep the reservation and retry explicit `reap`; do not release on one DOM failure. |
| `cancelled` | The exact Agent Stop action or an unsent queued cancellation was confirmed; the reservation is released. |
| `abandoned` | The reservation was explicitly released without proof that the underlying Agent stopped. Treat the warning as live risk and inspect workspace changes before any overlapping write. |

For an R6-style false negative, continue querying the original `task_id` when Agent History already contains a complete final response but automatic collection has not finished. Bridge should retry extraction against the original `agent_id`. Do not work around collection by requiring a longer reply, injecting a completion marker, or submitting the same task again.

## Primary-agent acceptance contract

Cursor's completion statement means only that delegated execution ended; it is not project verification. The primary agent must:

1. Inspect the actual diff against `allowed_paths`.
2. Separate delegated changes from pre-existing workspace changes.
3. Independently run appropriate compile checks, static checks, tests, or journey validation.
4. Decide whether to accept, request rework, continue serially, or record a blocker.
5. Retain formal verification, governance state, and product decision authority.

## Failure and fallback

- If `agent_id` is missing and the task has not been sent, stop expanding the parallel batch and safely fall back to `fifo`. If it may have been sent or is `needs_attention/orphaned`, continue treating its paths as occupied and inspect the Agents Window instead of resubmitting.
- If a timed-out task changed the workspace, inspect the changes before submitting the same task again.
- Reject and report any result that modifies files outside `allowed_paths`.
- Stop automatic integration when parallel tasks conflict and return the batch to primary-agent review.
- If Agent History or the response DOM is temporarily unreadable, let Bridge wait and retry against the same `agent_id`. Enter `needs_attention` after persistent failure; do not incorrectly mark the task complete or create a duplicate Agent.
- For a bound orphan, use `reap` before `cancel`. `cancel` requires the exact `expected_agent_id` and only releases after stable Stop evidence. `abandon` requires explicit confirmation, a reason, acknowledgement that the Agent may still write, and the exact `expected_agent_id` when one is bound.
- `cursor_status` is a pure snapshot. Reconciliation happens only through explicit `cursor_task_control`.
- Task records and reservations live only for the current Bridge MCP process. After restart, inspect Cursor Agent History and the workspace manually; persistent cross-process task leases are outside the current contract.
