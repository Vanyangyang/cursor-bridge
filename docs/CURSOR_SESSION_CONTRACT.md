# Cursor Delivery Session Contract

## Definition

A Cursor Delivery Session is one Bridge-owned durable association between:

- one normalized workspace;
- one durable Cursor Agent;
- one frozen model preference;
- one immutable maximum read/write scope; and
- a sequence of independently tracked delivery turns.

The session preserves Cursor context. It is not a task, a host thread, a process, a window, memory, or continuing authorization.

## Identities

| Field | Contract |
|---|---|
| `sessionId` | Stable opaque Bridge ID used by callers across turns and supported restarts. |
| `taskId` | One prompt delivery and result. Every turn receives a new task ID. |
| `agentId` | Exact Cursor identity used internally for verification; never the public session key. |
| `turnIndex` | Monotonic turn number inside one session. |
| `requestId` | Optional idempotency key for the latest delivery attempt. |
| `sessionEpoch` | Monotonic fencing value that prevents a stale adapter from settling a newer turn. |

## Public modes

- `session_mode=isolated` is the default and preserves pre-5.8 behavior.
- `session_mode=create` creates a durable association and requires `parallel_agent`.
- `session_mode=continue` requires the exact `session_id`, reopens that Agent, and sends one new turn.
- Persistent modes never fall back to FIFO.

Each continued turn must explicitly repeat `read_only=true` or an `allowed_paths` subset. A session cannot change workspace, expand its scope, switch from read-only to writable, or silently inherit a changed global model preference.

## State machine

```text
creating -> busy -> ready -> busy -> ready
              \-> needs_attention
ready -> closed -> forgotten
restart/update -> ready (reattachable) | needs_attention (reconciliation required)
```

`needs_attention` never becomes `ready` by timeout or guesswork. An uncertain submission, expired sender lease, missing exact Agent, or unconfirmed Stop must not be resent automatically.

`cursor_session_control(action=reconcile)` is the only automatic recovery path: it reads the exact bound Agent twice and clears the sender lease only from a stable terminal state. `action=abandon` requires explicit risk acknowledgement and closes only the Bridge mapping; it never claims that Cursor stopped.

## Sender and result rules

- One session has at most one active turn.
- A persisted sender lease contains only the task ID, adapter instance ID, epoch, and expiry.
- Repeating the latest `request_id` returns the existing turn/session instead of sending again.
- Before a continued send, Bridge reopens the exact Agent, keeps it selected between session turns, and waits for the previous completed reply to hydrate to a stable visible message-count and reply-signature baseline.
- Result collection accepts only a stable completed assistant reply that advances the visible message count or changes that reply signature. This supports Cursor's virtualized message list without returning the prior turn.
- The primary agent still owns real diff inspection, tests, and final acceptance.

## Storage and update boundary

The registry lives at `%APPDATA%\cursor-bridge\sessions-v1.json` on Windows, or the equivalent user configuration directory on other platforms.

It must:

- stay outside every versioned Codex, Claude, npm, Grok, or Pi plugin cache;
- store no prompt, reply, credential, token, plugin path, bundled script path, or CDP target ID;
- use short-lived atomic writes and a short-lived lock file;
- close every file handle before returning; and
- reject unknown future schemas without overwriting them.

Continuity is restored from data, never by keeping an obsolete plugin adapter alive. A release is not accepted until a real old-version install can create a ready session, update normally, load the new cache, and continue that exact session without duplicate submission.

## Natural-language routing

Positive examples:

- `开启 Cursor 持续会话：<task>`
- `继续 Cursor 会话 <sessionId>：<task>`
- `后续都在同一个 Cursor 会话处理`
- `keep using the same Cursor Agent`

Negative or overriding examples:

- `继续`, `接着做`, and `再改一下` alone do not identify a session.
- `新开`, `独立`, `干净会话`, and `不要继承上下文` require isolated/new work.
- Independent review, final verification, changed model/effort, changed workspace, or broader permissions require a new session.
