---
name: grok-executor-off
description: Explicitly disable Grok executor mode for this task without cancelling work or closing its terminal. Select this skill directly; no argument is required.
---

# Disable Grok Executor

An explicit user selection of this skill is the complete `off` instruction. Do not ask the user to type `off` or another command. Quoted examples and implicit selection do not deactivate it.

Apply the deactivation contract in [Grok Executor Policy](../grok-build-supervisor/references/executor-policy.md): clear this task's executor mode and workspace binding, returning subsequent tasks to normal host execution. Do not cancel work, disconnect ACP, close the terminal, or stop the Leader. Continue already-required monitoring under [Grok Build Supervisor](../grok-build-supervisor/SKILL.md). Repeated selection is idempotent. Confirm deactivation briefly in the user's language.
