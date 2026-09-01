import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCursorSessionId,
  normalizeCursorSessionMode,
  readCursorSessionRegistry,
  resolveCursorSessionRegistryFile,
  updateCursorSessionRegistry,
} from '../cursor-session-registry.mjs';

test('session registry uses user configuration storage instead of a plugin cache', () => {
  const file = resolveCursorSessionRegistryFile('', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' });
  assert.doesNotMatch(file.toLowerCase(), /plugins[\\/]cache/);
  assert.match(file.replace(/\\/g, '/'), /cursor-bridge\/sessions-v1\.json$/);
  assert.match(createCursorSessionId(), /^cursor-session-[0-9a-f-]{36}$/);
  assert.equal(normalizeCursorSessionMode('continue'), 'continue');
  assert.equal(normalizeCursorSessionMode('unknown'), '');
});

test('session registry updates atomically without retaining a cache or lock handle', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-session-registry-'));
  const file = join(directory, 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = updateCursorSessionRegistry(file, (state) => {
    state.sessions['cursor-session-test'] = { id: 'cursor-session-test', state: 'ready' };
    return 'written';
  }, { now: '2026-09-01T00:00:00.000Z' });

  assert.equal(result, 'written');
  assert.equal(readCursorSessionRegistry(file).sessions['cursor-session-test'].state, 'ready');
  assert.equal(existsSync(`${file}.lock`), false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).updatedAt, '2026-09-01T00:00:00.000Z');
});

test('an unsupported future schema fails closed and is not overwritten', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-session-schema-'));
  const file = join(directory, 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(file, JSON.stringify({ version: 99, sessions: { keep: true } }), 'utf8');

  assert.throws(
    () => updateCursorSessionRegistry(file, () => {}),
    /SESSION_SCHEMA_UNSUPPORTED/,
  );
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 99, sessions: { keep: true } });
  assert.equal(existsSync(`${file}.lock`), false);
});

test('session state survives replacement of an unrelated versioned plugin cache', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-session-update-'));
  const oldCache = join(directory, 'plugins', 'cache', 'cursor-bridge', '5.7.1');
  const newCache = join(directory, 'plugins', 'cache', 'cursor-bridge', '5.8.0');
  const file = join(directory, 'config', 'cursor-bridge', 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(oldCache, { recursive: true });
  writeFileSync(join(oldCache, 'plugin.json'), '{"version":"5.7.1"}\n', 'utf8');
  updateCursorSessionRegistry(file, (state) => {
    state.sessions['cursor-session-update'] = {
      id: 'cursor-session-update',
      state: 'ready',
      agentId: 'durable-agent',
      projectPath: 'C:\\workspace',
    };
  });
  // The registry closes its short-lived handles and contains no install path, so an updater may
  // replace an old cache independently of the persistent association.
  rmSync(oldCache, { recursive: true, force: true });
  mkdirSync(newCache, { recursive: true });
  writeFileSync(join(newCache, 'plugin.json'), '{"version":"5.8.0"}\n', 'utf8');

  const persisted = readCursorSessionRegistry(file).sessions['cursor-session-update'];
  assert.equal(persisted.state, 'ready');
  assert.equal(persisted.agentId, 'durable-agent');
  assert.equal(existsSync(oldCache), false);
  assert.equal(existsSync(newCache), true);
  assert.doesNotMatch(readFileSync(file, 'utf8').toLowerCase(), /plugins[\\/]cache/);
});
