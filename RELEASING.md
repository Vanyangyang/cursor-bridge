# Releasing a New Version

This repository ships as a **Claude Code plugin**, a **Codex marketplace plugin**, and a **Grok Build plugin**.

Claude Code users install it with:

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

Claude Code background updates can then fetch new versions. The marketplace source uses `owner/repo`, not `github:owner/repo`; the current CLI rejects the latter form.

Codex users install the marketplace with:

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

Grok Build users install with:

```bash
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge
```

Reload Grok with `/plugins` then `r`, or start a new session.

## Release steps after source changes

```bash
# 1. Rebuild the dependency-free single-file runtime used by installed plugins.
npm install          # Install sdk/ws and esbuild (dev dependency).
npm run build        # Produce dist/cursor-bridge.mjs.

# 2. Keep all release version fields in sync.
#    - .claude-plugin/plugin.json        version
#    - .claude-plugin/marketplace.json   plugins[0].version
#    - .codex-plugin/plugin.json         version
#    - package.json                      version
#    - server.mjs                        MCP Server version

# 3. Validate the plugin structure.
claude plugin validate .
python /path/to/plugin-creator/scripts/validate_plugin.py .

# 4. Commit and tag. Tag validation checks that plugin.json and the marketplace entry agree.
git add -A && git commit -m "release: vX.Y.Z"
claude plugin tag .        # Create the cursor-bridge--vX.Y.Z tag.
git push && git push --tags

# 5. Publish a GitHub Release from the verified tag and release notes.
gh release create cursor-bridge--vX.Y.Z \
  --title "Cursor Bridge vX.Y.Z" \
  --notes-file /path/to/release-notes.md \
  --verify-tag
```

## Important notes

- Commit `dist/cursor-bridge.mjs`. Plugin installation runs this file directly after cloning the repository; Claude Code and Codex do not automatically install runtime npm dependencies. The runtime dependencies must therefore be bundled.
- Do not commit `node_modules/` or `package-lock.json`; `.gitignore` excludes them because they are build-time inputs, not plugin runtime requirements.
- Keep per-version GitHub release-note drafts outside the repository checkout (for example, in a temporary directory). Published history belongs in `CHANGELOG.md` and GitHub Releases, not in root-level `release-notes-v*.md` files.
- Always run `npm run build` after changing `server.mjs` or `launch-cursor.mjs`; otherwise `dist/` remains stale.
- Claude Code users can receive updates through `/reload-plugins`, a restart, or `claude plugin update cursor-bridge`.
- Codex users can run `codex plugin marketplace upgrade vanyangyang`, then start a new task or restart Codex.
- Grok Build users can run `grok plugin update cursor-bridge`, then open `/plugins` and press `r` or start a new session.

## Local validation without changing production configuration

```bash
claude plugin marketplace add /abs/path/to/this/repo
claude plugin install cursor-bridge@vanyangyang
codex plugin marketplace add /abs/path/to/this/repo

# Clean up after validation.
claude plugin uninstall cursor-bridge
claude plugin marketplace remove vanyangyang
codex plugin marketplace remove vanyangyang
```
