import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWindowCloseObserver } from '../cursor-window-tracker.mjs';
import { readCursorStartupWindow, recordCursorClosedWindow } from '../cursor-startup-window.mjs';

const page = (id, title) => ({ targetId: id, title, type: 'page', url: 'vscode-file://vscode-app/workbench.html' });

test('the last destroyed top-level Cursor target determines the type, in either close order', () => {
  for (const [first, last, expected] of [['a', 'i', 'legacy'], ['i', 'a', 'agents_v2']]) {
    const recorded = [];
    const observer = createWindowCloseObserver(flavor => recorded.push(flavor));
    observer.update(page('a', 'Cursor Agents'));
    observer.update(page('i', 'project - Cursor'));
    observer.update({ targetId: 'web', title: 'Browser', type: 'page', url: 'https://example.com' });
    observer.destroyed(first);
    assert.deepEqual(recorded, []);
    observer.destroyed(last);
    observer.disconnected();
    assert.deepEqual(recorded, [expected]);
  }
});

test('browser disconnect uses a single known window and never guesses between two remaining types', () => {
  const recorded = [];
  const observer = createWindowCloseObserver(flavor => recorded.push(flavor));
  observer.update(page('a', 'Cursor Agents'));
  observer.update(page('i', 'project - Cursor'));
  observer.disconnected();
  assert.deepEqual(recorded, []);
  observer.destroyed('a');
  observer.disconnected();
  assert.deepEqual(recorded, ['legacy']);
});

test('new targets after a reload replace the prior close observation', () => {
  const recorded = [];
  const observer = createWindowCloseObserver(flavor => recorded.push(flavor));
  observer.update(page('a', 'Cursor Agents'));
  observer.destroyed('a');
  observer.update(page('i', 'project - Cursor'));
  observer.destroyed('i');
  assert.deepEqual(recorded, ['agents_v2', 'legacy']);
});

test('Bridge close evidence survives failed Cursor saves without changing Cursor data', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-window-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { file: join(dir, 'cursor-storage.json'), bridgeFile: join(dir, 'bridge', 'last-window.json') };
  const native = JSON.stringify({ windowsState: { lastActiveWindow: { uiState: { glassMode: true } } } });
  writeFileSync(options.file, native);
  recordCursorClosedWindow('legacy', options);
  assert.equal(readFileSync(options.file, 'utf8'), native);
  assert.deepEqual(readCursorStartupWindow(options), { uiFlavor: 'legacy', source: 'bridge-last-closed-window' });
  // A subsequent successful native save (e.g. external Cursor use) supersedes it.
  writeFileSync(options.file, JSON.stringify({ windowsState: { lastActiveWindow: { backupPath: 'new', uiState: { glassMode: true } } } }));
  assert.deepEqual(readCursorStartupWindow(options), { uiFlavor: 'agents_v2', source: 'cursor-last-active-window' });
  assert.equal(readCursorStartupWindow({ ...options, file: join(dir, 'other-profile.json') }).source, 'default-agents-window');
});
