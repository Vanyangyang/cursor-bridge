import test from 'node:test';
import assert from 'node:assert/strict';

import { EXPR_SELECTED_AGENT_MODEL_CONFIG, matchSelectedAgentModelConfig } from '../server.mjs';

const readModelConfig = document => JSON.parse(Function('document', `return ${EXPR_SELECTED_AGENT_MODEL_CONFIG};`)(document));

function element(classes = [], attributes = {}) {
  const names = new Set(classes);
  const node = {
    parentElement: null,
    children: [],
    offsetParent: {},
    classList: { contains: name => names.has(name) },
    getAttribute: name => attributes[name] ?? null,
    matches(selector) {
      const match = /^\.([\w-]+)(?:\[([\w-]+)\])?$/.exec(selector);
      return !!match && names.has(match[1]) && (!match[2] || attributes[match[2]] !== undefined);
    },
    closest(selector) {
      for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current;
      return null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const visit = current => {
        if (current.matches(selector)) matches.push(current);
        for (const child of current.children) visit(child);
      };
      for (const child of this.children) visit(child);
      return matches;
    },
    append(child) { child.parentElement = this; this.children.push(child); return child; },
    click() { assert.fail('Model verification must not click'); },
    dispatchEvent() { assert.fail('Model verification must not dispatch events'); },
  };
  return node;
}

function pickerProps(modelId = 'grok-4.7', effort = 'high', initialAutoMode = false) {
  return {
    initialSelections: [{ modelId, count: 1, parameters: [{ id: 'reasoning_effort', value: effort }] }],
    initialAutoMode,
    initialMaxMode: false,
    selectionFocusTarget: 'host',
    onSelectionChange() { assert.fail('Model verification must not select'); },
    onAutoModeChange() { assert.fail('Model verification must not toggle Auto'); },
    onHandleReady() { assert.fail('Model verification must not open the picker'); },
  };
}

function legacyFixture() {
  const body = element();
  const composer = body.append(element(['composer-bar', 'editor'], { 'data-composer-id': 'composer-323' }));
  const input = composer.append(element(['aislash-editor-input'], { contenteditable: 'true' }));
  const trigger = composer.append(element(['vscode-model-picker__trigger']));
  const rootState = {};
  const oldRoot = { tag: 3, stateNode: rootState, return: null };
  const currentRoot = { tag: 3, stateNode: rootState, return: null };
  const oldPicker = { memoizedProps: pickerProps('other-model', 'low'), return: oldRoot };
  const currentPicker = { memoizedProps: pickerProps(), return: currentRoot };
  const oldHost = { tag: 5, stateNode: trigger, return: oldPicker };
  const currentHost = { tag: 5, stateNode: trigger, return: currentPicker };
  for (const [old, current] of [[oldRoot, currentRoot], [oldPicker, currentPicker], [oldHost, currentHost]]) {
    old.alternate = current;
    current.alternate = old;
  }
  oldRoot.child = oldPicker;
  currentRoot.child = currentPicker;
  oldPicker.child = oldHost;
  currentPicker.child = currentHost;
  rootState.current = currentRoot;
  trigger.__reactFiber$fixture = oldHost;
  const document = {
    querySelectorAll(selector) {
      return body.querySelectorAll(selector.includes('.aislash-editor-input') ? '.aislash-editor-input' : selector);
    },
  };
  return { body, composer, input, trigger, rootState, oldRoot, currentRoot, oldPicker, currentPicker, oldHost, currentHost, document };
}

function assertRejected(fixture, state) {
  const snapshot = readModelConfig(fixture.document);
  assert.equal(snapshot.found, false);
  if (state) assert.equal(snapshot.state, state);
  assert.equal(matchSelectedAgentModelConfig(snapshot, 'grok-4.7', 'high'), null);
  return snapshot;
}

test('legacy IDE verification reads committed model and effort while the DOM retains the old fiber', () => {
  const fixture = legacyFixture();
  const before = structuredClone(fixture.currentPicker.memoizedProps.initialSelections);
  const snapshot = readModelConfig(fixture.document);
  assert.deepEqual(snapshot, {
    found: true,
    modelName: 'grok-4.7',
    selectedModels: [{ modelId: 'grok-4.7', parameters: { reasoning_effort: 'high' } }],
    source: 'legacy_composer_model_trigger',
  });
  assert.deepEqual(matchSelectedAgentModelConfig(snapshot, 'grok-4.7', 'high'), { modelId: 'grok-4.7', effort: 'high' });
  assert.equal(matchSelectedAgentModelConfig(snapshot, 'other-model', 'low'), null);
  assert.deepEqual(fixture.currentPicker.memoizedProps.initialSelections, before);
});

test('legacy IDE Auto cannot confirm a named model from current or stale selections', () => {
  for (const selections of [[], pickerProps().initialSelections, [{ modelId: 'default', count: 1, parameters: [] }]]) {
    const fixture = legacyFixture();
    fixture.oldPicker.memoizedProps = pickerProps();
    fixture.currentPicker.memoizedProps.initialSelections = selections;
    fixture.currentPicker.memoizedProps.initialAutoMode = true;
    assertRejected(fixture, 'legacy_model_auto');
  }
});

test('legacy IDE named selection without effort evidence cannot confirm requested effort', () => {
  const fixture = legacyFixture();
  fixture.currentPicker.memoizedProps.initialSelections[0].parameters = [];
  const snapshot = readModelConfig(fixture.document);
  assert.equal(snapshot.found, true);
  assert.equal(matchSelectedAgentModelConfig(snapshot, 'grok-4.7', 'high'), null);
});

test('legacy IDE reader rejects ambiguous or different composer ownership', () => {
  const cases = [
    fixture => fixture.composer.append(element(['aislash-editor-input'], { contenteditable: 'true' })),
    fixture => fixture.body.append(element(['composer-bar'], { 'data-composer-id': 'composer-323' })),
    fixture => fixture.composer.append(element(['vscode-model-picker__trigger'])),
    fixture => fixture.composer.append(element(['composer-bar'], { 'data-composer-id': 'nested-composer' })),
    fixture => {
      fixture.composer.children.splice(fixture.composer.children.indexOf(fixture.trigger), 1);
      fixture.body.append(element(['composer-bar'], { 'data-composer-id': 'other-composer' })).append(fixture.trigger);
    },
    fixture => {
      const outer = fixture.body.append(element(['composer-bar'], { 'data-composer-id': 'outer-composer' }));
      fixture.body.children.splice(fixture.body.children.indexOf(fixture.composer), 1);
      outer.append(fixture.composer);
    },
  ];
  for (const change of cases) {
    const fixture = legacyFixture();
    change(fixture);
    assertRejected(fixture);
  }
});

test('legacy IDE reader rejects unrelated trigger class families and missing composer IDs', () => {
  const fixture = legacyFixture();
  fixture.composer.children.splice(fixture.composer.children.indexOf(fixture.trigger), 1);
  fixture.composer.append(element(['ui-model-picker__trigger']));
  assertRejected(fixture, 'legacy_model_trigger_ambiguous');
  const unidentified = legacyFixture();
  unidentified.composer.getAttribute = () => null;
  assertRejected(unidentified, 'legacy_composer_ambiguous');
});

test('legacy IDE reader rejects unknown schemas and conflicting current selections', () => {
  const changes = [
    props => { props.initialAutoMode = 'false'; },
    props => { delete props.initialAutoMode; },
    props => { delete props.initialSelections; },
    props => { props.initialSelections = {}; },
    props => { props.initialSelections = []; },
    props => { props.initialSelections.push(pickerProps('other-model').initialSelections[0]); },
    props => { delete props.initialSelections[0].count; },
    props => { props.initialSelections[0].count = 2; },
    props => { props.initialSelections[0].modelId = ' grok-4.7'; },
    props => { props.initialSelections[0].modelId = 'default'; },
    props => { props.initialSelections[0].parameters = undefined; },
    props => { props.initialSelections[0].parameters[0].value = true; },
    props => { props.initialSelections[0].parameters[0].value = ''; },
    props => { props.initialSelections[0].parameters.push({ id: 'reasoning_effort', value: 'low' }); },
  ];
  for (const change of changes) {
    const fixture = legacyFixture();
    change(fixture.currentPicker.memoizedProps);
    assertRejected(fixture);
  }
  const conflicting = legacyFixture();
  conflicting.currentHost.memoizedProps = pickerProps('other-model', 'high');
  assertRejected(conflicting, 'legacy_model_config_ambiguous');
  const missing = legacyFixture();
  missing.currentPicker.memoizedProps = {};
  assertRejected(missing, 'legacy_model_schema_unconfirmed');
});

test('legacy IDE reader accepts equivalent current props with differently ordered parameters', () => {
  const fixture = legacyFixture();
  fixture.currentPicker.memoizedProps.initialSelections[0].parameters.push({ id: 'context_window', value: 'large' });
  fixture.currentHost.memoizedProps = pickerProps();
  fixture.currentHost.memoizedProps.initialSelections[0].parameters = [{ id: 'context_window', value: 'large' }, { id: 'reasoning_effort', value: 'high' }];
  assert.equal(readModelConfig(fixture.document).found, true);
});

test('legacy IDE reader rejects ambiguous committed edges, borrowed returns, cycles, and missing roots', () => {
  const changes = [
    fixture => { fixture.currentPicker.sibling = fixture.oldPicker; },
    fixture => {
      fixture.oldHost.alternate = null;
      fixture.currentHost.alternate = null;
      fixture.oldHost.return = fixture.currentPicker;
    },
    fixture => { fixture.currentPicker.alternate = {}; },
    fixture => { fixture.oldPicker.return = fixture.oldHost; },
    fixture => { fixture.currentPicker.sibling = fixture.currentPicker; },
    fixture => { fixture.oldRoot.stateNode = null; },
    fixture => { fixture.currentHost.stateNode = element(['vscode-model-picker__trigger']); },
    fixture => { fixture.trigger.__reactFiber$second = fixture.currentHost; },
  ];
  for (const change of changes) {
    const fixture = legacyFixture();
    change(fixture);
    assertRejected(fixture, 'legacy_model_tree_unconfirmed');
  }
});

test('legacy IDE reader rejects a React root that changes during verification', () => {
  const fixture = legacyFixture();
  let reads = 0;
  Object.defineProperty(fixture.rootState, 'current', { get: () => ++reads <= 3 ? fixture.currentRoot : fixture.oldRoot });
  assertRejected(fixture, 'legacy_model_tree_unconfirmed');
});

test('legacy IDE reader bounds ancestor and sibling proof work', () => {
  const deep = legacyFixture();
  let parent = deep.currentRoot;
  for (let index = 0; index < 256; index++) {
    const next = { return: parent };
    parent.child = next;
    parent = next;
  }
  parent.child = deep.currentHost;
  deep.currentHost.return = parent;
  deep.currentHost.alternate = null;
  deep.trigger.__reactFiber$fixture = deep.currentHost;
  assertRejected(deep, 'legacy_model_tree_unconfirmed');
  const wide = legacyFixture();
  let sibling = wide.currentPicker;
  for (let index = 0; index < 2048; index++) sibling = { sibling };
  wide.currentRoot.child = sibling;
  assertRejected(wide, 'legacy_model_tree_unconfirmed');
});

test('existing Agents config takes precedence and retains its snapshot shape', () => {
  const fixture = legacyFixture();
  fixture.input.__reactFiber$agents = {
    memoizedProps: { selectedAgent: { reference: { _composerDataHandle: { _cachedData: {
      modelConfig: { modelName: 'agents-model', selectedModels: [{ modelId: 'agents-model', parameters: [{ id: 'effort', value: 'high' }] }] },
    } } } } },
  };
  assert.deepEqual(readModelConfig(fixture.document), {
    found: true,
    modelName: 'agents-model',
    selectedModels: [{ modelId: 'agents-model', parameters: { effort: 'high' } }],
  });
  fixture.input.__reactFiber$agents.return = {
    memoizedProps: { selectedAgent: { reference: { composerDataHandle: { data: {
      modelConfig: { modelName: 'different-agent' },
    } } } } },
  };
  assertRejected(fixture, 'model_config_ambiguous');
});
