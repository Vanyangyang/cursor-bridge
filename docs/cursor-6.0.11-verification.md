# Cursor Bridge 6.0.11 verification

Date: 2026-10-29. Scope: model configuration verification and picker-independent submission in Cursor 3.27.22 Agents Window on Windows.

## Failure boundary and repair

The reported error was `CURSOR_MODEL_PICKER_DID_NOT_OPEN` before submission. The reporting adapter's original task details were not retained. During this investigation the same failure was reproduced on the exact Cursor page: `document.visibilityState` was `hidden`, the project trigger was logically closed, but `search-menu-popup[data-closed]` and its pointer-active closed backdrop remained mounted over the model trigger. Existing background-throttling flags did not release that layer. A live read also showed that 6.0.10 normal mode required opening the picker even when Grok 4.7/high was already selected.

The new path reads the current model trigger's committed React configuration before considering the menu. It proves actual child/sibling edges from `root.current`, the writable composer, unique Agent identity, explicit non-Auto mode, one model/count=1, and unique string parameters. It never adopts `_cachedData` as proof. Model and effort must exactly match the request; inconsistent model names or effort fields are rejected.

A matching configuration uses no model-menu clicks, hovers, opening, or cleanup. The verified Agent/composer identity is frozen and checked again against fresh configuration immediately before sending, including provisional Agent identities. A mismatch or read failure stops submission. If Enter may already have been dispatched, a failed fallback recheck retains possible-send status instead of claiming the request was unsent.

When a normal-mode selection really needs to change or lacks provable configuration, the existing guarded picker remains available. A picker already reporting expanded is left open while its ownership links load. Minimal mode still refuses changes that cannot be confirmed without a menu.

FIFO, parallel submission, and continued-session clients hold a scoped `Emulation.setFocusEmulationEnabled` override. It lets hidden pages finish popup transitions without restoring or moving the native window. Every exit restores the override and closes the CDP connection; disconnection also clears Chromium's per-session override. Only a protocol method-not-found response permits the legacy fallback, while other activation failures retain their original cause. Read-only status does not acquire the override.

The current picker can expose only its enabled Auto toggle until Auto is disabled. The row reader identifies that exact control independently of its explanatory label. It is clicked at most once, and named-model lookup resumes only after a unique explicit off state is observed under the same composer and menu ID. Losing the toggle or its ownership is not accepted as proof.

## Validation

- A read-only live probe created three fresh Agents with all model-menu operations replaced by throwing functions. Each verified Grok 4.7/high and passed the pre-send check, with zero model-menu calls and zero submitted prompts.
- Enabling the renderer override changed the hidden page's visibility to active, released the retained project backdrop, and allowed the model picker to open. Releasing it restored `hidden`. Two simultaneous CDP clients were checked: releasing one did not clear the other's override.
- The live Auto toggle transitioned from explicit on to explicit off. A stale model catalogue temporarily omitted Grok 4.7; selection stopped before prompt entry rather than choosing a substitute. Cursor's normal Refresh model list control restored the catalogue, after which committed Grok 4.7/high configuration was verified. A transient CDP read timeout during UI selection also remained a pre-send failure rather than being disguised as an empty menu.
- A rebuilt 6.0.11 MCP bundle completed real read-only CCE and FIFO requests while all four model-menu operations were replaced with throwing functions. Both replies were explicitly collected. FIFO task `cursor-mvt8x23q-2` reported applied Grok 4.7/high, `committed_composer_model_config`, and a fresh `lastVerifiedAt`; configured defaults remained unchanged and the adapter returned idle.
- Regression cases cover current versus stale React branches, Auto/multiple selections/count, duplicate and conflicting parameters, wrong or provisional Agent identity, cancellation and transport errors, zero-UI success, fallback selection, configuration changes after Enter, explicit Auto-off ownership, and renderer restoration.
- Final repository regression: 509/509 passed. The unchanged Grok Build Supervisor regression: 147/147 passed. Full builds, both MCP stdio checks, Cursor wrapper stdio check, Pi/MCP staging, and Claude plugin/marketplace manifest validation passed.

All real model requests used Grok 4.7/high. Persisted preferences are not changed by the published patch.

The historical broader 6.0.8 / Cursor 3.23.12 baseline remains unchanged. This patch does not certify the full 3.27.22 IDE, parallel/session, cancellation, startup, or hidden-mode live matrix. Existing host processes must reload to use a newly installed bundle.
