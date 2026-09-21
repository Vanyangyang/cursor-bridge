import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CURSOR_MODEL_EFFORTS,
  CURSOR_MODEL_TARGETS,
  CursorBridge,
  matchSelectedAgentModelConfig,
  EXPR_MODEL_PICKER_ROWS,
  EXPR_MODEL_PICKER_TRIGGER,
  buildToolDefinitions,
  classifyModelPickerRowKind,
  isCursorEffortOptionText,
  modelPickerAvailableIsDecisive,
  normalizeCursorModelEffort,
  normalizeModelPickerText,
  selectModelPickerRow,
} from '../server.mjs';
import {
  cursorEffortUiValue,
  readCursorModelPreferences,
  updateCursorModelPreferences,
} from '../cursor-model-preferences.mjs';

test('persistent model preferences keep CCE and cursor_do independent until explicitly changed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-model-preferences-'));
  const file = join(directory, 'model-preferences.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  updateCursorModelPreferences(file, {
    action: 'set',
    target: 'cce',
    model: 'gpt-5.6-terra',
    effort: 'max',
  });
  updateCursorModelPreferences(file, {
    action: 'set',
    target: 'cursor_do',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });

  const persisted = readCursorModelPreferences(file);
  assert.deepEqual(persisted.targets.cce, { model: 'gpt-5.6-terra', effort: 'max' });
  assert.deepEqual(persisted.targets.cursor_do, { model: 'gpt-5.6-sol', effort: 'high' });

  const restarted = new CursorBridge({
    runtimeFile: null,
    workspaceFile: null,
    modelPreferencesFile: file,
    runtimeMode: 'normal',
  });
  assert.deepEqual(restarted.modelPreferencesView().modelPreferences, persisted.targets);

  restarted.configureModelPreferences({ action: 'reset', target: 'cce' });
  assert.equal(restarted.modelPreferencesView().modelPreferences.cce, null);
  assert.deepEqual(restarted.modelPreferencesView().modelPreferences.cursor_do, {
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
});

test('model effort normalization preserves user-facing xhigh and maps Cursor UI extra-high', () => {
  assert.deepEqual(CURSOR_MODEL_TARGETS, ['cce', 'cursor_do']);
  assert.deepEqual(CURSOR_MODEL_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(normalizeCursorModelEffort('extra-high'), 'xhigh');
  assert.equal(normalizeCursorModelEffort(' XHIGH '), 'xhigh');
  assert.equal(cursorEffortUiValue('xhigh'), 'extra-high');
  assert.throws(
    () => updateCursorModelPreferences(join(tmpdir(), 'unused-model-preferences.json'), {
      action: 'set', target: 'cce', model: 'gpt-5.6-sol', effort: 'ultra',
    }),
    /expected low, medium, high, xhigh, or max/,
  );
});

test('Cursor 3.17.21 model picker contracts expose stable trigger, menu rows, and parameter checks', () => {
  assert.match(EXPR_MODEL_PICKER_TRIGGER, /ui-model-picker__trigger/);
  assert.match(EXPR_MODEL_PICKER_TRIGGER, /vscode-model-picker__trigger/);
  assert.match(EXPR_MODEL_PICKER_TRIGGER, /ui-model-picker__trigger-variant-suffix/);
  assert.match(EXPR_MODEL_PICKER_ROWS, /data-testid="model-picker-menu"/);
  assert.match(EXPR_MODEL_PICKER_ROWS, /data-component="menu-row"/);
  assert.match(EXPR_MODEL_PICKER_ROWS, /menu-submenu-trigger/);
  assert.match(EXPR_MODEL_PICKER_ROWS, /ui-model-picker__item-content-name/);
  assert.match(EXPR_MODEL_PICKER_ROWS, /ui-model-picker__param-check/);
  assert.match(EXPR_MODEL_PICKER_ROWS, /function classifyModelPickerRowKind/);
  assert.match(EXPR_MODEL_PICKER_ROWS, /data-testid\*=\"model-list\"/);
  assert.match(EXPR_MODEL_PICKER_ROWS, /parameter-submenu/);
});

function loadPickerFixture(name) {
  const directory = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(directory, 'fixtures', name), 'utf8'));
}

test('Cursor 3.20.17 Auto menu exposes its Model control and closes through the production reader', async () => {
  // Minimal DOM fixture from the live selected-auto-menu; unrelated and hidden
  // menu popups must not make a closed picker appear open.
  let open = false;
  const attributes = { 'data-testid': 'selected-auto-menu', 'data-component': 'menu-popup' };
  const row = {
    offsetParent: {}, innerText: 'Model\nAuto',
    getAttribute: key => key === 'aria-haspopup' ? 'menu' : null,
    querySelector: () => null, closest: () => null,
    getBoundingClientRect: () => ({ x: 20, y: 40, width: 100, height: 24 }),
  };
  const menu = {
    get offsetParent() { return open ? {} : null; },
    getClientRects: () => open ? [{}] : [],
    getAttribute: key => attributes[key] ?? null,
    querySelectorAll: () => [row],
  };
  const document = {
    querySelectorAll: selectors => selectors.split(',').some(selector => {
      if (!selector.startsWith('[')) return false;
      const clauses = [...selector.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)];
      return clauses.length > 0 && clauses.every(([, key, operator, value]) =>
        operator === '=' ? attributes[key] === value
          : operator === '*=' ? String(attributes[key] || '').includes(value)
            : key in attributes);
    }) ? [menu] : [],
  };
  const b = new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
  b._readModelPickerTrigger = async () => ({ found: true, text: 'Auto', x: 10, y: 20 });
  b._clickModelPickerPoint = async () => { open = true; };
  const client = { send: async (method, params) => {
    if (method === 'Runtime.evaluate') return { result: { value:
      Function('document', 'getComputedStyle', `return ${params.expression}`)(document, () => ({ pointerEvents: 'auto' })),
    } };
    assert.equal(method, 'Input.dispatchKeyEvent');
    assert.equal(params.key, 'Escape');
    if (params.type === 'keyUp') open = false;
    return {};
  } };
  const snapshot = await b._openModelPicker(client);
  assert.equal(snapshot.open, true);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].kind, 'model_control');
  assert.equal(snapshot.rows[0].text, 'Model Auto');
  await b._closeModelPicker(client);
  assert.equal((await b._readModelPickerRows(client)).open, false);
  open = true;
  attributes['data-testid'] = 'unrelated-menu';
  assert.equal((await b._readModelPickerRows(client)).open, false);
});

test('model-list Auto and Add Models are not effort parameters', () => {
  const modelList = loadPickerFixture('cursor-model-picker-model-list.json');
  const effort = loadPickerFixture('cursor-model-picker-effort-submenu.json');
  for (const row of [...modelList.rows, ...effort.rows]) {
    assert.equal(
      classifyModelPickerRowKind(
        row.text,
        row.hasItemName,
        row.menuTestId,
        row.submenuTestId,
        row.ariaHaspopup,
        row.hasParamCheck,
        row.inSubmenu,
      ),
      row.expectedKind,
      row.text,
    );
  }
  const previousCatchAll = classifyModelPickerRowKind(
    'Auto', false, 'selected-model-list-submenu', 'selected-model-list-submenu', null, false, true,
  );
  assert.equal(previousCatchAll, 'model');
  assert.equal(isCursorEffortOptionText('Auto'), false);
  assert.equal(isCursorEffortOptionText('Add Models'), false);
  assert.equal(isCursorEffortOptionText('High'), true);
  assert.equal(isCursorEffortOptionText('Extra High'), true);
  assert.equal(modelPickerAvailableIsDecisive('parameter', ['Auto', 'Add Models']), false);
  assert.equal(modelPickerAvailableIsDecisive('parameter', ['Low', 'Extra High']), true);
});

test('model picker matching handles model IDs, display names, and effort aliases without guessing ties', () => {
  const rows = [
    { kind: 'model', text: 'GPT-5.6 Sol', selected: false },
    { kind: 'model', text: 'GPT-5.6 Terra', selected: true },
    { kind: 'parameter', text: 'Extra High', selected: true },
    { kind: 'parameter', text: 'High', selected: false },
  ];
  assert.equal(normalizeModelPickerText('GPT-5.6 Sol'), 'gpt56sol');
  assert.equal(normalizeModelPickerText('Extra High'), 'xhigh');
  assert.equal(selectModelPickerRow(rows, 'gpt-5.6-sol', 'model').text, 'GPT-5.6 Sol');
  assert.equal(selectModelPickerRow(rows, 'xhigh', 'parameter').text, 'Extra High');
  assert.equal(selectModelPickerRow([
    { kind: 'parameter', text: 'Extra High', selected: true },
  ], 'high', 'parameter'), null);
  assert.equal(selectModelPickerRow([
    { kind: 'parameter', text: 'High', selected: false },
    { kind: 'parameter', text: 'High', selected: true },
  ], 'high', 'parameter'), null);
  assert.equal(selectModelPickerRow(rows, 'missing-model', 'model'), null);
  assert.equal(selectModelPickerRow([
    { kind: 'model', text: 'Model A' },
    { kind: 'model', text: 'Model-A' },
  ], 'model-a', 'model'), null);
});

test('effort picker waits for delayed rows and distinguishes stable unsupported options', async () => {
  const modelRow = { kind: 'model', text: 'Claude Fable 5.1', selected: true, hasSubmenu: true };
  const effortControl = { kind: 'effort_control', text: 'Effort', selected: false };

  class DelayedEffortBridge extends CursorBridge {
    constructor(snapshots) {
      super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
      this.snapshots = snapshots;
      this.clicks = 0;
    }
    async _readModelPickerRows() {
      return this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0];
    }
    async _clickModelPickerPoint() { this.clicks++; }
    async _hoverModelPickerPoint() {}
  }

  const delayed = new DelayedEffortBridge([
    { open: true, rows: [effortControl] },
    { open: true, rows: [] },
    { open: true, rows: [{ kind: 'parameter', text: 'High', selected: true }] },
  ]);
  const matched = await delayed._selectedEffortRow(null, modelRow, 'high', null);
  assert.equal(matched.state, 'matched');
  assert.equal(matched.row.text, 'High');
  assert.deepEqual(matched.attempts, ['effort_control']);
  assert.equal(delayed.clicks, 1);

  const unsupported = new DelayedEffortBridge([
    { open: true, rows: [effortControl] },
    { open: true, rows: [
      { kind: 'parameter', text: 'Low', selected: false },
      { kind: 'parameter', text: 'Extra High', selected: true },
    ] },
  ]);
  const missing = await unsupported._selectedEffortRow(null, modelRow, 'high', null);
  assert.equal(missing.state, 'unsupported');
  assert.equal(missing.row, null);
  assert.deepEqual(missing.available, ['Low', 'Extra High']);

  const chromeThenEffort = new DelayedEffortBridge([
    { open: true, rows: [effortControl] },
    { open: true, rows: [
      { kind: 'parameter', text: 'Auto', selected: false },
      { kind: 'parameter', text: 'Add Models', selected: false },
    ] },
    { open: true, rows: [
      { kind: 'parameter', text: 'Auto', selected: false },
      { kind: 'parameter', text: 'Add Models', selected: false },
    ] },
    { open: true, rows: [
      { kind: 'parameter', text: 'Low', selected: false },
      { kind: 'parameter', text: 'High', selected: true },
    ] },
  ]);
  const recovered = await chromeThenEffort._selectedEffortRow(null, modelRow, 'high', null);
  assert.equal(recovered.state, 'matched');
  assert.equal(recovered.row.text, 'High');
  assert.deepEqual(recovered.attempts, ['effort_control']);

  const chromeOnly = new DelayedEffortBridge([
    { open: true, rows: [effortControl] },
    { open: true, rows: [
      { kind: 'parameter', text: 'Auto', selected: false },
      { kind: 'parameter', text: 'Add Models', selected: false },
    ] },
  ]);
  const notRendered = await chromeOnly._selectedEffortRow(null, modelRow, 'high', null);
  assert.equal(notRendered.state, 'not_rendered');
  assert.equal(notRendered.row, null);
  assert.deepEqual(notRendered.attempts, ['effort_control']);
});

test('native Auto/Add Models parameter chrome is not a non-retryable unsupported effort menu', async () => {
  const modelRow = { kind: 'model', text: 'Claude Fable 5.1 High', selected: true, hasSubmenu: true };
  const effortControl = { kind: 'effort_control', text: 'Effort High', selected: false };
  class NativeChromeBridge extends CursorBridge {
    constructor() {
      super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
      this.closeCalls = 0;
    }
    async _openModelPicker() {
      return { trigger: { found: true }, rows: [effortControl, modelRow] };
    }
    async _findModelPickerModel(_client, snapshot) { return { snapshot, modelRow }; }
    async _selectedEffortRow() {
      return {
        row: null,
        state: 'not_rendered',
        available: ['Auto', 'Add Models'],
        attempts: ['effort_control', 'model_hover'],
      };
    }
    async _closeModelPicker() { this.closeCalls++; }
  }

  const bridge = new NativeChromeBridge();
  const job = { cancelRequested: false, sendState: 'not_sent' };
  await assert.rejects(
    bridge._applyModelPreference(null, { model: 'Claude Fable 5.1', effort: 'high' }, job),
    (error) => {
      assert.equal(error.modelSelection.failureClass, 'effort_menu_not_rendered');
      assert.equal(error.modelSelection.retryable, true);
      assert.deepEqual(error.modelSelection.available, ['Auto', 'Add Models']);
      assert.notEqual(error.modelSelection.failureClass, 'effort_unsupported');
      return true;
    },
  );
  assert.equal(job.modelSelection.applied, false);
  assert.equal(bridge.closeCalls, 2);
});

test('model selection failures clean up the picker and expose structured diagnostics', async () => {
  const modelRow = { kind: 'model', text: 'Claude Fable 5.1', selected: true, hasSubmenu: true };
  class MissingEffortBridge extends CursorBridge {
    constructor() {
      super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
      this.closeCalls = 0;
    }
    async _openModelPicker() { return { trigger: { found: true }, rows: [modelRow] }; }
    async _findModelPickerModel(_client, snapshot) { return { snapshot, modelRow }; }
    async _selectedEffortRow() {
      return { row: null, state: 'not_rendered', available: [], attempts: ['model_hover'] };
    }
    async _closeModelPicker() { this.closeCalls++; }
  }

  const bridge = new MissingEffortBridge();
  const job = { cancelRequested: false, sendState: 'not_sent' };
  await assert.rejects(
    bridge._applyModelPreference(null, { model: 'Claude Fable 5.1', effort: 'high' }, job),
    (error) => {
      assert.equal(error.modelSelection.failureClass, 'effort_menu_not_rendered');
      assert.equal(error.modelSelection.retryable, true);
      assert.equal(error.modelSelection.runtimeMode, 'normal');
      return true;
    },
  );
  assert.equal(job.modelSelection.applied, false);
  assert.deepEqual(job.modelSelection.attempts, ['picker_reopen', 'model_hover']);
  assert.equal(bridge.closeCalls, 2);
});

test('effort confirmation never clicks the same option a second time', async () => {
  const modelRow = { kind: 'model', text: 'Claude Fable 5.1', selected: true, hasSubmenu: true };
  const effortRow = { kind: 'parameter', text: 'High', selected: false };
  class UnconfirmedEffortBridge extends CursorBridge {
    constructor() {
      super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
      this.selectionClicks = 0;
    }
    async _openModelPicker() { return { trigger: { found: true }, rows: [modelRow] }; }
    async _findModelPickerModel(_client, snapshot) { return { snapshot, modelRow }; }
    async _selectedEffortRow() {
      return { row: effortRow, state: 'matched', available: ['High'], attempts: ['visible'] };
    }
    async _clickModelPickerPoint() { this.selectionClicks++; }
    async _readModelPickerTrigger() {
      return { found: true, text: 'Claude Fable 5.1 High', detail: 'High' };
    }
    async _waitForSelectedModelPickerRow() { return null; }
    async _closeModelPicker() {}
  }

  const bridge = new UnconfirmedEffortBridge();
  await assert.rejects(
    bridge._applyModelPreference(null, { model: 'Claude Fable 5.1', effort: 'high' }),
    (error) => error.modelSelection.failureClass === 'effort_not_confirmed',
  );
  assert.equal(bridge.selectionClicks, 1);
});

test('minimal runtime verifies exact selected Agent model configuration without opening a hidden picker', async () => {
  const snapshot = {
    found: true,
    modelName: 'grok-4.6',
    selectedModels: [{ modelId: 'grok-4.6', parameters: { effort: 'high', fast: 'false' } }],
  };
  assert.deepEqual(matchSelectedAgentModelConfig(snapshot, 'Cursor Grok 4.6', 'high'), {
    modelId: 'grok-4.6', effort: 'high',
  });
  assert.equal(matchSelectedAgentModelConfig(snapshot, 'Cursor Grok 4.6', 'xhigh'), null);
  assert.equal(matchSelectedAgentModelConfig(snapshot, 'Claude Fable 5.1', 'high'), null);

  const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null, runtimeMode: 'minimal' });
  bridge._readSelectedAgentModelConfig = async () => snapshot;
  bridge._openModelPicker = async () => assert.fail('minimal verification must not open the picker');
  bridge._closeModelPicker = async () => {};
  const result = await bridge._applyModelPreference(null, { model: 'Cursor Grok 4.6', effort: 'high' });
  assert.equal(result.applied, true);
  assert.equal(result.verificationSource, 'selected_agent_model_config');
});

test('Cursor 3.21 separate root effort control is applied when model rows have no submenu', async () => {
  class SeparateRootEffortBridge extends CursorBridge {
    constructor(modelSelected) {
      super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
      this.modelRow = {
        kind: 'model', text: 'Cursor Grok 4.6 Extra High', selected: modelSelected, hasSubmenu: false,
      };
      this.effortSelected = false;
      this.clicks = [];
    }
    async _openModelPicker() {
      return { open: true, rows: [
        { kind: 'effort_control', text: `Effort ${this.effortSelected ? 'High' : 'Extra High'}`, hasSubmenu: true },
        this.modelRow,
      ] };
    }
    async _findModelPickerModel(_client, snapshot) { return { snapshot, modelRow: this.modelRow }; }
    async _selectedEffortRow() {
      return {
        row: { kind: 'parameter', text: 'High', selected: this.effortSelected },
        state: 'matched', available: ['Low', 'Medium', 'High', 'Extra High'], attempts: ['effort_control'],
      };
    }
    async _clickModelPickerPoint(_client, row) {
      this.clicks.push(row.text);
      if (row.kind === 'model') this.modelRow.selected = true;
      if (row.kind === 'parameter') this.effortSelected = true;
    }
    async _readModelPickerTrigger() { return { found: true, text: 'High', detail: '' }; }
    async _closeModelPicker() {}
  }

  for (const modelSelected of [true, false]) {
    const bridge = new SeparateRootEffortBridge(modelSelected);
    const result = await bridge._applyModelPreference(null, { model: 'Cursor Grok 4.6', effort: 'high' });
    assert.equal(result.applied, true);
    assert.equal(result.effectiveEffort, 'high');
    assert.deepEqual(bridge.clicks, modelSelected
      ? ['High']
      : ['Cursor Grok 4.6 Extra High', 'High']);
  }
});

test('Cursor 3.18.25 reports the verified model row when the trigger shows only effort', async () => {
  const modelRow = {
    kind: 'model',
    text: 'Cursor Grok 4.6 High Fast',
    selected: true,
    disabled: false,
    hasSubmenu: false,
  };
  class Cursor31825Bridge extends CursorBridge {
    constructor() {
      super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
    }
    async _openModelPicker() {
      return { trigger: { found: true, text: 'High Fast', detail: '' }, rows: [modelRow] };
    }
    async _findModelPickerModel(_client, snapshot) {
      return { snapshot, modelRow };
    }
    async _readModelPickerTrigger() {
      return { found: true, text: 'High Fast', detail: '' };
    }
    async _closeModelPicker() {}
  }

  const result = await new Cursor31825Bridge()._applyModelPreference(
    null,
    { model: 'Cursor Grok 4.6' },
  );
  assert.equal(result.applied, true);
  assert.equal(result.effectiveModel, 'Cursor Grok 4.6 High Fast');
});

test('cursor_model is the only persistent mutation surface and status exposes configured versus effective values', () => {
  const bridge = new CursorBridge({
    runtimeFile: null,
    workspaceFile: null,
    modelPreferencesFile: null,
    runtimeMode: 'normal',
  });
  const tools = buildToolDefinitions(bridge);
  const model = tools.find((tool) => tool.name === 'cursor_model');
  const status = tools.find((tool) => tool.name === 'cursor_status');
  assert.ok(model);
  assert.deepEqual(model.inputSchema.properties.action.enum, ['show', 'set', 'reset']);
  assert.deepEqual(model.inputSchema.properties.target.enum, ['cce', 'cursor_do', 'both']);
  assert.deepEqual(model.inputSchema.properties.effort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(model.inputSchema.required, ['action']);
  assert.match(model.description, /survive host tasks, MCP restarts, and Cursor Bridge restarts/);
  assert.match(model.description, /fails before prompt submission instead of silently falling back to Auto/);
  assert.match(status.description, /configured and effective model selection/);
});

test('new CCE and cursor_do jobs snapshot their independent persistent defaults', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-model-job-'));
  const file = join(directory, 'model-preferences.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  updateCursorModelPreferences(file, {
    action: 'set', target: 'cce', model: 'gpt-5.6-terra', effort: 'max',
  });
  updateCursorModelPreferences(file, {
    action: 'set', target: 'cursor_do', model: 'gpt-5.6-sol', effort: 'high',
  });

  class ProbeBridge extends CursorBridge {
    constructor() {
      super({
        runtimeFile: null,
        workspaceFile: null,
        modelPreferencesFile: file,
        runtimeMode: 'normal',
      });
      this.captured = [];
    }
    async _ensureCursor() {}
    _drain() {}
    _enqueue(kind, prompt, options) {
      this.captured.push({ kind, options });
      if (kind === 'context_engine') {
        return { promise: Promise.resolve('CCE_SEARCH_RESULT\nintent: test\ncoverage: focused | enough\nevidence:\n- server.mjs:1 | test | evidence | source-read\ngaps: none\nconfidence: high') };
      }
      return super._enqueue(kind, prompt, options);
    }
  }

  const bridge = new ProbeBridge();
  await bridge.contextEngine('find model preference owner');
  const task = await bridge.doTask('bounded implementation');
  assert.deepEqual(bridge.captured[0].options.modelPreference, {
    model: 'gpt-5.6-terra', effort: 'max',
  });
  assert.deepEqual(bridge.tasks.get(task.taskId).modelPreference, {
    model: 'gpt-5.6-sol', effort: 'high',
  });
  assert.equal(bridge.tasks.get(task.taskId).modelSelection.applied, false);
});
