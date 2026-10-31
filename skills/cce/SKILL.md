---
name: cce
description: Show or persistently switch Cursor Context Engine between local Cursor CLI and IDE/Agents sources. Use for /cce cli, /cce ide, /cce, or an explicit CCE source-switch request; ordinary retrieval uses cce-routing.
---

# CCE source

Fresh installations default to IDE/Agents; CLI is optional. Do not require a CLI installation or CLI credential file for the IDE source, or select CLI merely because its provider feature is available. Preserve an explicitly saved choice across upgrades.

Use `cursor_cce` to manage the local CCE source preference:

- `/cce cli`: call `cursor_cce(action="set", source="cli")`.
- `/cce ide`: call `cursor_cce(action="set", source="ide")`.
- `/cce` without a source: call `cursor_cce(action="show")`.

A natural-language request explicitly choosing CLI or IDE has the same meaning. For another argument, show these choices without changing the saved value.

Report the returned `cceSource` and `cceSourceFile` in the user's language. The choice survives host restarts and plugin updates. Each admitted CCE query freezes its source, workspace, and model preference; changing the preference affects later queries. This command only selects the source, so it does not need a query or start a model request.

Both sources share CCE's query, evidence/result contract, provenance, workspace assertion and model preferences. CLI uses a fresh local Cursor Agent Ask-mode process; IDE uses Cursor IDE/Agents through CDP. Account CLI verifies an advertised model/effort. An explicitly configured `cli_provider` uses the official `agent-local` harness with an OpenAI-compatible Responses endpoint, a local credential file and enforced model/effort verified in provider responses. Preserve this configuration when switching sources: omit `cli_provider`; never clear it or switch to account billing implicitly. An unavailable source reports its cause without silently switching sources or models. Keep the user's existing model and effort choices.

To configure an own-key CLI route when the user requests it, call `cursor_cce(action="set", source="cli", cli_provider={kind:"openai-responses", node_path:"<absolute bundled Node>", entrypoint:"<absolute agent-local index.js>", base_url:"<provider base URL>", api_key_file:"<absolute local credential file>"})`. Keep key contents out of tool arguments and prompts. Use `cursor_model` for the independent model/effort preference. Setting `cli_provider=null` explicitly removes the route; ordinary `/cce cli` and `/cce ide` do not remove it. The selected Cursor surface supplies its native retrieval capabilities; authless agent-local does not imply access to Cursor account services or a server-side semantic index.

If `cursor_cce` is unavailable, report that the installed Bridge needs an update/reload. Do not emulate persistence with a conversational promise or edit native Cursor settings.
