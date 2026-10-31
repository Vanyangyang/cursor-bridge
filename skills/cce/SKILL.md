---
name: cce
description: Show or persistently switch Cursor Context Engine between local Cursor CLI and IDE/Agents sources. Use for /cce cli, /cce ide, /cce, or an explicit CCE source-switch request; ordinary retrieval uses cce-routing.
---

# CCE source

Use `cursor_cce` to manage the local CCE source preference:

- `/cce cli`: call `cursor_cce(action="set", source="cli")`.
- `/cce ide`: call `cursor_cce(action="set", source="ide")`.
- `/cce` without a source: call `cursor_cce(action="show")`.

A natural-language request explicitly choosing CLI or IDE has the same meaning. For another argument, show these choices without changing the saved value.

Report the returned `cceSource` and `cceSourceFile` in the user's language. The choice survives host restarts and plugin updates. Each admitted CCE query freezes its source, workspace, and model preference; changing the preference affects later queries. This command only selects the source, so it does not need a query or start a model request.

Both sources share CCE's query, evidence/result contract, provenance, workspace assertion and model preferences. CLI uses a fresh local Cursor Agent Ask-mode process with an explicit advertised model/effort; IDE uses Cursor IDE/Agents through CDP. An unavailable source reports its cause without silently switching sources or models. Keep the user's existing model and effort choices.

If `cursor_cce` is unavailable, report that the installed Bridge needs an update/reload. Do not emulate persistence with a conversational promise or edit native Cursor settings.
