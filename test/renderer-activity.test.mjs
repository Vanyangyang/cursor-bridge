import test from 'node:test';
import assert from 'node:assert/strict';
import { activateCursorRenderer } from '../server.mjs';

test('renderer activation enables focus emulation and releases it once with a bounded restore', async () => {
  const calls = [];
  const client = { send: async (...args) => { calls.push(args); return {}; } };
  const release = await activateCursorRenderer(client);
  assert.equal(typeof release, 'function');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'Emulation.setFocusEmulationEnabled');
  assert.deepEqual(calls[0][1], { enabled: true });
  await Promise.all([release(), release()]);
  await release();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['Emulation.setFocusEmulationEnabled', { enabled: false }, { timeoutMs: 1000 }]);
});

test('only unsupported-method errors permit a noop renderer activation', async () => {
  let calls = 0;
  const unsupported = Object.assign(new Error('Method not found'), { code: -32601 });
  const release = await activateCursorRenderer({ send: async () => { calls++; throw unsupported; } });
  await release();
  await release();
  assert.equal(calls, 1);
});

test('renderer activation preserves other protocol and transport exceptions', async () => {
  for (const code of ['ECONNRESET', 'CDP_COMMAND_TIMEOUT', -32000, -32602]) {
    const failure = Object.assign(new Error(`activation failure ${code}`), { code });
    let calls = 0;
    await assert.rejects(activateCursorRenderer({ send: async () => { calls++; throw failure; } }), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('restore failure is swallowed and cannot replace the primary operation error', async () => {
  const calls = [];
  const client = { send: async (...args) => {
    calls.push(args);
    if (args[1].enabled === false) throw Object.assign(new Error('renderer already closed'), { code: 'ECONNRESET' });
    return {};
  } };
  const release = await activateCursorRenderer(client);
  const primary = new Error('primary operation failed');
  await assert.rejects((async () => {
    try { throw primary; }
    finally { await release(); }
  })(), error => error === primary);
  await release();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['Emulation.setFocusEmulationEnabled', { enabled: false }, { timeoutMs: 1000 }]);
});
