# Cursor 3.21.16 verification

- Date: 2026-09-22
- Platform: Windows 11
- Cursor executable: `D:\tool\cursor\Cursor.exe`
- Cursor evidence: embedded `resources/app/package.json` and the current-user uninstall registry both report `3.21.16`
- Cursor Bridge candidate: `6.0.5`

## Evidence boundary

This report covers the checked-out source and rebuilt bundles against the real installed Cursor 3.21.16. The broad IDE and Agents Window acceptance was completed for 6.0.4. The model-provider alias fix was then installed through a refreshed Codex cache and passed a native task before the version-only bump to 6.0.5; that native host reported `pluginVersion=6.0.4`. The 6.0.5 bundle contains the tested fix plus release metadata changes. Exact native pickup of the 6.0.5 label remains pending a fresh host task after publication.

The macOS `Cursor.app` CDP identity fix is covered by source tests and generated bundles. No macOS device was available, so this report does not claim macOS end-to-end support.

## Live results

| Area | Result | Evidence |
|---|---|---|
| Grok 4.7 model alias and effort | Pass | Source CDP selected trigger `Grok 4.7 High`, internal `modelName=grok-4.7`, and `reasoning_effort=high` without submitting a prompt. Native read-only FIFO task `cursor-mucels2b-1` then completed with requested `grok-4.7`/`high`, applied `Grok 4.7 High`, and made no file changes. |
| Agents Window exact workspace | Pass | Cursor 3.21 grouped the main checkout and Codex worktree under one repository section. The candidate selected the exact worktree path from `Select a project`, then verified workspace ID `d37abfbf7a774f6e5470cc8cdd1c140e`. |
| Agents Window CCE | Pass | `cursor-mub0w43x-1`, Agent `local:5526889a-e64a-4f61-b99e-68419cf764b4`, `Cursor Grok 4.6 High`, `high`. |
| Agents Window FIFO `cursor_do` | Pass | `cursor-mub0y9nk-2`, Agent `local:3f49258f-9d86-401a-8a30-f8b2d4795344`, read only, exact worktree, `Cursor Grok 4.6 High`. |
| IDE CCE | Pass | `cursor-mub1290q-1`, Agent `local:e361c68d-d1b8-449a-bc89-e9ffe97fe9d4`, `Cursor Grok 4.6 High`, `high`. |
| IDE FIFO `cursor_do` | Pass | `cursor-mub13upz-2`, Agent `local:16d355a1-c085-4113-a8c7-c92bb746882a`, read only, `targetUiFlavor=legacy`, `Cursor Grok 4.6 High`. |
| Independent Agents | Pass | `cursor-mub1d43z-1` and `cursor-mub1d46l-2` ran concurrently with two distinct Agent IDs and both returned their required markers with Grok/high applied. |
| Persistent session | Pass | Session `cursor-session-7d3f8b27-0109-48d5-ac85-68713c7b87eb`, Agent `local:9c023afc-7011-4f90-bb26-dbd5074fe074`, completed three read-only turns across adapter restart; unread result recovery and repeat collection behavior passed. |
| Minimal / normal | Pass | Cursor was hidden, CCE completed after exact hidden `modelConfig` verification (`grok-4.6`, `effort=high`), and the same Cursor process was restored to normal display. |
| Last-closed IDE restoration | Pass | A supervisor-observed IDE close was followed by a default launch with `startupWindow.uiFlavor=legacy`; `/json/list` contained exactly one IDE page. |
| Last-closed Agents restoration | Pass | A supervisor-observed Agents Window close was followed by a default launch with `startupWindow.uiFlavor=agents_v2`; `/json/list` contained exactly one `Cursor Agents` page. |

## Cursor 3.21 changes covered

- Model rows no longer advertise the Effort submenu. Cursor Bridge now selects the requested model first, then applies the separate root Effort control and verifies the result.
- Current picker rows may omit the older `Cursor` provider prefix. Cursor Bridge now normalizes that alias symmetrically and reads `reasoning_effort` with a legacy `effort` fallback.
- Multiple local worktrees for the same repository share one sidebar section. Cursor Bridge now selects the exact registered file path in the new Agent project picker before prompt entry.
- Hover preview cards use `role=dialog`. They no longer count as blocking modal dialogs; real dialogs still fail closed.
- Hidden windows no longer render the model popup. Minimal mode verifies the selected Agent's exact React `modelConfig` and fails before submission when it does not match.

## Remaining gaps

- Exact native Codex host pickup of the Cursor Bridge 6.0.5 version label remains pending publication, reinstall, and a fresh host task; the release code path itself passed under the pre-bump 6.0.4 cache label.
- Attached-mode fallback was inherited and was not live rechecked on Cursor 3.21.16.
- macOS real-device acceptance remains pending.
- The historical `ETIMEDOUT` root cause remains `UNKNOWN`.
