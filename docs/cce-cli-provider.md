# CCE CLI with a local Responses provider

Cursor Bridge can run the official `agent-local` CLI with your own OpenAI-compatible Responses provider. Cursor runs the Agent loop, prompt construction, tools and permissions. Bridge adapts provider metadata and request parameters; it does not implement a replacement harness.

This route is opt-in. Fresh installations continue to use IDE/Agents, which needs no Cursor CLI or CLI credential file. Upgrades preserve an existing source selection. A missing optional CLI does not affect IDE initialization or retrieval, even when a provider configuration is saved. An explicitly selected but unavailable CLI reports an error; use `/cce ide` to return to IDE explicitly, subject to the same model and effort checks.

## Configure once

Upgrade every host sharing these preferences to Cursor Bridge 6.2.0 or newer before configuring a provider; older adapters do not understand the new route.

Install an official `agent-cli-local` package separately and keep its bundled Node and `index.js` together. The tested Windows package is [2026.10.22-27dcf5f](https://downloads.cursor.com/lab/2026.10.22-27dcf5f/windows/x64/agent-cli-local-package.zip). The ordinary account CLI is a different build and cannot enable its local-provider runtime with flags alone. Keep this experimental distribution version pinned; public account-CLI documentation does not certify this mode.

Save your provider key in a local credential file. Do not paste it into the MCP arguments, instructions or chat. Configure the route using non-secret paths:

```text
cursor_cce(action="set", source="cli", cli_provider={
  kind: "openai-responses",
  node_path: "C:/Tools/CursorAgentLocal/node.exe",
  entrypoint: "C:/Tools/CursorAgentLocal/index.js",
  base_url: "https://api.openai.com/v1",
  api_key_file: "C:/Private/provider-key.txt"
})
```

Set your named model and explicit reasoning effort separately with `cursor_model(action="set", target="cce", model="<provider-model-id>", effort="<supported-effort>")`. Then use `cursor_init` and `cursor_context_engine` normally. The settings survive host restarts and plugin upgrades. `/cce cli` and `/cce ide` preserve the provider configuration; an explicit `cli_provider=null` removes it.

Paths must be absolute. Remote endpoints require HTTPS; explicit loopback HTTP endpoints are accepted for local providers. Credentials are read only by the child-side provider adapter and attached only to the exact configured endpoint, with redirects disabled. The key is not copied into native CLI settings or inherited environment. The independent model/effort preference is frozen for each request.

## Verification and capabilities

Bridge checks the native `agent-local` identity and model availability without sending inference. Each Ask turn uses a private native configuration. Every Responses request enforces the selected model, effort and `store:false`; stateless reasoning replay requests encrypted reasoning content. A complete successful CLI turn, zero exit code, and matching provider model/effort receipts are required before returning CCE evidence. Mismatches, partial streams and provider errors fail explicitly. Raw provider error messages are withheld because they can echo credentials.

`cursor_status` exposes `cursor_cli_provider_response`, `providerResponseConfirmed`, `providerRequestCount`, and a credential-free provider/harness summary. Cancellation and disconnect use the existing owned-process-tree handling; uncertain termination retains the reservation. No separate daemon, system proxy change or IDE model-picker interaction is required. If the machine already configures HTTP(S) environment proxies, the child enables bundled Node's environment-proxy support unless explicitly overridden.

The CCE query, provenance, workspace guards, queue and `CCE_SEARCH_RESULT` contract remain the same. Authless mode provides Cursor's local retrieval tools. Cursor account services, cloud-only features and a server-side semantic index are not implied. Windows has focused live evidence; other platforms and arbitrary providers require their own acceptance.
