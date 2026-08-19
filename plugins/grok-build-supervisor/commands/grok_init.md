---
description: Discover, verify, and persist the local HTTP proxy used by Grok Build Supervisor.
---

# Grok Build Supervisor Initialization

This command initializes only the persistent local proxy configuration. It must not create or resume a Grok session, open a TUI, send a prompt, or change Grok Executor Mode.

Interpret the entire trimmed value of `"$ARGUMENTS"` as follows:

- Empty: call `grok_init` without `proxyUrl` so the Supervisor checks configured local candidates and then performs bounded loopback discovery.
- One absolute `http://` localhost or loopback URL: call `grok_init` with that exact `proxyUrl` to verify and persist the user's selection.
- Anything else: do not call a tool or change state. Reply only with `/grok_init` or `/grok_init http://127.0.0.1:<port>`.

If initialization returns `ready`, report the verified host and port briefly. If it returns `needs_selection`, present only the returned candidates and ask the user to rerun `/grok_init` with one exact URL. If it fails, report the actionable error and next step. Never claim success from an open TCP port alone: the Supervisor must have completed its HTTP CONNECT verification and persisted the setting.
