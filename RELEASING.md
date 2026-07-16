# Releasing a New Version

This repository ships as both a **Claude Code plugin** and a **Codex marketplace plugin**.

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

## Release steps after source changes

```bash
# 1. Rebuild the dependency-free single-file runtime used by installed plugins.
npm install          # Install sdk/ws and esbuild (dev dependency).
npm run build        # Produce dist/cursor-bridge.mjs.

# 2. Keep all four version fields in sync.
#    - .claude-plugin/plugin.json        version
#    - .claude-plugin/marketplace.json   plugins[0].version
#    - .codex-plugin/plugin.json         version
#    - package.json                      version

# 3. Validate the plugin structure.
claude plugin validate .
python /path/to/plugin-creator/scripts/validate_plugin.py .

# 4. Commit and tag. Tag validation checks that plugin.json and the marketplace entry agree.
git add -A && git commit -m "release: vX.Y.Z"
claude plugin tag .        # Create the cursor-bridge--vX.Y.Z tag.
git push && git push --tags
```

## Important notes

- Commit `dist/cursor-bridge.mjs`. Plugin installation runs this file directly after cloning the repository; Claude Code and Codex do not automatically install runtime npm dependencies. The runtime dependencies must therefore be bundled.
- Do not commit `node_modules/` or `package-lock.json`; `.gitignore` excludes them because they are build-time inputs, not plugin runtime requirements.
- Always run `npm run build` after changing `server.mjs` or `launch-cursor.mjs`; otherwise `dist/` remains stale.
- Claude Code users can receive updates through `/reload-plugins`, a restart, or `claude plugin update cursor-bridge`.
- Codex users can run `codex plugin marketplace upgrade vanyangyang`, then start a new task or restart Codex.

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
