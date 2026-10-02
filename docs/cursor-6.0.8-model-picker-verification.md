# Cursor Bridge 6.0.8 model-picker verification

Release date: 2026-10-03 (Asia/Singapore). Environment: Windows 11, Cursor 3.23.12 (`2d29876d567da1607532b23bbf2cd5ddbca496f0`), Node 24.14.0. Both Cursor CLI and embedded package metadata identify the installed version. Saved CCE and execution preferences remain Grok 4.7 / high.

## Reported failure and controlled reproduction

The user's real 6.0.7 request failed before prompt submission with `CURSOR_MODEL_PICKER_DID_NOT_OPEN`, `stage=open_picker`, and 490ms elapsed. A later request against the same running Cursor succeeded. The original scene was not recorded, so its exact rendering delay or obstruction cannot be reconstructed from the screenshot.

A controlled 600ms menu-render delay reproduced the same premature error using the installed, released 6.0.7 bundle: one click, failure at 450ms, `sendState=not_sent`. The patched 6.0.8 source opened the menu in 717ms with one click and the same unsent state. This establishes the fixed-wait defect; it does not prove which transient occurred in the historical scene.

A second check used the real Cursor UI and swallowed exactly the first native click on the test-owned model trigger. Released 6.0.7 failed at 470ms; the patch opened it at 950ms through one guarded recovery, with zero tasks or submitted prompts. The first candidate's cold-start failure showed why longer polling alone was insufficient. The final recovery independently rechecks the same trigger, explicit closed state, ownership, coordinates, and hit target before calling its normal click handler. Open or ambiguous state does not permit a second activation.

## Change and regression scope

- Resolve the model trigger from one writable input and its own composer; reject missing or ambiguous ownership instead of choosing the last global trigger.
- Follow the trigger's accessibility links to the root menu and its submenus. Retain legacy fallback only when the input, visible trigger, and root menu are unique.
- Check enabled state, viewport, and actual hit ownership; wait for stable identity and coordinates before clicking.
- Send one native click and poll within a two-second budget. If the same trigger explicitly stays closed, allow at most one verified recovery after 750ms. Check cancellation and preserve transport errors; budget expiry retains the last useful observations instead of issuing a 1ms read.
- Match menu and trigger ownership across their separate reads, freeze ownership after clicking, and recheck cancellation before returning an opened menu or operating its controls.
- Keep model and effort confirmation, Auto rejection, workspace checks, and persistent preferences unchanged.

The new `test/model-picker-open.test.mjs` passes 44/44 cases, including delayed rendering, layout movement, obstruction, foreign menus, ambiguous composers, exact submenu ownership, cancellation, guarded recovery, deadline diagnostics, and unsent failures.

Full repository regression passes 425/425 with no failures or skips. The unchanged Supervisor passes 147/147 and its six-tool MCP smoke. Root, staged Pi, and staged generic MCP smokes require version 6.0.8, eight tools, two workspace rejections before submission, and unchanged isolated preferences.

## Live acceptance

Source 6.0.8 in Agents Window passed Grok 4.7/high CCE and FIFO:

- CCE Agent: `local:e1deaeb5-a3fd-48fe-aa67-7bde0532d5c6`.
- FIFO Agent: `local:533a2b73-72b7-40ce-8c68-becc91455d68`.
- Two simultaneous independent Agents completed with the pinned model and no FIFO fallback: `local:d9a1683d-40b1-45c7-bd13-c779501453f4` and `local:5a75e20a-2e58-408c-ae48-8f31f0b4379e`.
- Rebuilt 6.0.8 stdio completed three turns on `local:a48ce54f-177a-40a2-9e43-3ce1cd8efa5f`, including adapter restart, unread-result recovery, and repeated collection without another UI read.
- IDE CCE and FIFO passed; FIFO Agent: `local:fee46302-6c84-49ee-9826-4b2760c56ec1`. A test-owned draft switched Auto to Grok 4.7/high without submitting a prompt; the original 256k context and Fast-off UI parameters were restored afterward.
- Hidden CCE completed in both UI types and returned to normal. Both normal close orders restored exactly one window of the last-closed type; no force termination was used.
- The final rebuilt 6.0.8 stdio adapter completed a read-only CCE in the originally reported workspace: `local:0a75e8be-29ee-44ed-85b9-0e983c8290eb`, with exact workspace identity and Grok 4.7/high confirmed. Returned `package.json` anchors were checked in the real file.
- A further normal restart with the final source completed the first CCE after renderer readiness; the model catalog was available and the menu opened without needing the recovery path.

Cold UI checks wait for the writable renderer and History adapter to be ready before the first model interaction. An earlier diagnostic launched directly at CDP availability and received `workspace_probe_unavailable` before model selection; that attempt submitted no prompt and is not counted as a model-selection pass. This patch does not claim to change workspace-startup readiness.

## Inherited evidence and host boundary

Unchanged lifecycle, registration, attached fallback, and exact Stop behavior inherit the [6.0.7 acceptance](./cursor-3.23.12-verification.md). Its injected IPC rejection is not a real OS policy test. macOS receives portable regression CI; no macOS Cursor UI acceptance is claimed. Historical `ETIMEDOUT` remains unexplained.

Installing a new package does not prove that an already-running host MCP process reloaded it. The host's `cursor_status.pluginVersion` must show 6.0.8 before claiming native pickup; otherwise open a new host task or reload the MCP host. A Cursor restart alone does not reload the host adapter.
