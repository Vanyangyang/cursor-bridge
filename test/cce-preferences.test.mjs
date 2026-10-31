import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CURSOR_CCE_SOURCES, normalizeCceSource, resolveCceSourceFile,
  readCcePreferences, writeCcePreferences, updateCcePreferences,
} from '../cursor-cce-preferences.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cce-preferences-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'cce-source.json') };
}

test('sources are strict and the path follows the model preferences configuration root', () => {
  assert.deepEqual(CURSOR_CCE_SOURCES, ['ide', 'cli']);
  assert.equal(Object.isFrozen(CURSOR_CCE_SOURCES), true);
  assert.equal(normalizeCceSource(' CLI '), 'cli');
  assert.equal(normalizeCceSource(' IDE '), 'ide');
  for (const source of ['auto', 'ui', '', null, 1, {}, ['cli']]) {
    assert.equal(normalizeCceSource(source), '');
    assert.equal(normalizeCceSource(source, 'fallback'), 'fallback');
  }
  assert.equal(resolveCceSourceFile(' isolated.json '), resolve('isolated.json'));
  assert.match(resolveCceSourceFile(''), /cursor-bridge[/\\]cce-source\.json$/);
});

test('missing or disabled storage defaults to ide and show never writes', (t) => {
  const { directory, file } = fixture(t);
  const expected = { version: 1, source: 'ide', updatedAt: null };
  for (const path of [file, null, undefined, '']) assert.deepEqual(readCcePreferences(path), expected);
  assert.deepEqual(updateCcePreferences(file), expected);
  assert.deepEqual(updateCcePreferences(file, { action: 'show', source: 'cli' }), expected);
  assert.deepEqual(readdirSync(directory), []);
  assert.throws(() => writeCcePreferences(null, { source: 'cli' }), /disabled/);
  assert.throws(() => updateCcePreferences(null, { action: 'set', source: 'cli' }), /disabled/);
  assert.deepEqual(readdirSync(directory), []);
});

test('explicit source persists across independent Node processes and can switch back', (t) => {
  const { directory, file } = fixture(t);
  const first = updateCcePreferences(file, { action: 'set', source: ' CLI ' });
  assert.equal(first.source, 'cli');
  assert.equal(Number.isNaN(Date.parse(first.updatedAt)), false);
  const moduleUrl = new URL('../cursor-cce-preferences.mjs', import.meta.url).href;
  const script = `import { readCcePreferences } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(readCcePreferences(process.argv[1])));`;
  const fresh = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf8' }));
  assert.deepEqual(fresh, first);
  assert.equal(updateCcePreferences(file, { action: 'set', source: 'ide' }).source, 'ide');
  assert.equal(readCcePreferences(file).source, 'ide');
  assert.deepEqual(readdirSync(directory), ['cce-source.json']);
});

test('corrupt, invalid and future configurations fail closed; explicit set repairs them', (t) => {
  const { file } = fixture(t);
  const invalid = ['{', 'null', '[]', '{}',
    JSON.stringify({ version: 2, source: 'cli' }),
    JSON.stringify({ version: '1', source: 'cli' }),
    JSON.stringify({ version: 1, source: 'auto' }),
    JSON.stringify({ version: 1, source: ['ide'] }),
    JSON.stringify({ version: 1, source: 'cli', updatedAt: {} })];
  for (const content of invalid) {
    writeFileSync(file, content);
    assert.throws(() => readCcePreferences(file), { code: 'CURSOR_CCE_SOURCE_CONFIG_INVALID' });
    assert.throws(() => updateCcePreferences(file, { action: 'show' }), { code: 'CURSOR_CCE_SOURCE_CONFIG_INVALID' });
    assert.equal(readFileSync(file, 'utf8'), content);
    assert.equal(updateCcePreferences(file, { action: 'set', source: 'cli' }).source, 'cli');
    assert.equal(readCcePreferences(file).source, 'cli');
  }
});

test('invalid writes and unsupported actions preserve the existing selection', (t) => {
  const { directory, file } = fixture(t);
  writeCcePreferences(file, { source: 'cli' });
  const before = readFileSync(file, 'utf8');
  for (const source of ['auto', 'ui', '', null, ['ide']]) {
    assert.throws(() => updateCcePreferences(file, { action: 'set', source }), { code: 'CURSOR_CCE_SOURCE_CONFIG_INVALID' });
  }
  for (const action of ['', null, 'reset', 'toggle']) assert.throws(() => updateCcePreferences(file, { action, source: 'ide' }), /unsupported/);
  assert.throws(() => updateCcePreferences(file, { action: 'set' }), { code: 'CURSOR_CCE_SOURCE_CONFIG_INVALID' });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(directory), ['cce-source.json']);
});

test('failed atomic replacement cleans its temporary file without removing the target', (t) => {
  const { directory, file } = fixture(t);
  mkdirSync(file);
  writeFileSync(join(file, 'sentinel'), 'preserve');
  assert.throws(() => writeCcePreferences(file, { source: 'cli' }));
  assert.equal(readFileSync(join(file, 'sentinel'), 'utf8'), 'preserve');
  assert.deepEqual(readdirSync(directory), ['cce-source.json']);
  assert.throws(() => readCcePreferences(file), { code: 'CURSOR_CCE_SOURCE_CONFIG_INVALID' });
});
