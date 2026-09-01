import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CURSOR_MODEL_EFFORTS,
  CURSOR_MODEL_TARGETS,
  CursorBridge,
  EXPR_MODEL_PICKER_ROWS,
  EXPR_MODEL_PICKER_TRIGGER,
  buildToolDefinitions,
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
  assert.equal(selectModelPickerRow(rows, 'missing-model', 'model'), null);
  assert.equal(selectModelPickerRow([
    { kind: 'model', text: 'Model A' },
    { kind: 'model', text: 'Model-A' },
  ], 'model-a', 'model'), null);
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
