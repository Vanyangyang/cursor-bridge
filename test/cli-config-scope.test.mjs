import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliConfigScope } from '../cursor-cli-config.mjs';

test('private CLI profiles preserve native settings and permissions without modifying their source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cce-native-config-'));
  const settings = '{"model":{"modelId":"auto"},"permissions":{"deny":["Write(*)"]}}\n';
  const permissions = '{"terminalAllowlist":["rg"],"mcpAllowlist":[]}\n';
  let scope;
  try {
    await writeFile(join(directory, 'cli-config.json'), settings);
    await writeFile(join(directory, 'permissions.json'), permissions);
    await writeFile(join(directory, 'auth.json'), 'AUTH_MUST_NOT_BE_COPIED');
    scope = await createCliConfigScope({ CURSOR_CONFIG_DIR: directory, PRESERVED_ENV: 'yes' });
    assert.notEqual(scope.env.CURSOR_CONFIG_DIR, directory);
    assert.equal(scope.env.PRESERVED_ENV, 'yes');
    assert.deepEqual((await readdir(scope.directory)).sort(), ['cli-config.json', 'permissions.json']);
    assert.equal(await readFile(join(scope.directory, 'permissions.json'), 'utf8'), permissions);
    const privateSettings = JSON.parse(await readFile(join(scope.directory, 'cli-config.json'), 'utf8'));
    assert.equal(privateSettings.model.modelId, 'auto');
    assert.ok(privateSettings.permissions.deny.includes('Write(*)'));
    assert.ok(privateSettings.permissions.deny.includes('Mcp(*:cursor_context_engine)'));
    assert.ok(privateSettings.permissions.deny.includes('Mcp(*:cursor_init)'));
    assert.equal(privateSettings.permissions.deny.includes('Mcp(*:*)'), false);
    await writeFile(join(scope.directory, 'cli-config.json'), '{"model":{"modelId":"fixture-model"}}');
    assert.equal(await readFile(join(directory, 'cli-config.json'), 'utf8'), settings);
    assert.equal(await readFile(join(directory, 'permissions.json'), 'utf8'), permissions);
    await scope.cleanup(); await scope.cleanup();
    await assert.rejects(readFile(join(scope.directory, 'cli-config.json')), { code: 'ENOENT' });
  } finally { await scope?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('private CLI profiles default safely for absent settings and reject relative native directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cce-empty-native-config-'));
  let scope;
  try {
    scope = await createCliConfigScope({ CURSOR_CONFIG_DIR: directory });
    assert.deepEqual(await readdir(scope.directory), ['cli-config.json']);
    await assert.rejects(createCliConfigScope({ CURSOR_CONFIG_DIR: 'relative' }), error => error.code === 'CURSOR_CLI_CONFIG_INVALID' && error.confirmedNotSent);
  } finally { await scope?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
