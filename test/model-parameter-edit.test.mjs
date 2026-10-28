import test from 'node:test';
import assert from 'node:assert/strict';
const { CursorBridge, EXPR_MODEL_PICKER_ROWS } = await import(process.env.CURSOR_BRIDGE_TEST_SERVER || '../server.mjs');

class Node {
  constructor(tag = 'div', attrs = {}, text = '', rect = { x: 20, y: 20, width: 100, height: 24 }) {
    Object.assign(this, { tag, attrs, text, rect, children: [], parentElement: null, offsetParent: {}, disabled: false });
    this.style = { pointerEvents: 'auto', display: 'block', visibility: 'visible' };
  }
  get innerText() { return [this.text, ...this.children.map(node => node.innerText)].filter(Boolean).join(' '); }
  get textContent() { return this.innerText; }
  get id() { return this.attrs.id || ''; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  hasAttribute(key) { return key in this.attrs; }
  getBoundingClientRect() { return { ...this.rect }; }
  getClientRects() { return this.offsetParent === null ? [] : [this.rect]; }
  append(node) { node.parentElement = this; this.children.push(node); return node; }
  matches(selectors) {
    return selectors.split(',').some(selector => {
      const parts = selector.trim().split(/\s+(?![^\[]*\])/);
      const part = parts.pop();
      const tag = part.match(/^[a-z]+/i)?.[0];
      if (tag && tag !== this.tag) return false;
      const attrs = [...part.matchAll(/\[([\w-]+)(?:(\*?=)["']([^"']*)["'])?\]/g)];
      if (!attrs.every(([, key, operator, value]) => operator === '=' ? this.getAttribute(key) === value
        : operator === '*=' ? String(this.getAttribute(key) || '').includes(value) : this.hasAttribute(key))) return false;
      const classes = [...part.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      if (!classes.every(name => (this.attrs.class || '').split(' ').includes(name))) return false;
      return !parts.length || !!this.parentElement?.closest(parts.join(' '));
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture() {
  const document = new Node('document');
  const shell = document.append(new Node('div', { 'data-agent-panel-conversation-shell': 'true', 'data-glass-agent-id': 'agent-owned' }));
  const composer = shell.append(new Node('div', { class: 'composer-bar', 'data-composer-id': 'composer-owned', 'data-agent-id': 'agent-owned' }));
  const input = composer.append(new Node('div', { class: 'ui-prompt-input-editor__input', contenteditable: 'true' }));
  composer.append(new Node('button', { class: 'ui-model-picker__trigger', id: 'trigger-owned', 'aria-controls': 'menu-owned' }));
  document.activeElement = input;
  const menu = document.append(new Node('div', { role: 'menu', 'data-testid': 'model-picker-menu', id: 'menu-owned', 'aria-labelledby': 'trigger-owned' }));
  const model = menu.append(new Node('li', { role: 'menuitem', 'data-testid': 'model-item-claude-sonnet-5-5' }));
  model.append(new Node('span', { 'data-model-picker-item-name': 'claude-sonnet-5-5' }, 'Sonnet 5.5'));
  const right = model.append(new Node('span', { 'data-component': 'menu-item-right' }));
  right.append(new Node('span', { 'data-icon-name': 'check' }));
  const edit = model.append(new Node('button', { 'data-testid': 'parameter-edit-btn', 'aria-haspopup': 'menu', id: 'edit-owned', 'aria-controls': 'parameters-owned' }, 'Edit', { x: 220, y: 42, width: 32, height: 20 }));
  return { document, menu, model, edit,
    read() { return JSON.parse(Function('document', 'getComputedStyle', `return ${EXPR_MODEL_PICKER_ROWS}`)(document, node => node.style)); },
  };
}

const bridge = () => new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });

test('modern model reader extracts the name, identity, selected check and row-owned Edit center', () => {
  const f = fixture();
  const snapshot = f.read();
  assert.equal(snapshot.open, true);
  const models = snapshot.rows.filter(row => row.kind === 'model');
  assert.equal(models.length, 1);
  assert.equal(models[0].text, 'Sonnet 5.5');
  assert.equal(models[0].modelId, 'claude-sonnet-5-5');
  assert.equal(models[0].selected, true);
  assert.deepEqual(models[0].parameterEdit, { x: 236, y: 52 });
});

test('missing, hidden, disabled and duplicate Edit controls supply no actionable coordinate', () => {
  for (const [name, mutate] of [
    ['missing', f => { f.model.children = f.model.children.filter(node => node !== f.edit); }],
    ['hidden', f => { f.edit.offsetParent = null; }],
    ['disabled', f => { f.edit.disabled = true; }],
    ['aria-disabled', f => { f.edit.attrs['aria-disabled'] = 'true'; }],
    ['pointer-blocked', f => { f.edit.style.pointerEvents = 'none'; }],
    ['duplicate', f => { f.model.append(new Node('button', { 'data-testid': 'parameter-edit-btn' }, 'Edit')); }],
  ]) {
    const f = fixture();
    mutate(f);
    const selected = f.read().rows.find(row => row.text === 'Sonnet 5.5');
    assert.ok(selected);
    assert.ok(!selected.parameterEdit, name);
  }
});

test('effort selection clicks a unique fresh Edit coordinate without hovering or reusing stale row coordinates', async () => {
  const b = bridge();
  const stale = { kind: 'model', modelId: 'claude-sonnet-5-5', text: 'Sonnet 5.5', x: 1, y: 2, parameterEdit: { x: 3, y: 4 } };
  const fresh = { ...stale, x: 50, y: 60, parameterEdit: { x: 236, y: 52 } };
  b._readModelPickerRows = async () => ({ open: true, rows: [fresh] });
  const clicks = [];
  b._clickModelPickerPoint = async (_client, point) => clicks.push(point);
  b._hoverModelPickerPoint = async () => assert.fail('Edit selection must not hover the model');
  b._waitForModelPickerMatch = async (_client, value, kind) => {
    assert.equal(value, 'extra-high');
    assert.equal(kind, 'parameter');
    return { state: 'matched', row: { kind: 'parameter', text: 'Extra High' } };
  };
  const result = await b._selectedEffortRow(null, stale, 'xhigh', null);
  assert.equal(result.state, 'matched');
  assert.deepEqual(clicks, [{ x: 236, y: 52 }]);
});

test('missing or duplicate fresh model identity cannot click the stale Edit', async () => {
  const requested = { kind: 'model', modelId: 'claude-sonnet-5-5', text: 'Sonnet 5.5', parameterEdit: { x: 1, y: 2 } };
  for (const rows of [[], [{ ...requested, modelId: 'other-model' }], [requested, { ...requested }]]) {
    const b = bridge();
    b._readModelPickerRows = async () => ({ open: true, rows });
    b._clickModelPickerPoint = async () => assert.fail('unconfirmed model must not be clicked');
    b._hoverModelPickerPoint = async () => {};
    b._waitForModelPickerMatch = async () => ({ state: 'not_rendered', row: null });
    const result = await b._selectedEffortRow(null, requested, 'xhigh', null);
    assert.equal(result.row, null);
  }
});

test('hidden Edit is revealed on the fresh model row and clicked only at its newly read position', async () => {
  const f = fixture();
  f.edit.offsetParent = null;
  const hidden = f.read().rows.find(row => row.kind === 'model');
  assert.equal(hidden.hasParameterEdit, true);
  assert.equal(hidden.parameterEdit, null);
  const stale = { ...hidden, x: 1, y: 2, parameterEdit: { x: 3, y: 4 } };
  const b = bridge();
  let reads = 0;
  b._readModelPickerRows = async () => { reads++; return f.read(); };
  const hovered = [];
  b._hoverModelPickerPoint = async (_client, model) => {
    hovered.push([model.x, model.y]);
    assert.equal(model.modelId, 'claude-sonnet-5-5');
    assert.notDeepEqual([model.x, model.y], [stale.x, stale.y]);
    f.edit.offsetParent = {};
    f.edit.rect = { x: 300, y: 80, width: 40, height: 24 };
  };
  const clicks = [];
  b._clickModelPickerPoint = async (_client, point) => clicks.push(point);
  b._waitForModelPickerMatch = async () => ({ state: 'matched', row: { kind: 'parameter', text: 'Extra High' }, snapshot: f.read() });
  const result = await b._selectedEffortRow(null, stale, 'xhigh', null);
  assert.equal(result.state, 'matched');
  assert.equal(hovered.length, 1);
  assert.ok(reads >= 2);
  assert.deepEqual(clicks, [{ x: 320, y: 92 }]);
});

test('moving to the exact trigger prevents preview reopening and closes parameter plus root layers', async () => {
  const b = bridge();
  const owner = { triggerId: 'trigger-owned', composerId: 'composer-owned', agentId: 'agent-owned' };
  let layers = 2;
  let pointerOnModel = true;
  const events = [];
  b._readModelPickerRows = async () => ({ open: layers > 0, rows: [], owner });
  b._readModelPickerTrigger = async () => ({ found: true, x: 40, y: 25, ...owner });
  const client = { send: async (method, params) => {
    events.push({ method, ...params });
    if (method === 'Input.dispatchMouseEvent') {
      assert.equal(params.type, 'mouseMoved');
      assert.deepEqual([params.x, params.y], [40, 25]);
      pointerOnModel = false;
    } else {
      assert.equal(method, 'Input.dispatchKeyEvent');
      assert.equal(params.key, 'Escape');
      if (params.type === 'keyUp') layers = pointerOnModel ? 2 : layers - 1;
    }
    return {};
  } };
  await b._closeModelPicker(client);
  assert.equal(layers, 0);
  assert.equal(events.filter(event => event.type === 'keyUp').length, 2);
  assert.equal(events[0].type, 'mouseMoved');
});

test('changed trigger ownership refuses cleanup without pointer or key events', async () => {
  const b = bridge();
  b._readModelPickerRows = async () => ({ open: true, rows: [], owner: { triggerId: 'original', composerId: 'composer-owned', agentId: 'agent-owned' } });
  b._readModelPickerTrigger = async () => ({ found: true, x: 40, y: 25, triggerId: 'other', composerId: 'composer-owned', agentId: 'agent-owned' });
  const events = [];
  const client = { send: async (method, params) => { events.push({ method, ...params }); return {}; } };
  await assert.rejects(b._closeModelPicker(client));
  assert.deepEqual(events, []);
});

test('revealing a hidden Edit rejects a new owner before clicking its matching model', async () => {
  const b = bridge();
  const ownerA = { triggerId: 'trigger-a', composerId: 'composer-a', agentId: 'agent-a' };
  const ownerB = { triggerId: 'trigger-b', composerId: 'composer-b', agentId: 'agent-b' };
  const model = { kind: 'model', modelId: 'grok-4.7', text: 'Grok 4.7', hasParameterEdit: true, parameterEdit: null, x: 30, y: 40 };
  const snapshots = [
    { open: true, owner: ownerA, rows: [model] },
    { open: true, owner: ownerB, rows: [{ ...model, parameterEdit: { x: 999, y: 999 } }] },
  ];
  b._readModelPickerRows = async () => snapshots.length > 1 ? snapshots.shift() : snapshots[0];
  const hovers = [];
  const clicks = [];
  b._hoverModelPickerPoint = async (_client, point) => hovers.push(point);
  b._clickModelPickerPoint = async (_client, point) => clicks.push(point);
  b._waitForModelPickerMatch = async () => assert.fail('changed owner must not reach parameter selection');
  const result = await b._selectedEffortRow(null, model, 'high', null);
  assert.equal(result.state, 'owner_changed');
  assert.equal(result.row, null);
  assert.ok(result.attempts.includes('owner_changed'));
  assert.deepEqual(hovers, [model]);
  assert.deepEqual(clicks, []);
});

test('a matching parameter result from a changed owner is rejected after clicking the original Edit', async () => {
  const b = bridge();
  const ownerA = { triggerId: 'trigger-a', composerId: 'composer-a', agentId: 'agent-a' };
  const ownerB = { triggerId: 'trigger-b', composerId: 'composer-b', agentId: 'agent-b' };
  const model = { kind: 'model', modelId: 'grok-4.7', text: 'Grok 4.7', hasParameterEdit: true, parameterEdit: { x: 30, y: 40 } };
  b._readModelPickerRows = async () => ({ open: true, owner: ownerA, rows: [model] });
  const clicks = [];
  b._hoverModelPickerPoint = async () => assert.fail('visible Edit needs no hover');
  b._clickModelPickerPoint = async (_client, point) => clicks.push(point);
  const foreignParameter = { kind: 'parameter', text: 'High', x: 999, y: 999 };
  b._waitForModelPickerMatch = async () => ({ state: 'matched', row: foreignParameter, snapshot: { open: true, owner: ownerB, rows: [foreignParameter] } });
  const result = await b._selectedEffortRow(null, model, 'high', null);
  assert.equal(result.state, 'owner_changed');
  assert.equal(result.row, null);
  assert.ok(result.attempts.includes('owner_changed'));
  assert.deepEqual(clicks, [{ x: 30, y: 40 }]);
});
