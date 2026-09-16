# Cursor Bridge AI Install

You are installing Cursor Bridge into the coding client that is running this task. Read this file and [`ai-install.manifest.json`](./ai-install.manifest.json) completely before changing anything. Then follow every step in order. Report against the [completion standard](#completion-standard). Do not invent a marketplace plugin or extra installer. Use only the dedicated generic npm packages named in the manifest.

[简体中文](./ai-install.zh-CN.md) · [README](../README.md)

## Preconditions

- Cursor Bridge is **Windows only**. If this machine is not Windows, stop and fail the install.
- Node.js 18+ must be on `PATH`.
- Cursor must be installed and signed in.
- This playbook is for hosts that are **not** Codex, Claude Code, Grok Build, or Pi.
- Install Grok Build Supervisor only when the user asked for it.

## 1. Identify the host

Decide the current client from the user's words, available CLIs, and known config directories.

| Host | Action |
|---|---|
| Codex, Claude Code, Grok Build, or Pi | **Stop this playbook.** Use the first-class commands in the root README. Do not clone a sidecar checkout or rewrite plugin files. |
| Uncertain | Ask once which client this is. If there is no answer, continue as a generic MCP host. |
| Any other MCP-capable client | Continue. |

A generic install is not a first-class host and is not live-tested.

## 2. Install the dedicated npm package

Use the dedicated generic packages, not the Pi wrappers:

- Cursor Bridge: `vanyangyang-cursor-bridge`
- Grok Build Supervisor: `vanyangyang-grok-build-supervisor`

Do not install `pi-cursor-bridge` or `pi-grok-build-supervisor` on this path. Do not install the unrelated npm name `cursor-bridge-mcp`. Do not publish `cursor-bridge-workspace`. Do not restore `cursor-mcp-bridge`.

Need these files after install:

- `node_modules/vanyangyang-cursor-bridge/dist/cursor-bridge.mjs`
- `node_modules/vanyangyang-cursor-bridge/skills/cce-routing/SKILL.md`
- `node_modules/vanyangyang-cursor-bridge/skills/cursor-delegate/SKILL.md`

Rules:

1. If the current workspace is already this repository, reuse it only when the user is working on Cursor Bridge itself (`source: repo-workspace`).
2. Otherwise install the pinned package from [`ai-install.manifest.json`](./ai-install.manifest.json) into `%LOCALAPPDATA%\cursor-bridge\npm`.
3. Do not add this repository as a submodule of the user's project.
4. Pin the exact versions from the manifest. Do not install `@latest` or a guessed name.

```powershell
$prefix = "$env:LOCALAPPDATA\cursor-bridge\npm"
npm install --prefix $prefix vanyangyang-cursor-bridge@0.1.0
```

If the user asked for Grok Build Supervisor:

```powershell
npm install --prefix "$env:LOCALAPPDATA\cursor-bridge\npm" vanyangyang-grok-build-supervisor@0.1.0
```

Record `source: npm:vanyangyang-cursor-bridge@0.1.0` and the absolute bundle path:

`%LOCALAPPDATA%\cursor-bridge\npm\node_modules\vanyangyang-cursor-bridge\dist\cursor-bridge.mjs`

If `npm install` returns `E404` or another registry failure, the package may not have been published yet. Clone `%LOCALAPPDATA%\cursor-bridge\checkout` as a fallback, record the npm error in `blockers`, and set `source: git-checkout`. Do not use `npx` against the private root package.

## 3. Register the MCP server

Merge a stdio server into the current host's MCP settings. Do not delete unrelated servers. Use `command: "node"` and one absolute bundle path from the npm prefix, or from the git fallback.

Common shape after the npm install:

```json
{
  "mcpServers": {
    "cursor-bridge": {
      "command": "node",
      "args": ["C:\\Users\\<user>\\AppData\\Local\\cursor-bridge\\npm\\node_modules\\vanyangyang-cursor-bridge\\dist\\cursor-bridge.mjs"]
    }
  }
}
```

If this host uses VS Code / Copilot `servers` instead of `mcpServers`, write:

```json
{
  "servers": {
    "cursor-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\<user>\\AppData\\Local\\cursor-bridge\\npm\\node_modules\\vanyangyang-cursor-bridge\\dist\\cursor-bridge.mjs"]
    }
  }
}
```

Detect the host's real config file from the host itself. Do not invent a new config format. Relative bundle paths fail the install.

If the user asked for Grok Build Supervisor, add a second server named `grok-build-supervisor` pointing at `node_modules/vanyangyang-grok-build-supervisor/dist/grok-build-supervisor.mjs` under the same npm prefix, or at `plugins/grok-build-supervisor/dist/grok-build-supervisor.mjs` in the git fallback.

## 4. Install skills

Copy each Cursor Bridge skill directory **intact**. Do not rewrite, summarize, or flatten `SKILL.md`, `agents/`, or `references/`.

Required skill directories, from the npm package or the git checkout:

- `skills/cce-routing`
- `skills/cursor-delegate`

Choose one skill root:

1. The skill directory this host already documents.
2. An existing skill root already used by this host or project: `.agents/skills`, `.cursor/skills`, `.claude/skills`, `.codex/skills`, `.gemini/skills`, `.opencode/skills`, `.windsurf/skills`, `.roo/skills`, or the matching user-level directory under the home folder.
3. If the host loads `.agents/skills` or `~/.agents/skills`, create `%USERPROFILE%\.agents\skills`.
4. If no skill convention exists, set `skills_unsupported` and continue with MCP only.

Prefer a **user-level** skill root so the user's project git status stays clean. Use a project skill root only when the host does not load user-level skills.

After the copy, these files must exist:

- `<skillsRoot>/cce-routing/SKILL.md`
- `<skillsRoot>/cursor-delegate/SKILL.md`
- `<skillsRoot>/cursor-delegate/references/delegation-contract.md`

Do not copy `hooks/` on this path. Claude Code hooks belong to the marketplace plugin. Do not copy probes, tests, or session-contract docs into the host.

If installing Grok Build Supervisor, copy its three skill directories the same way. Copy command files only when this host already loads a command or prompt directory: `prompts/` from the npm package, or `plugins/grok-build-supervisor/commands/` from a git checkout.

## 5. Reload, initialize, and verify

1. Reload or restart this client's MCP servers and skills. An already-open task does not hot-load new registrations.
2. Confirm the MCP tools in [`ai-install.manifest.json`](./ai-install.manifest.json) `requiredTools` are visible.
3. Call `cursor_init` with the user's current project as one absolute Windows path.
4. Call `cursor_status` and record the bound workspace.

If `cursor_init` returns `close_cursor_and_retry`, tell the user to save work, close Cursor normally once, and retry. That is an incomplete install, not a success.

## Completion standard

Fill every field. Use `PASS` only when every required item is true.

```text
## Cursor Bridge install report
- host: <client name>
- path: first-class marketplace | generic-ai-install
- source: npm:vanyangyang-cursor-bridge@0.1.0 | git-checkout | repo-workspace
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
- The host is not a first-class marketplace host, or the user explicitly asked to bypass it.
- `source` is `npm:vanyangyang-cursor-bridge@<manifest version>`, or a recorded npm failure plus `git-checkout` / `repo-workspace`.
- The install contains the Cursor Bridge bundle from that source.
- MCP config uses `node` plus an absolute `dist/cursor-bridge.mjs` path.
- After reload, `cursor_init`, `cursor_context_engine`, `cursor_status`, and `cursor_model` are visible.
- Skills are copied intact, or `skills_unsupported` is reported with the reason.
- `cursor_init` is `ready` for the intended workspace, or the report records `close_cursor_and_retry` and `result` is `FAIL`.
- No npm publish, no ACL change, no mass-stop of Node or PowerShell, and no Pi package or extra product name was used.

### FAIL immediately when

- The machine is not Windows and the install continued.
- A first-class host was used with this generic path without an explicit bypass request.
- MCP was registered with a relative bundle path or `npx` of the private root package.
- `pi-cursor-bridge`, `pi-grok-build-supervisor`, or the unrelated `cursor-bridge-mcp` package was installed on this path.
- Skill files were rewritten instead of copied.
- Claude Code hooks were installed on a non-Claude host.
- The report claims live-tested support for this generic host.
- `result` is `PASS` while `init` is not `ready`.

A first-class marketplace install reports `path: first-class marketplace` and `skipped-first-class` for generic fields, then uses the root README verification: new task or plugin reload, then a successful workspace initialization.
