# Cursor Bridge 6.2.0 local-provider verification

Dates: 2026-10-31 to 2026-11-01 (Asia/Singapore). Scope: Windows 11, official `agent-cli-local` 2026.10.22-27dcf5f, own-key OpenAI Responses, and the new optional CCE CLI provider path. The broader historical IDE matrix is unchanged.

## Live evidence

The rebuilt stdio MCP adapter was tested with `CURSOR_BRIDGE_CDP_PORT=1`, IDE autolaunch disabled and delegation off. The source tool configured a local provider using credential-file and bundled-runtime paths; the model tool set an explicit named reasoning model and xhigh effort. No key content was sent in tool arguments or stored in the repository.

Release-build task `cursor-mvwl13on-1` completed a real `cursor_context_engine` request through the Cursor local harness. It returned verified `readCcePreferences` and `writeCcePreferences` anchors in `cursor-cce-preferences.mjs`. Both anchors were checked against actual source. Four provider requests and their complete responses confirmed the configured model and xhigh; the final selection used `verificationSource=cursor_cli_provider_response`, `providerResponseConfirmed=true`, and `harness=cursor-agent-local`. This 6.2.0 run used the durable installed CLI directory rather than a temporary unpack location.

Switching CLI → IDE → CLI preserved the provider. A fresh MCP server loaded the same CLI provider after restart. `cursor_do` was absent from the off-mode tool list. Native CLI settings, permissions and real Bridge model-preference files remained byte-for-byte unchanged during the isolated acceptance.

Earlier independent validation proved a random local file could be read through the native tool loop and its exact contents returned, with matching provider receipts. The first exploratory project query used a five-request probe cap and did not complete; it is not counted as a passed retrieval. The shipped implementation uses the CCE job timeout and cancellation contract instead of that probe cap.

## Regression and distribution

Focused regressions cover persistent provider configuration, queued provider/model snapshots, native harness invocation, per-process profile isolation, exact endpoint/model/effort enforcement, metadata-only preflight, credential error redaction, rejected or incomplete streams, complete result acceptance, and unchanged account CLI behavior. The provider preload is bundled independently and included in both package staging paths.

Release regression passed 556/556, the unchanged Supervisor passed 147/147, both MCP protocol smoke checks passed, and the Claude marketplace validator passed. Package staging tests require the provider preload alongside the main bundle. This document does not certify arbitrary providers, cross-platform real devices, or Cursor account/server-side semantic-index capabilities in authless mode.
