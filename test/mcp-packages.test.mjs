import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const buildScript = fileURLToPath(new URL('../scripts/build-mcp-packages.mjs', import.meta.url));

function readProjectFile(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

test('Pi package manifests stay Pi-only and are not generic MCP wrappers', () => {
  for (const name of ['pi-cursor-bridge', 'pi-grok-build-supervisor']) {
    const manifest = JSON.parse(readProjectFile(`pi-packages/${name}/package.json`));
    assert.equal(manifest.name, name);
    assert.ok(manifest.pi);
    assert.ok(manifest.piPackage);
    assert.equal(manifest.bin, undefined);
    assert.equal(manifest.main, undefined);
    assert.equal(manifest.mcpPackage, undefined);
  }
});

test('dedicated generic MCP package sources are independent of Pi wrappers', () => {
  const cursor = JSON.parse(readProjectFile('mcp-packages/vanyangyang-cursor-bridge/package.json'));
  const grok = JSON.parse(readProjectFile('mcp-packages/vanyangyang-grok-build-supervisor/package.json'));
  const playbook = readProjectFile('docs/ai-install.md');
  const chinese = readProjectFile('docs/ai-install.zh-CN.md');
  const manifest = JSON.parse(readProjectFile('docs/ai-install.manifest.json'));

  assert.equal(cursor.name, 'vanyangyang-cursor-bridge');
  assert.equal(cursor.version, '0.1.0');
  assert.equal(cursor.mcpPackage.embeddedProductVersion, '6.0.4');
  assert.deepEqual(cursor.bin, { 'cursor-bridge-mcp': 'bin/cursor-bridge-mcp.mjs' });
  assert.equal(cursor.pi, undefined);
  assert.equal(String(cursor.name).startsWith('pi-'), false);

  assert.equal(grok.name, 'vanyangyang-grok-build-supervisor');
  assert.equal(grok.version, '0.1.0');
  assert.equal(grok.mcpPackage.embeddedProductVersion, '0.4.3');
  assert.deepEqual(grok.bin, { 'grok-build-supervisor-mcp': './dist/grok-build-supervisor.mjs' });
  assert.equal(grok.pi, undefined);
  assert.equal(String(grok.name).startsWith('pi-'), false);

  assert.equal(manifest.products['cursor-bridge'].npm.package, cursor.name);
  assert.equal(manifest.products['cursor-bridge'].npm.version, cursor.version);
  assert.equal(manifest.products['grok-build-supervisor'].npm.package, grok.name);
  assert.equal(manifest.products['grok-build-supervisor'].npm.version, grok.version);

  for (const content of [playbook, chinese]) {
    assert.match(content, /vanyangyang-cursor-bridge/);
    assert.match(content, /vanyangyang-grok-build-supervisor/);
    assert.doesNotMatch(content, /pi install npm:pi-cursor-bridge/);
  }

  const rootPackage = JSON.parse(readProjectFile('package.json'));
  assert.match(rootPackage.scripts['build:mcp-packages'], /build-mcp-packages\.mjs/);
  assert.match(readProjectFile('.gitignore'), /^\.mcp-package-stage\/$/m);
});

test('generic MCP package staging embeds committed bundles and skills without Pi metadata', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'cursor-bridge-mcp-packages-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const built = spawnSync(process.execPath, [buildScript, '--out', output], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const cursor = JSON.parse(readFileSync(join(output, 'vanyangyang-cursor-bridge', 'package.json'), 'utf8'));
  const grok = JSON.parse(readFileSync(join(output, 'vanyangyang-grok-build-supervisor', 'package.json'), 'utf8'));
  assert.equal(cursor.name, 'vanyangyang-cursor-bridge');
  assert.equal(cursor.version, '0.1.0');
  assert.equal(cursor.mcpPackage.embeddedProductVersion, '6.0.4');
  assert.deepEqual(cursor.bin, { 'cursor-bridge-mcp': 'bin/cursor-bridge-mcp.mjs' });
  assert.equal(cursor.pi, undefined);
  assert.equal(grok.name, 'vanyangyang-grok-build-supervisor');
  assert.equal(grok.version, '0.1.0');
  assert.equal(grok.mcpPackage.embeddedProductVersion, '0.4.3');
  assert.deepEqual(grok.bin, { 'grok-build-supervisor-mcp': './dist/grok-build-supervisor.mjs' });
  assert.equal(grok.pi, undefined);

  const cursorBundle = readFileSync(join(output, 'vanyangyang-cursor-bridge', 'dist', 'cursor-bridge.mjs'), 'utf8');
  assert.match(cursorBundle, /cursor_context_engine/);
  assert.match(cursorBundle, /cursor_model/);
  const cursorBin = readFileSync(join(output, 'vanyangyang-cursor-bridge', 'bin', 'cursor-bridge-mcp.mjs'), 'utf8');
  assert.match(cursorBin, /^#!\/usr\/bin\/env node/);
  assert.match(cursorBin, /import "\.\.\/dist\/cursor-bridge\.mjs"/);
  assert.equal(
    existsSync(join(output, 'vanyangyang-cursor-bridge', 'dist', 'cursor-lifecycle-supervisor.mjs')),
    true,
  );
  assert.equal(
    existsSync(join(output, 'vanyangyang-cursor-bridge', 'skills', 'cce-routing', 'SKILL.md')),
    true,
  );
  assert.equal(
    existsSync(join(output, 'vanyangyang-cursor-bridge', 'skills', 'cursor-delegate', 'references', 'delegation-contract.md')),
    true,
  );
  assert.equal(existsSync(join(output, 'vanyangyang-cursor-bridge', 'LICENSE')), true);
  assert.equal(existsSync(join(output, 'vanyangyang-cursor-bridge', 'extensions')), false);

  const grokBundle = readFileSync(join(output, 'vanyangyang-grok-build-supervisor', 'dist', 'grok-build-supervisor.mjs'), 'utf8');
  assert.match(grokBundle, /grok_session_inspect/);
  assert.match(grokBundle, /version: "0\.4\.3"/);
  assert.equal(
    existsSync(join(output, 'vanyangyang-grok-build-supervisor', 'skills', 'grok-build-supervisor', 'SKILL.md')),
    true,
  );
  for (const skill of ['grok-executor-on', 'grok-executor-off']) {
    assert.equal(
      existsSync(join(output, 'vanyangyang-grok-build-supervisor', 'skills', skill, 'SKILL.md')),
      true,
    );
  }
  assert.match(
    readFileSync(join(output, 'vanyangyang-grok-build-supervisor', 'prompts', 'grok_execute.md'), 'utf8'),
    /\$ARGUMENTS/,
  );
  assert.equal(existsSync(join(output, 'vanyangyang-grok-build-supervisor', 'scripts', 'Start-GrokTui.ps1')), true);
  assert.equal(existsSync(join(output, 'vanyangyang-grok-build-supervisor', 'extensions')), false);

  const cursorReadme = readFileSync(join(output, 'vanyangyang-cursor-bridge', 'README.md'), 'utf8');
  const grokReadme = readFileSync(join(output, 'vanyangyang-grok-build-supervisor', 'README.md'), 'utf8');
  assert.match(cursor.description, /Windows only/i);
  assert.match(cursorReadme, /Windows only/i);
  assert.match(cursorReadme, /vanyangyang-cursor-bridge@0\.1\.0/);
  assert.match(cursorReadme, /cursor-bridge-mcp/);
  assert.doesNotMatch(cursorReadme, /pi install npm:pi-cursor-bridge/);
  assert.match(grok.description, /Windows only/i);
  assert.match(grokReadme, /Windows only/i);
  assert.match(grokReadme, /vanyangyang-grok-build-supervisor@0\.1\.0/);

  const buildSource = readProjectFile('scripts/build-mcp-packages.mjs');
  assert.match(buildSource, /Generic MCP package must not be a Pi wrapper/);
  assert.doesNotMatch(buildSource, /pi-packages/);
});
