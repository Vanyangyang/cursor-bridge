# Releasing This Repository

This repository ships two independently installable plugins and two independently versioned Pi Packages.

| Product | Current release target | Distribution |
|---|---:|---|
| Cursor Bridge | 5.9.1 | Codex, Claude Code, Grok Build |
| Grok Build Supervisor | 0.4.0 | Codex, Claude Code |
| Cursor Bridge for Pi | 0.1.14 | `pi-cursor-bridge` on npm |
| Grok Build Supervisor for Pi | 0.1.5 | `pi-grok-build-supervisor` on npm |

The private `cursor-bridge-workspace` root exists only for development, build, and test tooling; do not publish it or the retired `cursor-mcp-bridge` package. The Pi versions are wrapper-package versions; their manifests must also name the exact embedded Cursor Bridge or Grok Build Supervisor version.

## Build commands

Run builds from the repository root:

```powershell
npm install

# Canonical full build: Cursor Bridge plus both Supervisor bundles
npm run build

# Canonical Supervisor-only build when Cursor Bridge source did not change
npm run build:grok-supervisor

# Create disposable staging trees for both Pi Packages
npm run build:pi-packages
```

`npm run build` must produce all four committed dependency-free runtime files:

- `dist/cursor-bridge.mjs`
- `dist/cursor-lifecycle-supervisor.mjs`
- `plugins/grok-build-supervisor/dist/grok-build-supervisor.mjs`
- `plugins/grok-build-supervisor/dist/supervisor-daemon.mjs`

Installed plugins execute these bundles directly; their hosts do not install runtime dependencies inside the plugin cache. Never release a source change with stale bundles.

`.pi-package-stage/` is disposable build output and must not be committed. Each staged tarball must contain the final tagged bundles, Skills, prompt templates, manifests, and package README.

## Version synchronization

### Cursor Bridge

Keep 5.9.1 synchronized in:

- `package.json` (the root `package-lock.json` remains an ignored local build input)
- `server.mjs` (`PLUGIN_VERSION`)
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json` Cursor entry
- `.codex-plugin/plugin.json` base version; use the Codex cachebuster helper for the suffix during local installation
- root English and Chinese compatibility/current-version documentation
- version contract tests

### Grok Build Supervisor

Keep 0.4.0 synchronized in:

- `plugins/grok-build-supervisor/package.json` and its `package-lock.json`
- `plugins/grok-build-supervisor/scripts/server.mjs`
- its Claude and Codex plugin manifests
- the root Claude marketplace Supervisor entry
- its English and Chinese README, changelog, and version contract tests

### Pi Packages

Keep the wrapper and embedded versions synchronized:

- `pi-cursor-bridge`: package and adapter 0.1.14, embedded Cursor Bridge 5.9.1
- `pi-grok-build-supervisor`: package and adapter 0.1.5, embedded Grok Build Supervisor 0.4.0
- package READMEs and Pi staging tests

## Validation

Run the smallest relevant suite after each block, then the complete repository and Supervisor suites before publication:

```powershell
npm test
npm --prefix plugins/grok-build-supervisor test
npm --prefix plugins/grok-build-supervisor run smoke:mcp
npm run build:pi-packages
```

Also validate both plugin structures with the current Claude/Codex validators, inspect staged npm package contents, and verify source, committed bundles, and staged tarballs agree. Live compatibility claims require the documented Windows 11 + current Cursor/Grok/Pi user paths; unit tests alone are not sufficient.

## Commit, tag, and publish

1. Preserve unrelated dirty work. Stage only reviewed release files; do not use a broad cleanup, automatic stash, reset, rebase, amend, or force-push.
2. Fetch the remote before publication. If `origin/main` advanced, inspect and normally merge it, rerun validation, then push.
3. Commit the reviewed product changes and push `main`.
4. Create annotated component tags at the verified release commit:

```powershell
git tag -a cursor-bridge--v5.9.1 -m "Cursor Bridge 5.9.1"
git push origin refs/tags/cursor-bridge--v5.9.1
```

5. Publish one combined GitHub Release whose title always names both products and marks only changed components with `(New)`, for example:

```text
Cursor Bridge 5.9.1 (New) + Grok Build Supervisor 0.4.0
```

6. Configure npm Trusted Publishing once for each existing Pi package. Both packages use the same GitHub Actions trust coordinates, but npm stores the relationship per package:

```text
GitHub owner: Vanyangyang
Repository: cursor-bridge
Workflow filename: publish-pi.yml
Allowed action: npm publish
Environment: leave blank unless the workflow job is updated to use the exact same GitHub Environment
```

The trusted workflow is `.github/workflows/publish-pi.yml`. It uses a GitHub-hosted Windows runner with `permissions.id-token: write`, Node 24, and npm 12. The Windows checkout preserves the established tarball byte convention used by the existing Pi releases. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to its publish job. npm exchanges the GitHub OIDC identity only during `npm publish`; `npm whoami` is intentionally skipped by the publisher in GitHub Actions.

7. A newly pushed `cursor-bridge--v*` or `grok-build-supervisor--v*` tag automatically publishes only that component's corresponding Pi package. For an already-existing release tag, manually dispatch `Publish Pi packages` with that exact tag as the `ref`; the workflow rejects non-component-tag refs, uses the current trusted tooling, and packages source from the exact requested tag. The publisher preflights every selected package before any write, treats only a confirmed registry `E404` as unpublished, skips byte-identical versions, and stops on an immutable-version mismatch or uncertain registry response.

Local publication remains an interactive fallback and still verifies the expected npm account before publishing:

```powershell
pwsh -File .\scripts\publish-pi-packages.ps1

# Optional: publish or verify only one component
pwsh -File .\scripts\publish-pi-packages.ps1 -PackageName pi-cursor-bridge
```

The local fallback may require WebAuthn/2FA. Do not automate that proof-of-presence or store a long-lived bypass-2FA write token. If the same version exists with different content, bump the package version; npm releases are immutable.

8. Install the released artifacts from their real remote sources in fresh host tasks and rerun the bounded smoke paths. Confirm final Git status is clean and local/remote commit IDs agree.

## Installation surfaces to verify

Existing commands are part of the compatibility contract and must remain valid.

```powershell
# Codex marketplace, then either or both plugins
codex plugin marketplace add Vanyangyang/cursor-bridge --ref main
codex plugin add cursor-bridge@vanyangyang
codex plugin add grok-build-supervisor@vanyangyang

# Claude Code marketplace, then either or both plugins
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
claude plugin install grok-build-supervisor@vanyangyang

# Grok Build supports Cursor Bridge directly
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge

# Pi Packages remain independent
pi install npm:pi-cursor-bridge
pi install npm:pi-grok-build-supervisor
```

Start a new Codex task, reload/restart Claude Code, reload Grok plugins, or restart Pi after installation. Skills, prompt templates, commands, and MCP registrations do not hot-load into an existing task.
