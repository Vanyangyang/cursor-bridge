import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCliWorkspace } from '../cursor-cli-workspace.mjs';

test('CLI workspace keeps directories exact and maps every JSONC workspace root', t => {
  const root = mkdtempSync(join(tmpdir(), 'cce-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, 'first'), second = join(root, 'second');
  mkdirSync(first); mkdirSync(second);
  assert.deepEqual(resolveCliWorkspace(first), { workspacePath: first, cwd: realpathSync(first), additionalRoots: [] });
  const file = join(root, 'multi.code-workspace');
  writeFileSync(file, `{
    // relative paths, file URIs and trailing commas are native workspace syntax
    "folders": [{"name":"primary","path":"first"},{"uri":${JSON.stringify(pathToFileURL(second).href)}},{"path":"first"},],
  }`);
  assert.deepEqual(resolveCliWorkspace(file), { workspacePath: file, cwd: realpathSync(first), additionalRoots: [realpathSync(second)] });
});

test('CLI workspace rejects invalid or remote roots instead of silently reducing the scope', t => {
  const root = mkdtempSync(join(tmpdir(), 'cce-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'multi.code-workspace');
  for (const content of [
    '{broken', '{"folders":[]}', '{"folders":[{"path":"missing"}]}',
    '{"folders":[{"uri":"vscode-remote://ssh-remote+host/repo"}]}',
    '{"folders":[{"path":"vscode-remote://host/repo"}]}',
    '{"folders":[{"path":".","uri":"file:///elsewhere"}]}',
    '{"folders":[{"path":"."},{"path":"missing"}]}',
  ]) {
    writeFileSync(file, content);
    assert.throws(() => resolveCliWorkspace(file), error => error.code === 'CURSOR_CLI_WORKSPACE_INVALID' && error.confirmedNotSent);
  }
  assert.throws(() => resolveCliWorkspace('relative/path'), /absolute workspace/);
});
