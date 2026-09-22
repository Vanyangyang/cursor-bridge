# Cursor Bridge AI Install

You are installing Cursor Bridge into the AI client that is running this task — the coding app hosting this conversation, not the Cursor Agent. Read this file and [`ai-install.manifest.json`](./ai-install.manifest.json) completely before changing anything. Then follow every step in order. Report against the [completion standard](#completion-standard). Do not invent a marketplace plugin or extra installer. Use only the dedicated generic npm packages named in the manifest.

[简体中文](./ai-install.zh-CN.md) · [README](../README.md)

## Preconditions

- Cursor Bridge is **Windows only**. If this machine is not Windows, stop and fail the install.
- Node.js 18+ must be on `PATH`.
- Cursor must be installed and signed in.
- This playbook is for AI clients that are **not** Codex, Claude Code, Grok Build, or Pi.
- Install Grok Build Supervisor only when the user asked for it.

## 1. Identify the AI client

Decide the current AI client from the user's words, available CLIs, and known config directories.

| AI client | Action |
|---|---|
| Codex, Claude Code, Grok Build, or Pi | **Stop this playbook.** Use the first-class commands in the root README. Do not clone a sidecar checkout or rewrite plugin files. |
| Uncertain | Ask once which AI client this is. If there is no answer, continue as a generic MCP-capable AI client. |
| Any other MCP-capable AI client | Continue. |

A generic install is not a first-class AI client and is not live-tested.

## 2. Install the dedicated npm package

Use the dedicated generic packages, not the Pi wrappers:

- Cursor Bridge: `vanyangyang-cursor-bridge`
- Grok Build Supervisor: `vanyangyang-grok-build-supervisor`

Do not install `pi-cursor-bridge` or `pi-grok-build-supervisor` on this path. Do not install the unrelated npm name `cursor-bridge-mcp`. Do not publish `cursor-bridge-workspace`. Do not restore `cursor-mcp-bridge`.

Rules:

1. If the current workspace is already this repository, reuse it only when the user is working on Cursor Bridge itself (`source: repo-workspace`).
2. Otherwise install the pinned package from [`ai-install.manifest.json`](./ai-install.manifest.json) into `%LOCALAPPDATA%\cursor-bridge\npm`.
3. Do not add this repository as a submodule of the user's project.
4. Pin the exact versions from the manifest. Do not install `@latest` or a guessed name. Do not use `npx` against the private root package, and do not launch these dedicated packages with `npx`.

```powershell
$prefix = "$env:LOCALAPPDATA\cursor-bridge\npm"
npm install --prefix $prefix vanyangyang-cursor-bridge@0.1.3
```

If the user asked for Grok Build Supervisor:

```powershell
npm install --prefix "$env:LOCALAPPDATA\cursor-bridge\npm" vanyangyang-grok-build-supervisor@0.1.0
```

Record `source: npm:vanyangyang-cursor-bridge@0.1.3`.

If `npm install` returns `E404` or another registry failure, clone `%LOCALAPPDATA%\cursor-bridge\checkout` as a fallback, record the npm error in `blockers`, and set `source: git-checkout`.

## 3. Where the files are

After the npm install, this AI client decides how to register MCP and skills. Do not invent a new config format, and do not rewrite skill files. Do not copy `hooks/`. Claude Code hooks belong to the marketplace plugin. Do not copy probes, tests, or session-contract docs into the AI client.

Cursor Bridge is here:

- MCP: `%LOCALAPPDATA%\cursor-bridge\npm\node_modules\vanyangyang-cursor-bridge\dist\cursor-bridge.mjs`
- Skills root: `%LOCALAPPDATA%\cursor-bridge\npm\node_modules\vanyangyang-cursor-bridge\skills`
- `skills/cce-routing`
- `skills/cursor-delegate`

For `source: git-checkout`, the same relative paths live at the checkout root: `dist/cursor-bridge.mjs` and `skills/`. For `source: repo-workspace`, use those two locations in the current repository.

MCP must use `"node"` plus the **absolute** bundle path above. Relative bundle paths fail the install. Do not delete unrelated servers already in the AI client.

If the user asked for Grok Build Supervisor, it is here under the same npm prefix:

- MCP: `node_modules/vanyangyang-grok-build-supervisor/dist/grok-build-supervisor.mjs`
- Skills root: `node_modules/vanyangyang-grok-build-supervisor/skills`
- Commands: `node_modules/vanyangyang-grok-build-supervisor/prompts`

For `source: git-checkout`, that is `plugins/grok-build-supervisor/dist/grok-build-supervisor.mjs`, `plugins/grok-build-supervisor/skills/`, and `plugins/grok-build-supervisor/commands/`.

If this AI client has no skill convention, set `skills_unsupported` and register MCP only. Do not rewrite, summarize, or flatten `SKILL.md`, `agents/`, or `references/`.

## 4. Restart this AI client

After registration, restart the current AI client so MCP and skills load. An already-open task does not hot-load new registrations.

## 5. Initialize and verify

1. Confirm the MCP tools in [`ai-install.manifest.json`](./ai-install.manifest.json) `requiredTools` are visible.
2. Call `cursor_init` with the user's current project as one absolute Windows path.
3. Call `cursor_status` and record the bound workspace.

If `cursor_init` returns `close_cursor_and_retry`, tell the user to save work, close Cursor normally once, and retry. That is an incomplete install, not a success.

## Completion standard

Fill every field. Use `PASS` only when every required item is true.

```text
## Cursor Bridge install report
- host: <AI client name>
- path: first-class marketplace | generic-ai-install
- source: npm:vanyangyang-cursor-bridge@0.1.3 | git-checkout | repo-workspace
- checkout: <absolute npm prefix, git checkout, or repo path>
- mcpConfig: <absolute config file>
- mcpBundle: <absolute dist/cursor-bridge.mjs>
- mcpTools: <comma-separated visible tool names>
- skillsRoot: <absolute path> | skills_unsupported
- skills: cce-routing=<ok|missing|unsupported> cursor-delegate=<ok|missing|unsupported>
- init: ready | failed | close_cursor_and_retry | skipped-first-class
- workspace: <absolute path or none>
- grok: skipped | installed | failed
- windowsOnly: acknowledged
- blockers: none | <short list>
- result: PASS | FAIL
```

### Required for PASS on the generic path

- The machine is Windows.
- The AI client is not a first-class marketplace AI client, or the user explicitly asked to bypass it.
- `source` is `npm:vanyangyang-cursor-bridge@<manifest version>`, or a recorded npm failure plus `git-checkout` / `repo-workspace`.
- The install contains the Cursor Bridge bundle from that source.
- MCP config uses `node` plus an absolute `dist/cursor-bridge.mjs` path.
- After this AI client restarts, `cursor_init`, `cursor_context_engine`, `cursor_status`, and `cursor_model` are visible.
- Skills are registered from the directories above using this AI client's own placement, and were not rewritten; or `skills_unsupported` is reported with the reason.
- `cursor_init` is `ready` for the intended workspace, or the report records `close_cursor_and_retry` and `result` is `FAIL`.
- No npm publish, no ACL change, no mass-stop of Node or PowerShell, and no Pi package or extra product name was used.

### FAIL immediately when

- The machine is not Windows and the install continued.
- A first-class AI client was used with this generic path without an explicit bypass request.
- MCP was registered with a relative bundle path, `npx` of the private root package, or `npx` launching a dedicated package.
- `pi-cursor-bridge`, `pi-grok-build-supervisor`, or the unrelated `cursor-bridge-mcp` package was installed on this path.
- Skill files were rewritten instead of being registered from the installed directories.
- Claude Code hooks were installed on a non-Claude AI client.
- The report claims live-tested support for this generic AI client.
- `result` is `PASS` while `init` is not `ready`.

A first-class marketplace install reports `path: first-class marketplace` and `skipped-first-class` for generic fields, then uses the root README verification: new task or plugin reload, then a successful workspace initialization.
