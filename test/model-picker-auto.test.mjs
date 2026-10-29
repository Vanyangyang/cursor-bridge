import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorBridge } from '../server.mjs';

const owner = { triggerId: 'trigger-a', composerId: 'composer-a', agentId: 'agent-a' };
const auto = (overrides = {}) => ({ kind: 'auto_control', text: 'Auto', menuId: 'menu-a', selected: true, autoMode: true, disabled: false, pointerEvents: 'auto', x: 20, y: 30, ...overrides });
const model = { kind: 'model', text: 'Grok 4.7', modelId: 'grok-4.7', x: 50, y: 60 };
const snapshot = (rows, identity = owner) => ({ open: true, owner: identity, rows });

function harness(sequence = []) {
  const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
  const clicks = [], reads = [];
  bridge._clickModelPickerPoint = async (_client, row) => { clicks.push(row); };
  bridge._openModelPickerControl = async (_client, current) => current;
  bridge._readModelPickerRows = async (_client, options) => {
    reads.push(options);
    return sequence.length > 1 ? sequence.shift() : sequence[0] || snapshot([]);
  };
  return { bridge, clicks, reads };
}

test('a unique selected Auto control is clicked once and named models wait for confirmed off', async () => {
  const active = auto();
  const pending = snapshot([active, model]);
  const off = snapshot([auto({ selected: false, autoMode: false }), model]);
  const { bridge, clicks, reads } = harness([pending, off]);
  const result = await bridge._findModelPickerModel(null, snapshot([active, model]), 'grok-4.7');
  assert.equal(result.modelRow, model);
  assert.equal(result.snapshot, off);
  assert.ok(reads.length >= 2);
  assert.deepEqual(clicks, [active]);
});

test('Auto disappearance under the same owner cannot confirm that Auto is off', async () => {
  const active = auto();
  const final = snapshot([model]);
  const { bridge, clicks } = harness([final]);
  await assert.rejects(bridge._findModelPickerModel(null, snapshot([active]), 'grok-4.7'), error => error.code?.startsWith('CURSOR_MODEL_AUTO_'));
  assert.deepEqual(clicks, [active]);
});

test('an already visible named model bypasses the Auto recovery path', async () => {
  const { bridge, clicks, reads } = harness();
  const result = await bridge._findModelPickerModel(null, snapshot([model]), 'grok-4.7');
  assert.equal(result.modelRow, model);
  assert.deepEqual(clicks, []);
  assert.deepEqual(reads, []);
});

test('missing ownership and ambiguous, disabled or uncertain Auto controls cannot be clicked', async () => {
  for (const initial of [
    snapshot([auto()], null),
    snapshot([auto({ menuId: null })]),
    snapshot([auto({ menuId: '' })]),
    snapshot([auto(), auto()]),
    snapshot([auto({ disabled: true })]),
    snapshot([auto({ pointerEvents: 'none' })]),
    snapshot([auto({ selected: undefined, autoMode: null })]),
    snapshot([auto({ selected: false, autoMode: null })]),
  ]) {
    const { bridge, clicks } = harness([snapshot([model])]);
    await assert.rejects(bridge._findModelPickerModel(null, initial, 'grok-4.7'), error => error.code?.startsWith('CURSOR_MODEL_AUTO_'));
    assert.deepEqual(clicks, []);
  }
});

test('changing or losing owner after the Auto click cannot adopt the new named model', async () => {
  for (const identity of [null, { ...owner, agentId: 'agent-b' }]) {
    const active = auto();
    const { bridge, clicks } = harness([snapshot([auto({ selected: false, autoMode: false }), model], identity)]);
    await assert.rejects(bridge._findModelPickerModel(null, snapshot([active]), 'grok-4.7'), error => error.code?.startsWith('CURSOR_MODEL_AUTO_'));
    assert.deepEqual(clicks, [active]);
  }
});

test('a different or missing menu ID after toggling cannot authorize a named model', async () => {
  for (const menuId of ['menu-b', null, '']) {
    const active = auto();
    const { bridge, clicks } = harness([snapshot([auto({ menuId, selected: false, autoMode: false }), model])]);
    await assert.rejects(bridge._findModelPickerModel(null, snapshot([active]), 'grok-4.7'), error => error.code?.startsWith('CURSOR_MODEL_AUTO_'));
    assert.deepEqual(clicks, [active]);
  }
});

test('Auto with unknown off state cannot authorize a model even when the model appears', async () => {
  const active = auto();
  const { bridge, clicks } = harness([snapshot([auto({ selected: false, autoMode: null }), model])]);
  await assert.rejects(bridge._findModelPickerModel(null, snapshot([active]), 'grok-4.7'), error => error.code?.startsWith('CURSOR_MODEL_AUTO_'));
  assert.deepEqual(clicks, [active]);
});

test('cancellation before or during Auto polling blocks model selection', async () => {
  for (const before of [true, false]) {
    const active = auto();
    const { bridge, clicks } = harness();
    const job = { cancelRequested: before, sendState: 'not_sent' };
    bridge._readModelPickerRows = async () => {
      job.cancelRequested = true;
      return snapshot([auto({ selected: false, autoMode: false }), model]);
    };
    await assert.rejects(bridge._findModelPickerModel(null, snapshot([active]), 'grok-4.7', job), error => error.cancelled === true);
    assert.deepEqual(clicks, before ? [] : [active]);
    assert.equal(job.sendState, 'not_sent');
  }
});

test('Auto polling transport errors propagate as the original exception', async () => {
  const active = auto();
  const { bridge, clicks } = harness();
  const failure = Object.assign(new Error('Auto read disconnected'), { code: 'ECONNRESET' });
  bridge._readModelPickerRows = async () => { throw failure; };
  await assert.rejects(bridge._findModelPickerModel(null, snapshot([active]), 'grok-4.7'), error => error === failure);
  assert.deepEqual(clicks, [active]);
});
