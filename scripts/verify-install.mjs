#!/usr/bin/env node
// Verify build completeness, manifest/version alignment, lifecycle runtime materialization,
// and staged npm / Pi package smoke integrity without modifying global user config.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeLifecycleSupervisorRuntime } from '../cursor-lifecycle-client.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8'));
}

function assertNonEmptyFile(path, label) {
  assert.ok(existsSync(path), `${label} is missing: ${path}`);
  assert.ok(statSync(path).size > 0, `${label} must not be empty: ${path}`);
}

function runNodeScript(scriptRelativePath, args = []) {
  return execFileSync(process.execPath, [join(repositoryRoot, scriptRelativePath), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function verifyInstall() {
  const pkg = readJson('package.json');
  const rootVersion = pkg.version;
  assert.ok(rootVersion, 'Root package.json must declare a version');

  // 1. All 5 built bundles exist and are non-empty.
  const builtBundles = [
    'dist/cursor-bridge.mjs',
    'dist/cursor-cli-provider-preload.mjs',
    'dist/cursor-lifecycle-supervisor.mjs',
    'plugins/grok-build-supervisor/dist/grok-build-supervisor.mjs',
    'plugins/grok-build-supervisor/dist/supervisor-daemon.mjs',
  ];
  for (const rel of builtBundles) {
    assertNonEmptyFile(join(repositoryRoot, rel), `Built bundle ${rel}`);
  }

  // 2. Manifest and package version alignment.
  const claudePlugin = readJson('.claude-plugin/plugin.json');
  assert.equal(claudePlugin.version, rootVersion, '.claude-plugin/plugin.json version mismatch');

  const marketplace = readJson('.claude-plugin/marketplace.json');
  const marketEntry = marketplace.plugins?.find((item) => item.name === 'cursor-bridge');
  assert.ok(marketEntry, '.claude-plugin/marketplace.json must include cursor-bridge');
  assert.equal(marketEntry.version, rootVersion, '.claude-plugin/marketplace.json cursor-bridge version mismatch');

  const codexPlugin = readJson('.codex-plugin/plugin.json');
  assert.equal(codexPlugin.version, rootVersion, '.codex-plugin/plugin.json version mismatch');

  const rootMcp = readJson('.mcp.json');
  const mcpServer = rootMcp.mcpServers?.['cursor-bridge'];
  assert.ok(mcpServer, '.mcp.json must define cursor-bridge');
  const rawMcpEntry = String(mcpServer.args[0] || '').replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, '');
  assertNonEmptyFile(resolve(repositoryRoot, rawMcpEntry), '.mcp.json cursor-bridge entrypoint');

  const piPkg = readJson('pi-packages/pi-cursor-bridge/package.json');
  assert.equal(piPkg.piPackage?.embeddedProductVersion, rootVersion, 'pi-cursor-bridge embeddedProductVersion mismatch');
  const piExtension = readFileSync(join(repositoryRoot, 'pi-packages/pi-cursor-bridge/extensions/index.ts'), 'utf8');
  assert.ok(piExtension.includes(`packageVersion: "${rootVersion === pkg.version ? piPkg.version : ''}"`), 'pi-cursor-bridge extensions/index.ts packageVersion mismatch');

  const mcpPkg = readJson('mcp-packages/vanyangyang-cursor-bridge/package.json');
  assert.equal(mcpPkg.mcpPackage?.embeddedProductVersion, rootVersion, 'vanyangyang-cursor-bridge embeddedProductVersion mismatch');
  const aiManifest = readJson('docs/ai-install.manifest.json');
  assert.equal(aiManifest.products?.['cursor-bridge']?.npm?.version, mcpPkg.version, 'docs/ai-install.manifest.json npm version mismatch');

  const scratch = mkdtempSync(join(tmpdir(), 'cursor-bridge-verify-install-'));
  try {
    // 3. Lifecycle supervisor runtime materialization into an isolated directory.
    const lifecycleDir = join(scratch, 'lifecycle');
    const materialized = materializeLifecycleSupervisorRuntime({
      sourceScript: join(repositoryRoot, 'dist', 'cursor-lifecycle-supervisor.mjs'),
      dir: lifecycleDir,
    });
    assertNonEmptyFile(materialized.script, 'Materialized lifecycle supervisor runtime');
    assert.ok(materialized.fingerprint && materialized.fingerprint.length === 64, 'Lifecycle runtime SHA-256 fingerprint expected');

    // 4. Stage both generic npm and Pi distributions and verify completeness.
    const mcpStage = join(scratch, 'mcp-stage');
    const piStage = join(scratch, 'pi-stage');
    runNodeScript('scripts/build-mcp-packages.mjs', ['--out', mcpStage]);
    runNodeScript('scripts/build-pi-packages.mjs', ['--out', piStage]);

    const stagedMcpRoot = join(mcpStage, 'vanyangyang-cursor-bridge');
    const stagedPiRoot = join(piStage, 'pi-cursor-bridge');
    for (const root of [stagedMcpRoot, stagedPiRoot]) {
      for (const rel of [
        'dist/cursor-bridge.mjs',
        'dist/cursor-cli-provider-preload.mjs',
        'dist/cursor-lifecycle-supervisor.mjs',
        'skills/cce-routing/SKILL.md',
        'skills/cursor-delegate/SKILL.md',
        'skills/cce/SKILL.md',
        'prompts/cce.md',
        'LICENSE',
      ]) {
        assertNonEmptyFile(join(root, rel), `Staged asset ${rel}`);
      }
    }
    assertNonEmptyFile(join(stagedPiRoot, 'extensions/index.ts'), 'Staged Pi extension index.ts');
    assertNonEmptyFile(join(stagedPiRoot, 'extensions/mcp-stdio.ts'), 'Staged Pi extension mcp-stdio.ts');
    assertNonEmptyFile(join(stagedPiRoot, '.codex-plugin/plugin.json'), 'Staged Pi .codex-plugin/plugin.json');
    assertNonEmptyFile(join(mcpStage, 'vanyangyang-grok-build-supervisor/dist/grok-build-supervisor.mjs'), 'Staged generic grok bundle');
    assertNonEmptyFile(join(piStage, 'pi-grok-build-supervisor/dist/grok-build-supervisor.mjs'), 'Staged Pi grok bundle');

    // 5. Run real stdio MCP smoke checks directly against staged MCP and Pi bundles.
    const stagedMcpBundle = join(stagedMcpRoot, 'dist', 'cursor-bridge.mjs');
    const stagedPiBundle = join(stagedPiRoot, 'dist', 'cursor-bridge.mjs');
    const mcpSmoke = JSON.parse(runNodeScript('test/smoke-mcp.mjs', [stagedMcpBundle, rootVersion]));
    assert.equal(mcpSmoke.result, 'PASS');
    const piSmoke = JSON.parse(runNodeScript('test/smoke-mcp.mjs', [stagedPiBundle, rootVersion]));
    assert.equal(piSmoke.result, 'PASS');
    const cliSmoke = JSON.parse(runNodeScript('test/smoke-cli-mcp.mjs', [stagedMcpBundle, rootVersion]));
    assert.equal(cliSmoke.result, 'PASS');

    return {
      result: 'PASS',
      version: rootVersion,
      mcpWrapperVersion: mcpPkg.version,
      piWrapperVersion: piPkg.version,
      builtBundlesVerified: builtBundles.length,
      lifecycleMaterialized: true,
      stagedBundlesVerified: 2,
      smokeChecksPassed: 3,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 15, retryDelay: 120 });
  }
}

try {
  process.stdout.write(`${JSON.stringify(verifyInstall())}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ result: 'FAIL', error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
