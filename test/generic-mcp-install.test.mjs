import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GENERIC_MCP_HELP,
  buildGenericMcpConfig,
  parseGenericMcpArgs,
  renderGenericMcpConfig,
} from '../scripts/print-generic-mcp.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/print-generic-mcp.mjs', import.meta.url));

function readProjectFile(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

function runScript(args, extra = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: repositoryRoot,
    ...extra,
  });
}

test('generic MCP parser accepts documented flags and rejects unknown values', () => {
  const parsed = parseGenericMcpArgs(['--plugin', 'both', '--format', 'vscode', '--command', 'node.exe']);
  assert.equal(parsed.plugin, 'both');
  assert.equal(parsed.format, 'vscode');
  assert.equal(parsed.command, 'node.exe');
  assert.equal(parsed.help, false);
  assert.throws(() => parseGenericMcpArgs(['--plugin']), /requires a value/);
  assert.throws(() => parseGenericMcpArgs(['--plugin', 'pi']), /Unsupported --plugin/);
  assert.throws(() => parseGenericMcpArgs(['--format', 'opencode']), /Unsupported --format/);
  assert.throws(() => parseGenericMcpArgs(['--surprise']), /Unknown argument/);
});

test('generic MCP config uses committed bundles and the two common host shapes', () => {
  const cursor = buildGenericMcpConfig({
    root: repositoryRoot,
    plugin: 'cursor',
    format: 'mcpServers',
    command: 'node',
  });
  assert.deepEqual(Object.keys(cursor), ['mcpServers']);
  assert.deepEqual(cursor.mcpServers['cursor-bridge'], {
    command: 'node',
    args: [join(repositoryRoot, 'dist', 'cursor-bridge.mjs')],
  });

  const vscodeBoth = buildGenericMcpConfig({
    root: repositoryRoot,
    plugin: 'both',
    format: 'vscode',
    command: 'node',
  });
  assert.equal(vscodeBoth.servers['cursor-bridge'].type, 'stdio');
  assert.equal(vscodeBoth.servers['grok-build-supervisor'].type, 'stdio');
  assert.deepEqual(vscodeBoth.servers['grok-build-supervisor'].args, [
    join(repositoryRoot, 'plugins', 'grok-build-supervisor', 'dist', 'grok-build-supervisor.mjs'),
  ]);
  assert.match(renderGenericMcpConfig(cursor), /"mcpServers"/);
});

test('generic MCP config fails closed when a committed bundle is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'generic-mcp-missing-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cursor-bridge.mjs'), '// missing grok on purpose\n');
  assert.throws(
    () => buildGenericMcpConfig({
      root,
      plugin: 'both',
      format: 'mcpServers',
      command: 'node',
    }),
    /Missing committed bundle/,
  );
});

test('generic MCP CLI prints JSON or help and keeps a non-zero failure status', () => {
  const printed = runScript([]);
  assert.equal(printed.status, 0, printed.stderr);
  const config = JSON.parse(printed.stdout);
  assert.equal(config.mcpServers['cursor-bridge'].command, 'node');
  assert.equal(
    config.mcpServers['cursor-bridge'].args[0],
    join(repositoryRoot, 'dist', 'cursor-bridge.mjs'),
  );

  const help = runScript(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout, GENERIC_MCP_HELP);

  const failed = runScript(['--plugin', 'unknown']);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Unsupported --plugin/);
});

test('bilingual READMEs keep a first-class generic MCP install next to marketplace hosts', () => {
  const englishReadme = readProjectFile('README.md');
  const chineseReadme = readProjectFile('README.zh-CN.md');
  const englishGrok = readProjectFile('plugins/grok-build-supervisor/README.md');
  const chineseGrok = readProjectFile('plugins/grok-build-supervisor/README.zh-CN.md');

  assert.match(englishReadme, /<a id="other-mcp-hosts"><\/a>/);
  assert.match(chineseReadme, /<a id="other-mcp-hosts"><\/a>/);
  assert.match(englishReadme, /#### Other MCP hosts/);
  assert.match(chineseReadme, /#### 其他 MCP 宿主/);
  for (const content of [englishReadme, chineseReadme, englishGrok, chineseGrok]) {
    assert.match(content, /print-generic-mcp\.mjs/);
  }
  assert.match(englishReadme, /not a first-class host/);
  assert.match(englishReadme, /dist\/cursor-bridge\.mjs/);
  assert.match(chineseReadme, /不是一等宿主/);
  assert.match(chineseReadme, /dist\/cursor-bridge\.mjs/);
  assert.match(englishGrok, /--plugin grok/);
  assert.match(chineseGrok, /--plugin grok/);
});
