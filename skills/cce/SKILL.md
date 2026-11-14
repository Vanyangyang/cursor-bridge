---
name: cce
description: Show, diagnose, or persistently switch Cursor Context Engine between local Cursor CLI and IDE/Agents sources. Use for /cce cli, /cce ide, /cce doctor, /cce, or an explicit CCE source-switch or diagnostic request; ordinary retrieval uses cce-routing.
---

# CCE source

Fresh installations default to local Cursor CLI (`cli`); IDE/Agents (`ide`) remains supported as a persistent fallback. Preserve an explicitly saved `cce-source.json` choice across upgrades without silently rewriting it. Never require an IDE window when using CLI, and never require a CLI binary when explicitly configured for IDE.

Use `cursor_cce` to manage or diagnose the local CCE source preference:

- `/cce cli`: call `cursor_cce(action="set", source="cli")`.
- `/cce ide`: call `cursor_cce(action="set", source="ide")`.
- `/cce doctor`: call `cursor_cce(action="doctor")`.
- `/cce` without a source: call `cursor_cce(action="show")`.

A natural-language request explicitly choosing CLI, IDE, or CCE diagnostics has the same meaning. For another argument, show these choices without changing the saved value.

Report the returned `cceSource`, `cceSourceFile`, and diagnostic fields in the user's language. The saved source survives host restarts and plugin updates. Each admitted CCE query freezes its source, workspace, and model preference; switching sources affects later queries.

Both sources share CCE's query, evidence/result contract, provenance, workspace assertion, and model preferences. Account CLI uses Read-Only Ask mode (over persistent isolated ACP by default, with `print` fallback) and verifies the configured `cursor_model` model/effort before submitting a prompt. An explicitly configured `cli_provider` uses the official `agent-local` harness with an OpenAI-compatible Responses endpoint, a local credential file, and enforced model/effort verified in provider responses. Preserve `cli_provider` when switching sources: omit `cli_provider`; never clear it or switch to account billing implicitly. An unavailable source reports its cause without silently switching sources or models.

To configure an own-key CLI route when the user requests it, call `cursor_cce(action="set", source="cli", cli_provider={kind:"openai-responses", node_path:"<absolute bundled Node>", entrypoint:"<absolute agent-local index.js>", base_url:"<provider base URL>", api_key_file:"<absolute local credential file>"})`. Keep key contents out of tool arguments and prompts. Use `cursor_model` for the independent model/effort preference. Setting `cli_provider=null` explicitly removes the route; ordinary `/cce cli` and `/cce ide` do not remove it.

If `cursor_cce` is unavailable or `action="doctor"` is unsupported, report that the installed Bridge needs an update/reload. Do not emulate persistence with a conversational promise or edit native Cursor settings.
