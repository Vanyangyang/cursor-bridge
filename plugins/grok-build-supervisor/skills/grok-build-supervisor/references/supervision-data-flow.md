# Supervision data flow

## Authority layers

- ACP status, permission requests, errors, and terminal results are the live control plane.
- The Supervisor appends bounded events to a segmented JSONL journal under its local state root. This journal is the restart and evidence source, not a model prompt.
- `SUPERVISOR_DERIVED` summaries are deterministic reductions of a bounded event window.
- `AGENT_SUMMARY_CLAIM` comes from Grok's saved `summary.json`. It is useful semantic compression, but it does not prove files, Git state, tests, or Unity behavior.

## Persistent control plane

```text
Host MCP client(s) -> authenticated user-local Named Pipe -> Supervisor daemon -> Leader / ACP -> Grok session + TUI
```

- `server.mjs` is a thin per-host-task frontend. It does not own Leader, ACP, TUI, pending permission promises, or prompt state.
- The detached Supervisor daemon owns those resources and survives MCP frontend exit and plugin reinstall.
- The daemon capability token is generated once in the user-local state root, is never returned by status or tool results, and is checked with constant-time comparison on every pipe request.
- Many clients may inspect. One writer lease and fencing token authorizes `open`, `prompt`, `respond`, and `control`; stale writers cannot resume writes after a newer client takes the lease.
- A clean MCP disconnect releases its lease. An abrupt frontend loss leaves a bounded lease so another client can safely take over after expiry.
- Runtime upgrades are idle-only. A newer frontend continues using a busy older daemon, then rolls it forward after ACP, verified TUI, prompts, permissions, and elicitations are all inactive. A numeric PID alone is never live-TUI evidence because Windows can reuse it; busy state requires the recorded process fingerprint, Grok executable, active-session registry entry, and Leader ownership token to agree.
- At daemon construction, the PowerShell launcher, TUI host, and its local Node dependencies are copied into a content-addressed directory under the persistent state root. Windows Terminal receives only those durable paths, so removing an old plugin cache during reinstall cannot invalidate a later TUI launch by the still-running daemon.

## Leader-scoped agent configuration

- Agent-runtime settings such as subagent availability are resolved when the Leader starts. TUI and ACP clients must not pass `--subagents` or `--no-subagents` to try to change an already-running Leader.
- Some Grok builds represent the default-enabled subagent state as if the client explicitly supplied `--subagents`, then print `--subagents has no effect in leader mode` even when the plugin passed neither flag. This is a known upstream compatibility notice, not evidence that the plugin passed an override.
- Keep the native TUI's stdin, stdout, and stderr attached to the terminal. Do not pipe or filter the notice: the fullscreen renderer depends on native terminal handles and can stall when stderr is intercepted.
- Never add `--no-subagents` merely to hide the notice. In plan mode it can select a no-subagents agent profile and change real session behavior. The Leader's inherited environment and Grok config remain the source of truth; removing the notice itself requires an upstream Grok fix that distinguishes defaults from explicit flags.

## Inspect views

- `interaction` is the default operational view. While work is active it returns only user-relevant state, compact liveness metadata, an exact workspace-trust, permission, or form-elicitation request, and a high-water cursor. It suppresses cumulative message bodies and coalesces routine events through `latestSequence`. With `waitMs` it waits up to 25 seconds for an attention or terminal state.
- `summary` is an explicit derived diagnostic view. Pass the previous `nextAfterSequence` and advance the cursor.
- `status` checks processes, attachment, recovery state, and pending permissions without returning event payloads.
- `delta` returns a bounded page of recent compact events for debugging.
- `evidence` returns at most 20 exact durable events selected by sequence ID.

If `cursorGap` is true, do not silently claim continuity. Use the journal metadata or exact evidence requests and state that older events were outside the recent in-memory window.

## Structured progress and liveness

- `progress.phase` is one of `starting`, `planning`, `locating`, `modifying`, `verifying`, `executing`, `working`, `completed`, or `failed`. It is inferred from bounded ACP plan and tool-call metadata, so it is useful routing state rather than proof that the named work succeeded.
- `responseChars` counts agent-message characters observed so far while the bodies remain suppressed. `messageCount` counts distinct ACP message IDs captured for the run.
- `lastChunkAt` changes only when agent text arrives. `heartbeatAt` is the last liveness evaluation, including a quiet evaluation that does not create a journal event.
- `newActivity` is relative to the caller's supplied `afterSequence`. `false` means no newer durable event was available for that cursor; one quiet wait is normal. Three consecutive full waits with both `newActivity: false` and an unchanged `lastChunkAt` are a suspected stall, not proof of failure and not authority to cancel automatically.
- Terminal progress adds bounded `changedFiles` and `commandsRun` lists with matching truncation flags. They are Grok-derived targeting hints. `needsHostVerification` remains true until the host checks the files, Git state, commands, and tests itself.
- `run_progress` journal events contain throttled progress snapshots. `available_commands_changed` records only bounded capability names, counts, and hashes. `inactive_run_activity` records throttled metadata for tool or plan updates received after cancellation, completion, or without a matching active run; raw payloads remain suppressed.

## Prompt continuity and reverse questions

- `grok_session_prompt` starts one turn and returns its exact `runId` and event cursor. The supervising host turn must repeatedly call the bounded `interaction` wait while state remains `working` or `cancelling`, replacing `afterSequence` with every returned high-water cursor.
- ACP `agent_message_chunk` updates are accumulated inside the daemon but are not returned during working polls. Chunks sharing a `messageId` form one message; multiple message IDs are retained in order and separated before terminal delivery, so a split report is not silently reduced to only its final message. Raw message and thought chunks are not appended one-by-one to the durable journal; it stores throttled activity metadata and the terminal event instead. On completion, the bounded final response is included only when the terminal event sequence is newer than the caller cursor; advancing the returned cursor suppresses later redelivery. Tool calls, thoughts, process records, and raw journal data are not mixed into the normal user-facing result.
- A new MCP frontend also applies this coalescing policy to responses from an older busy daemon, so plugin updates do not reintroduce cumulative text while waiting for an idle daemon rollover.

## Result artifact handoff

- A completed response at or below 4000 UTF-8 bytes remains inline and is cursor-delivered once.
- A longer response is atomically persisted under the user-level Supervisor state root. `interaction` returns `resultArtifact.path`, `bytes`, `sha256`, `mediaType`, `capturedChars`, `sourceChars`, `truncated`, and an at-most-800-character summary instead of the body.
- The path metadata is cursor-delivered once, while `delivery.resultArtifactAvailable` remains true on later inspections. Explicit recovery can inspect the run again from an earlier cursor without loading raw journal segments.
- The new MCP frontend performs the same artifact conversion for a long terminal response from an older busy daemon. This compatibility layer is still Supervisor-native protection; it is not context-mode interception.
- Artifact persistence is independent of context-mode. If context-mode is already available in the host, use `ctx_execute_file` to derive only the needed conclusions, errors, changed files, commands, and test results. Otherwise use a bounded local file reader or let the user open the file. Do not bundle, install, or require context-mode.
- Context-mode is appropriate for long result artifacts, large test/build logs, event logs, and large JSON. Ordinary short coding results stay on the direct path.
- ACP form elicitation is advertised as an experimental client capability. It is a semantic input request, distinct from tool permission. The Supervisor keeps the Grok turn pending until the user accepts, declines, or cancels the exact elicitation.
- For visible sessions the Supervisor also advertises Grok's `x.ai/folderTrust.interactive` client capability. An untrusted workspace with local automation produces logical method `x.ai/folder_trust/request` containing `sessionId`, `cwd`, canonical `workspace`, and `configKinds`. Grok Leader transports extension requests as `_x.ai/folder_trust/request` with the logical method and payload nested under `{ method, params }`; the Supervisor unwraps both forms before validation. This becomes `needs_workspace_trust`, never `needs_permission`. The same verified TUI is persisted as `awaiting_workspace_trust`; repeated open reuses it, including after a daemon/frontend restart. The user decides on Grok's native screen. When that exact TUI PID appears in the active-session registry under the same session and Leader ownership, the Supervisor replies `trust`; exit or lost ownership replies `reject`. Older Grok builds fall back to `awaiting_session_registration` without claiming which screen is open.
- The MCP frontend carries a bounded host identity in the authenticated daemon request. Grok is told whether the task came from Codex, Claude Code, or an unknown host agent, and that same host remains attached as its ACP supervisor. It should work independently when its tools suffice, communicate normal progress through session updates, and use elicitation only for a specific fact or coordination decision it cannot obtain itself. The host agent may answer from verified context or route the question to the user. If native elicitation is unavailable, a strict terminal `supervisor_question` envelope provides a bounded fallback for the next prompt turn.
- ACP can wake an in-flight MCP wait. It cannot wake a host task that has already ended; host task or heartbeat facilities remain a separate application layer.

## Long histories and context-mode

Do not make context-mode part of permission handling, ordered live supervision, or Supervisor response-size enforcement. Use it only as an optional processing layer for result artifacts, immutable journal segments, or Grok session files that are already inside its permitted filesystem scope:

1. Use `ctx_execute_file` for one-shot deterministic extraction such as errors, changed files, commands, and tests.
2. Use `ctx_index(path, extensions=[".jsonl"], include=["events-*.jsonl"])` plus a session-scoped `ctx_search` source when closed segments will be queried repeatedly; `.jsonl` is not a default indexed extension.
3. Print only the derived answer or matching snippets; never pass the full transcript through tool output or `ctx_index(content=...)`.
4. Do not bypass context-mode filesystem boundaries. If the journal is outside its allowed roots, use bounded Supervisor views or obtain an explicit host allow rule.

## Restart recovery

An MCP frontend restart is not a Supervisor restart and does not disturb the live ACP connection. If the daemon itself crashes, the durable journal restores sequence continuity and records interrupted runs, orphaned permissions, orphaned elicitations, or orphaned workspace-trust round-trips as unknown after restart. Pending promises are never reconstructed. A trust-pending TUI is nevertheless preserved as a verified live activation record, so a new daemon reattaches the exact session and waits for Grok to issue a fresh structured request instead of launching another window. A new prompt is refused until workspace trust is resolved or an unknown run is explicitly cancelled through the recovered ACP session. Reattachment is allowed only for an exact session backed by a live dedicated Leader, a verified durable Leader ownership token, a matching Supervisor-created TUI state record, and the same Grok process identity. A recovered TUI is never reclassified as newly owned by another process. If a PID is reused or its fingerprint changes, the record remains audit evidence but is treated as stale and rollback refuses to terminate that process. A recovered Leader may be stopped only through its exact dedicated socket and durable ownership record, and only after every matching visible TUI has exited normally.
