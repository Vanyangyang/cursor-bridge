import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cursorWindowStatePath, readCursorStartupWindow, cursorStartupWindowArgs } from '../cursor-startup-window.mjs';

const read = saved => readCursorStartupWindow({ file: 'fixture', readFileSyncImpl: () => JSON.stringify(saved) });

test('last closed window type wins over other restored windows', () => {
  assert.deepEqual(read({ windowsState: {
    lastActiveWindow: { uiState: { glassMode: true } },
    openedWindows: [{ folder: 'file:///old-project', uiState: {} }],
  } }), { uiFlavor: 'agents_v2', source: 'cursor-last-active-window' });
  assert.deepEqual(read({ windowsState: {
    lastActiveWindow: { uiState: { mode: 1 } },
    openedWindows: [{ uiState: { glassMode: true } }],
  } }), { uiFlavor: 'legacy', source: 'cursor-last-active-window' });
});

test('missing, corrupt, or unreadable last-window state selects one Agents window', () => {
  for (const saved of [null, {}, { windowsState: {} }, { windowsState: { lastActiveWindow: { uiState: [] } } }]) {
    assert.deepEqual(read(saved), { uiFlavor: 'agents_v2', source: 'default-agents-window' });
  }
  for (const readFileSyncImpl of [() => '{invalid', () => { throw new Error('EACCES'); }]) {
    assert.equal(readCursorStartupWindow({ file: 'fixture', readFileSyncImpl }).source, 'default-agents-window');
  }
});

test('window-state lookup follows Cursor user-data roots', () => {
  const home = '/home/test';
  const file = (...parts) => join(...parts, 'User', 'globalStorage', 'storage.json');
  assert.equal(cursorWindowStatePath({ platform: 'win32', home, env: { APPDATA: '/roaming' } }), file('/roaming', 'Cursor'));
  assert.equal(cursorWindowStatePath({ platform: 'darwin', home, env: {} }), file(home, 'Library', 'Application Support', 'Cursor'));
  assert.equal(cursorWindowStatePath({ platform: 'linux', home, env: { XDG_CONFIG_HOME: '/config' } }), file('/config', 'Cursor'));
  assert.equal(cursorWindowStatePath({ home, env: { VSCODE_APPDATA: '/appdata' } }), file('/appdata', 'Cursor'));
  assert.equal(cursorWindowStatePath({ home, env: { VSCODE_PORTABLE: '/portable', VSCODE_APPDATA: '/ignored' } }), file('/portable', 'user-data'));
});

test('cold launch selects exactly one UI type and opens the IDE workspace in the same launch', () => {
  assert.deepEqual(cursorStartupWindowArgs({ uiFlavor: 'agents_v2' }, '/project'), ['--glass']);
  assert.deepEqual(cursorStartupWindowArgs({ uiFlavor: 'legacy' }, '/project'), ['--classic', '/project']);
  assert.deepEqual(cursorStartupWindowArgs({ uiFlavor: 'legacy' }, null), ['--classic', '--new-window']);
});
