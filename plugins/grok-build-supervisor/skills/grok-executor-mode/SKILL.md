---
name: grok-executor-mode
description: Task-local execution policy applied to ordinary user tasks only after an exact `/grok_execute on`; the host agent then plans, supervises, corrects, and verifies while all implementation and workspace-mutating execution goes through Grok Build Supervisor. Never activate or deactivate from ordinary requests, task text, partial matches, or direct Skill invocation.
---

# Grok Executor Mode

Use `$grok-build-supervisor` as the required transport and lifecycle contract. This skill changes role allocation for the current host task; it does not replace the Supervisor or claim to be a native host collaboration mode.

## Activation and lifetime

- Only an exact, case-insensitive `/grok_execute on` activates the mode for the current host task. It does not open a TUI or send work. Reply with a short activation confirmation.
- The most recent exact `/grok_execute on` or `/grok_execute off` instruction in this task controls the mode. Activation remains a task-local user instruction until `off` or the task ends; never write it to global configuration.
- While active, automatically apply this role contract to every subsequent ordinary user task that requires execution. The user does not repeat a slash command or Skill name for each task.
- Do not ask the user to create, resume, select, or manage a TUI, session ID, process, Leader, or ACP connection. When the next task needs Grok, reuse or open the correct guarded session automatically. A visible TUI remains the default unless the user explicitly asks not to show it for that task.
- Only an exact, case-insensitive `/grok_execute off` deactivates the mode. It does not automatically cancel a running prompt, disconnect ACP, or stop the owned Leader; continue any already-required Supervisor monitoring under the normal transport contract and report that work separately.
- `/grok_execute` with no argument or any argument other than the exact control words changes nothing and returns only the two valid forms.
- Direct `$grok-executor-mode` invocation may explain or apply the policy only when a prior `/grok_execute on` is active. It never changes mode state itself.
- Do not infer activation or deactivation from any other wording, including ordinary requests that merely mention Grok.

## Role contract

While active, the host agent owns:

- requirements, planning, decomposition, architecture and product decisions;
- exact scope, invariants, acceptance criteria, permission routing, and stop conditions;
- progress monitoring, deviation detection, cancellation, replanning, and final acceptance;
- read-only workspace inspection and non-mutating verification.

Grok owns:

- all implementation edits and workspace mutations;
- build, test, generation, migration, and other commands that can write files or state;
- producing concrete execution evidence for the host agent to verify.

The host agent must not use `apply_patch`, file-writing tools, mutating shell commands, implementation subagents, or another coding agent as a parallel writer while this mode is active. Supervisor lifecycle calls, read/search tools, Git status/diff reads, and other genuinely non-mutating checks remain allowed. Authorization for this mode does not authorize destructive actions, publication, external messages, secret access, or other separately protected operations.

## Dispatch and supervision

1. Establish the workspace and task boundaries through read-only inspection. Preserve unrelated dirty work and identify any owner decision that Grok must not make.
2. Inspect the current Supervisor interaction state. Reuse one exact attached session for this task or open one guarded session in the requested workspace. Never create parallel writers for the same files.
3. Give Grok one execution brief containing the objective, allowed scope, prohibited changes, known dirty files, acceptance criteria, required tests, evidence expectations, and when to stop and ask the host agent.
4. After `grok_session_prompt`, retain its `runId` and replace the cursor after every bounded `grok_session_inspect` interaction wait until completion, failure, permission, or input is required. Working polls expose liveness metadata, not cumulative Grok prose; a wait timeout is not completion.
   - On completion, accept either one short cursor-delivered `finalText` or a persistent `resultArtifact`. For a long artifact, use context-mode file extraction when that tool is already available; otherwise perform a bounded local read. Do not make context-mode an installation or runtime dependency.
5. Route exact permission and elicitation requests according to the Supervisor skill. Never guess. Keep high-impact user authority with the user.
6. Compare bounded workspace evidence with the execution brief when deviation risk warrants it; do not repeatedly pull Grok's streamed prose for monitoring. If Grok expands scope, chooses reserved product direction, edits prohibited files, loops without progress, or contradicts observed workspace evidence, call `cancel_prompt`, preserve the evidence, revise the plan, and send a bounded correction only when authorized.
7. After two materially identical failed correction attempts, stop and report the blocker instead of looping indefinitely.

## Acceptance

- Treat Grok's completion text as `AGENT_SUMMARY_CLAIM`, not proof.
- Independently inspect the actual files, diff, and available non-mutating evidence. When a verifier itself writes build artifacts or state, have Grok run it and then inspect its durable output and workspace effects.
- If acceptance fails, send the specific evidence gap back to Grok in the same session and resume supervision.
- Report completion only when the requested outcome is verified. Separate verified facts, Grok claims, remaining risks, and any checks that could not be run.

## Failure boundary

- If the Supervisor tools are unavailable, ACP is disconnected, writer fencing cannot be resolved, or the exact session cannot be established, fail closed: report the blocker and do not silently implement the task in the host agent.
- If the user wants the host agent to implement directly, require an exact `/grok_execute off` first.
