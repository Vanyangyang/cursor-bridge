# Cursor 3.20.21 / Bridge 6.0.3 verification

Date: 2026-09-16. Installed `D:\tool\cursor\Cursor.exe` reports ProductVersion and FileVersion **3.20.21**. Source work started from `ee9c299`; the release also includes the already-published star-history updates through `660cbd5`.

## Findings and fixes

1. After the user saved and exited both windows, the original cold-launch code started PID 31584 with only the CDP arguments. It returned `launched-agents-window`, but CDP exposed both `Cursor Agents` and `Cursor`. The fix explicitly selects `--glass` or `--classic`; the IDE opens the requested workspace during that same launch.
2. Cursor's `windowsState.lastActiveWindow.uiState.glassMode` identifies the saved window type. However, both CDP close and normal Windows close could leave it stale. The installed Cursor main log at 2026-09-16 11:52:23 reported `ENOPRO: No file system provider found` while writing its `User/globalStorage/storage.json` on shutdown.
3. The supervisor now observes browser CDP target creation, title changes and destruction, and records the final closed Cursor window in Bridge's own `last-window.json`. If browser CDP disconnects before destruction events, a single remaining known window is usable; multiple remaining types are not guessed. A changed native last-window record takes precedence over the fallback. Bridge never rewrites Cursor settings/storage. The supervisor remains alive while this observation is active.
4. IDE CCE initially failed before send with `CURSOR_COMPOSER_NOT_SEND_READY`: its real Send control was `.send-with-mode .anysphere-icon-button` containing `.codicon-arrow-up-two`. Readiness and submission now share the same scoped selector, excluding disabled, hidden, foreign-composer, stop and ambiguous controls.
5. Hiding a process launched without background-rendering flags reproduced model-picker timeout/cleanup failures in both types. A fresh process carrying the three disable-backgrounding flags passed the same no-prompt probe and hidden CCE. Normal cold launches now carry these flags too, because normal can switch to minimal without a restart.

## Default startup acceptance

This used the real saved state and the built supervisor through `ensureCursorRunning`, without injecting a preferred type. A separate supervisor directory isolated the new runtime from the still-running old host. The user authorized closing/restarting only test-created idle windows; no unsaved editor was found. Five consecutive post-launch samples contained exactly one CDP page in each case.

| Last close order | Default result | Cursor PID | Evidence |
| --- | --- | --- | --- |
| Agents Window last | Only Agents Window | 43668 | `outputs/default-launch-agents-v2.json` |
| Agents first, IDE last | Only IDE | 50392 | `outputs/default-launch-ide-v2.json` |
| IDE first, Agents last | Only Agents Window | 48592 | `outputs/default-launch-agents-after-ide-v2.json` |

All three reported `startupWindow.source=bridge-last-closed-window` and the correct `uiFlavor`. The initial native-state-only Agents launch also passed; the normal IDE shutdown failure is why that source alone was insufficient.

## Built standalone MCP acceptance

Final bundle: Bridge **6.0.3**, using **Cursor Grok 4.6 / high** for CCE and execution. Model and runtime preferences belonged to isolated test configuration files; account-wide model defaults were not rewritten. Source-level checks earlier in the investigation are separate from this final bundle acceptance.

| Check | Agents Window | IDE/workbench |
| --- | --- | --- |
| One CDP page before and after tasks | PASS | PASS |
| Requested workspace ready | PASS, registered file URI | PASS, matching IDE workspace |
| CCE while minimal/hidden, checked source anchors | PASS | PASS |
| Return to normal | PASS | PASS |
| FIFO task and result collection | PASS | PASS |
| Independent `parallel_agent`, no FIFO fallback | PASS | PASS |
| Grok/high selection applied | PASS | PASS |
| Repeated explicit result stable | PASS | PASS |
| Final idle, queue 0 | PASS | PASS |

Final task identities:

- Agents FIFO: `cursor-mu3kz39r-2`, Agent `local:36747421-6abb-41dd-b0c2-4dac6d009509`.
- Agents independent task: `cursor-mu3kzdqo-3`, Agent `local:c926ef9c-943a-411e-8f1d-2e79b9276e28`.
- IDE FIFO: `cursor-mu3l4bdj-2`, Agent `local:034f7afc-6397-4849-98ee-aad0542e56f2`.
- IDE independent task: `cursor-mu3l4v4b-3`, Agent `local:09f435be-a7fb-479b-b830-92eb978a692d`.

Local reports: `outputs/release-6.0.3-agents.jsonl` and `outputs/release-6.0.3-ide.jsonl`. Each CCE response located `createWindowCloseObserver` / `windowFlavor`; source anchors were checked against the actual file. Tasks read only root `package.json` and returned version 6.0.3. No task changed repository files.

## Automated/build evidence and limits

- Full Node suite: **288 passed, 0 failed**. Includes both close orders, browser-disconnect ambiguity, native-state precedence, profile isolation, both cold-launch types, mixed already-open windows and Send-control exclusions.
- Rebuilt the Cursor Bridge adapter and lifecycle supervisor. Unrelated dirty Grok files were excluded and preserved.
- Native host remained on **6.0.2**. Built standalone MCP acceptance does not establish that the current host has loaded 6.0.3; a fresh host must load the updated plugin.
- Parallel checks establish independent-Agent execution, not simultaneous busy Agents. Persistent session continuation/cancellation, attached fallback, macOS/Linux runtime behavior and other Cursor versions were not revalidated.
- A disconnected observer cannot infer the order of multiple remaining window types. In that case it retains the last reliable saved evidence. Historical transport timeout causes remain `UNKNOWN`.
