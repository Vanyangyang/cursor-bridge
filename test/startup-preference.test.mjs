import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { cursorWindowStatePath, readCursorStartupPreference, readCursorStartupWindow } from '../cursor-startup-window.mjs';

const mainKey = 'cursor/userWindowRestorationPreference';
const legacyKey = 'cursor/userOpenAgentsWindowOnStartupPreference';
const rows = (main, legacy) => [
  ...(main === undefined ? [] : [{ key: mainKey, value: main }]),
  ...(legacy === undefined ? [] : [{ key: legacyKey, value: legacy }]),
];

function databaseFixture(values, { failure, closeFailure = false } = {}) {
  const calls = [];
  class DatabaseSync {
    constructor(file, options) {
      calls.push(['open', file, options]);
      if (failure === 'open') throw new Error('missing or invalid database');
    }
    prepare(sql) {
      calls.push(['prepare', sql]);
      if (failure === 'prepare') throw new Error('database is malformed');
      return { all: (...keys) => {
        calls.push(['all', ...keys]);
        if (failure === 'all') throw new Error('database is locked');
        return values;
      } };
    }
    close() {
      calls.push(['close']);
      if (closeFailure) throw new Error('close failed');
    }
  }
  return { calls, requireImpl: name => {
    assert.equal(name, 'node:sqlite');
    if (failure === 'require') throw new Error('No such built-in module: node:sqlite');
    return { DatabaseSync };
  } };
}

function windowOptions(database, { native = { uiState: { glassMode: false } }, observed } = {}) {
  const file = resolve('fixture-profile', 'User', 'globalStorage', 'storage.json');
  const bridgeFile = resolve('fixture-bridge', 'last-window.json');
  return {
    file, bridgeFile, requireImpl: database.requireImpl,
    readFileSyncImpl: requested => {
      if (requested === file) return JSON.stringify({ windowsState: { lastActiveWindow: native } });
      assert.equal(requested, bridgeFile);
      if (!observed) throw new Error('no bridge observation');
      return JSON.stringify({ version: 1, uiFlavor: observed, cursorStatePath: file,
        nativeSignature: createHash('sha256').update(JSON.stringify(native)).digest('hex') });
    },
  };
}

test('startup preference uses a read-only database and only the two approved keys, then closes', () => {
  const db = databaseFixture(rows('"agentWindow"', 'false'));
  const options = windowOptions(db);
  assert.equal(readCursorStartupPreference(options), 'agentWindow');
  assert.deepEqual(db.calls, [
    ['open', join(dirname(options.file), 'state.vscdb'), { readOnly: true }],
    ['prepare', 'SELECT key, value FROM ItemTable WHERE key IN (?, ?)'],
    ['all', mainKey, legacyKey],
    ['close'],
  ]);
});

test('startup preference database follows the same portable, profile and platform root as storage.json', () => {
  for (const location of [
    { platform: 'win32', env: { APPDATA: '/roaming' } },
    { platform: 'darwin', home: '/home/test', env: {} },
    { platform: 'linux', env: { XDG_CONFIG_HOME: '/config' } },
    { env: { VSCODE_PORTABLE: '/portable', VSCODE_APPDATA: '/ignored' } },
    { env: { VSCODE_APPDATA: '/custom' } },
  ]) {
    const db = databaseFixture([]);
    readCursorStartupPreference({ ...location, requireImpl: db.requireImpl });
    assert.equal(db.calls[0][1], join(dirname(cursorWindowStatePath(location)), 'state.vscdb'));
  }
});

test('valid primary startup preference wins over the legacy boolean', () => {
  for (const [main, legacy, expected] of [
    ['agentWindow', 'false', 'agentWindow'],
    ['"agentWindow"', 'false', 'agentWindow'],
    ['lastUsedWindows', 'true', 'lastUsedWindows'],
    ['default', 'true', 'default'],
  ]) {
    const db = databaseFixture(rows(main, legacy));
    assert.equal(readCursorStartupPreference(windowOptions(db)), expected);
    assert.deepEqual(db.calls.at(-1), ['close']);
  }
});

test('absent or invalid primary preference uses Cursor legacy boolean and enum mappings', () => {
  for (const [main, legacy, expected] of [
    [undefined, 'true', 'agentWindow'],
    ['unsupported', 'true', 'agentWindow'],
    ['{"bad":true}', 'false', 'lastUsedWindows'],
    ['null', 'true', 'agentWindow'],
    [undefined, 'agentWindow', 'agentWindow'],
    [undefined, 'lastUsedWindows', 'lastUsedWindows'],
    [undefined, 'default', 'default'],
    [undefined, undefined, 'default'],
    ['unsupported', 'yes', 'default'],
    ['unsupported', '"true"', 'agentWindow'],
    ['unsupported', '"false"', 'lastUsedWindows'],
  ]) {
    const db = databaseFixture(rows(main, legacy));
    assert.equal(readCursorStartupPreference(windowOptions(db)), expected);
  }
});

test('explicit Agents preference overrides native and supervised legacy observations', () => {
  for (const values of [rows('agentWindow', 'false'), rows(undefined, 'true')]) {
    const db = databaseFixture(values);
    const options = windowOptions(db, { observed: 'legacy' });
    options.readFileSyncImpl = () => assert.fail('explicit Agents preference must win before reading last-window state');
    assert.deepEqual(readCursorStartupWindow(options), { uiFlavor: 'agents_v2', source: 'cursor-startup-preference' });
  }
});

test('lastUsedWindows and default preserve native and supervised legacy recovery', () => {
  for (const main of ['lastUsedWindows', 'default']) {
    for (const observed of [undefined, 'legacy']) {
      const db = databaseFixture(rows(main, 'true'));
      assert.deepEqual(readCursorStartupWindow(windowOptions(db, { observed })), {
        uiFlavor: 'legacy', source: observed ? 'bridge-last-closed-window' : 'cursor-last-active-window',
      });
    }
  }
});

test('unavailable SQLite, missing, malformed or locked database safely retain last-window behavior', () => {
  for (const failure of ['require', 'open', 'prepare', 'all']) {
    const db = databaseFixture([], { failure });
    assert.deepEqual(readCursorStartupWindow(windowOptions(db)), { uiFlavor: 'legacy', source: 'cursor-last-active-window' });
    assert.equal(db.calls.filter(([name]) => name === 'close').length, ['prepare', 'all'].includes(failure) ? 1 : 0);
  }
  const db = databaseFixture(rows('agentWindow'), { closeFailure: true });
  assert.equal(readCursorStartupPreference(windowOptions(db)), 'agentWindow');
  assert.deepEqual(db.calls.at(-1), ['close']);
});

test('an injected preference reader receives the profile options and cannot prevent fallback', () => {
  const options = windowOptions(databaseFixture([]));
  options.readStartupPreferenceImpl = received => {
    assert.equal(received, options);
    throw new Error('optional reader unavailable');
  };
  assert.deepEqual(readCursorStartupWindow(options), { uiFlavor: 'legacy', source: 'cursor-last-active-window' });
});
