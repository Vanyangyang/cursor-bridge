import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorBridge, toolErrorResult } from '../server.mjs';

const bridge = () => new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });

test('modern effort selection exits the covering model submenu and uses fresh interactive coordinates', async () => {
  const b = bridge();
  const model = { kind: 'model', text: 'Pinned High', selected: true, submenu: true, hasSubmenu: false };
  const covered = { kind: 'effort_control', text: 'Effort High', pointerEvents: 'none', x: 1, y: 1 };
  const ready = { ...covered, pointerEvents: 'auto', x: 40, y: 80 };
  const high = { kind: 'parameter', text: 'High', selected: true };
  let snapshot = { open: true, rows: [covered, model] };
  const events = [];
  b._readModelPickerRows = async () => snapshot;
  b._openModelPicker = async () => assert.fail('root must not be reopened in this transition');
  b._hoverModelPickerPoint = async () => assert.fail('modern effort must not fall back to model hover');
  b._clickModelPickerPoint = async (_c, row) => {
    assert.equal(row, ready);
    events.push('fresh-effort-click');
    snapshot = { open: true, rows: [ready, high] };
  };
  const client = { send: async (method, params) => {
    assert.equal(method, 'Input.dispatchKeyEvent');
    assert.equal(params.key, 'Escape');
    events.push(params.type);
    if (params.type === 'keyUp') snapshot = { open: true, rows: [ready] };
  } };
  const result = await b._selectedEffortRow(client, model, 'high', {});
  assert.equal(result.row, high);
  assert.deepEqual(events, ['keyDown', 'keyUp', 'fresh-effort-click']);
  assert.deepEqual(result.attempts, ['close_model_submenu', 'fresh_effort_control', 'effort_control']);
});

test('a closed root after Escape fails without a stale click or legacy fallback', async () => {
  const b = bridge();
  let snapshot = { open: true, rows: [
    { kind: 'effort_control', text: 'Effort High', pointerEvents: 'none' },
    { kind: 'model', text: 'Pinned High', submenu: true },
  ] };
  b._readModelPickerRows = async () => snapshot;
  b._clickModelPickerPoint = async () => assert.fail('must not click a stale coordinate');
  b._hoverModelPickerPoint = async () => assert.fail('must not use legacy fallback');
  b._openModelPicker = async () => assert.fail('the outer bounded reopen owns recovery');
  const result = await b._selectedEffortRow({ send: async () => { snapshot = { open: false, rows: [] }; } }, {}, 'high', {});
  assert.equal(result.state, 'not_rendered');
  assert.deepEqual(result.attempts, ['close_model_submenu']);
});

test('root model rows do not trigger Escape when the effort control is already interactive', async () => {
  const b = bridge();
  const rootModel = { kind: 'model', text: 'Pinned', submenu: false };
  const control = { kind: 'effort_control', text: 'Effort High', pointerEvents: 'auto' };
  let snapshot = { open: true, rows: [rootModel, control] };
  b._readModelPickerRows = async () => snapshot;
  b._clickModelPickerPoint = async () => { snapshot = { open: true, rows: [{ kind: 'parameter', text: 'High', selected: true }] }; };
  const result = await b._selectedEffortRow({ send: async () => assert.fail('must not press Escape') }, rootModel, 'high', {});
  assert.equal(result.state, 'matched');
  assert.deepEqual(result.attempts, ['effort_control']);
});

test('picker transport errors never become empty menus or not_rendered', async () => {
  const b = bridge();
  const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const client = { send: async () => { throw failure; } };
  await assert.rejects(b._waitForModelPickerMatch(client, 'High', 'parameter', null, { timeoutMs: 50 }), error => {
    assert.equal(error, failure);
    assert.equal(error.pickerRead.kind, 'rows');
    assert.equal(error.pickerRead.code, 'ECONNRESET');
    assert.ok(error.pickerRead.elapsedMs >= 0);
    return true;
  });
});

test('picker parse and page-execution failures retain distinct causes', async () => {
  const b = bridge();
  for (const [response, code] of [
    [{ result: { value: 'invalid JSON' } }, 'CURSOR_PICKER_PARSE_FAILED'],
    [{ result: { value: 'null' } }, 'CURSOR_PICKER_RESPONSE_INVALID'],
    [{ exceptionDetails: { text: 'renderer exception' } }, 'CDP_EVALUATE_FAILED'],
  ]) {
    await assert.rejects(b._readModelPickerRows({ send: async () => response }), error => {
      assert.equal(error.code, code);
      assert.equal(error.pickerRead.code, code);
      return true;
    });
  }
});

test('picker reads receive the remaining polling budget', async () => {
  const b = bridge();
  let timeout;
  const result = await b._waitForModelPickerMatch({ send: async (_method, _params, options) => {
    timeout = options.timeoutMs;
    return { result: { value: '{"open":false,"rows":[]}' } };
  } }, 'High', 'parameter', null, { timeoutMs: 0 });
  assert.equal(timeout, 1);
  assert.equal(result.state, 'not_rendered');
});

for (const hasSubmenu of [false, true]) {
  test(`selection diagnostics identify ${hasSubmenu ? 'selection' : 'verification'} failure before cleanup`, async () => {
    const b = bridge();
    const row = { text: 'Pinned High', kind: 'model', selected: true, hasSubmenu };
    b._openModelPicker = async () => ({ open: true, rows: [row] });
    b._findModelPickerModel = async (_c, snapshot) => ({ snapshot, modelRow: row });
    b._readModelPickerTrigger = async () => ({ found: true, text: 'Pinned High' });
    b._selectedEffortRow = c => b._readModelPickerRows(c);
    b._closeModelPicker = async () => { throw new Error('cleanup failed too'); };
    const job = { id: 'task-1', targetId: 'target-1', sendState: 'not_sent' };
    const client = { send: async () => { throw Object.assign(new Error('socket lost'), { code: 'ECONNRESET' }); } };
    await assert.rejects(b._applyModelPreference(client, { model: 'Pinned', effort: 'high' }, job), error => {
      assert.equal(error.modelSelection.failureClass, 'picker_read_failed');
      assert.equal(error.modelSelection.stage, hasSubmenu ? 'select_effort' : 'verify_effort');
      assert.equal(error.modelSelection.taskId, job.id);
      assert.equal(error.modelSelection.targetId, job.targetId);
      assert.equal(error.modelSelection.errorCode, 'ECONNRESET');
      assert.equal(error.modelSelection.lastError, 'socket lost');
      assert.equal(error.modelSelection.cleanupError, 'cleanup failed too');
      const tool = toolErrorResult(error);
      assert.equal(tool.isError, true);
      assert.deepEqual(JSON.parse(tool.content[0].text).modelSelection, error.modelSelection);
      assert.equal(tool.structuredContent.modelSelection, error.modelSelection);
      return true;
    });
    assert.equal(job.sendState, 'not_sent');
  });
}
