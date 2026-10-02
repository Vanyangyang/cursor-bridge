import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorBridge, EXPR_MODEL_PICKER_TRIGGER, EXPR_MODEL_PICKER_ROWS, exprActivateClosedModelPicker } from '../server.mjs';

// A deliberately small DOM fixture: expressions run unchanged, including their
// selectors, ancestor lookup, geometry and hit test. No Cursor or CDP is used.
class NodeFixture {
  constructor({ classes = [], attrs = {}, text = '', rect, visible = true } = {}) {
    this.attrs = { ...attrs };
    this.classes = new Set(classes);
    this.classList = { contains: name => this.classes.has(name) };
    this.children = [];
    this.parentElement = null;
    this.text = text;
    this.rect = rect || { x: 20, y: 20, width: 120, height: 30 };
    this.offsetParent = visible ? {} : null;
    this.disabled = false;
    this.clicks = 0;
    this.style = { pointerEvents: 'auto', visibility: 'visible', display: 'block' };
  }
  get id() { return this.attrs.id || ''; }
  get innerText() { return [this.text, ...this.children.map(child => child.innerText)].filter(Boolean).join(' '); }
  get textContent() { return this.innerText; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  click() { this.clicks++; }
  hasAttribute(name) { return name in this.attrs; }
  getBoundingClientRect() { return { ...this.rect, left: this.rect.x, top: this.rect.y, right: this.rect.x + this.rect.width, bottom: this.rect.y + this.rect.height }; }
  getClientRects() { return this.offsetParent === null ? [] : [this.getBoundingClientRect()]; }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  matches(selectors) {
    return selectors.split(',').some(raw => {
      const selector = raw.trim();
      if (!selector) return false;
      const attrs = [...selector.matchAll(/\[([\w-]+)(?:(\*?=)["']([^"']*)["'])?\]/g)];
      if (!attrs.every(([, name, operator, value]) => operator === '=' ? this.getAttribute(name) === value
        : operator === '*=' ? String(this.getAttribute(name) || '').includes(value) : this.hasAttribute(name))) return false;
      const withoutAttrs = selector.replace(/\[[^\]]*\]/g, '');
      const classes = [...withoutAttrs.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      if (!classes.every(name => this.classes.has(name))) return false;
      const id = withoutAttrs.match(/#([\w-]+)/)?.[1];
      return !id || this.id === id;
    });
  }
  closest(selectors) { return this.matches(selectors) ? this : this.parentElement?.closest(selectors) || null; }
  querySelectorAll(selectors) {
    return this.children.flatMap(child => [...(child.matches(selectors) ? [child] : []), ...child.querySelectorAll(selectors)]);
  }
  querySelector(selectors) { return this.querySelectorAll(selectors)[0] || null; }
}

function pickerFixture() {
  const root = new NodeFixture({ attrs: { 'data-agent-panel-conversation-shell': 'true', 'data-glass-agent-id': 'agent-owned' } });
  const composer = root.append(new NodeFixture({ classes: ['composer-bar'], attrs: { 'data-composer-id': 'composer-owned', 'data-agent-id': 'agent-owned' } }));
  const input = composer.append(new NodeFixture({ classes: ['ui-prompt-input-editor__input'], attrs: { contenteditable: 'true' } }));
  const trigger = composer.append(new NodeFixture({ classes: ['ui-model-picker__trigger'], attrs: { id: 'trigger-owned', 'aria-controls': 'menu-owned' } }));
  const label = trigger.append(new NodeFixture({ classes: ['ui-model-picker__trigger-text'], text: 'Grok 4.7' }));
  trigger.append(new NodeFixture({ classes: ['ui-model-picker__trigger-variant-suffix'], text: 'High' }));
  const document = {
    querySelectorAll: selector => root.querySelectorAll(selector),
    querySelector: selector => root.querySelector(selector),
    getElementById: id => root.querySelectorAll('[id]').find(node => node.id === id) || null,
    elementFromPoint: () => label,
    documentElement: { clientWidth: 1000, clientHeight: 800 },
    activeElement: input,
  };
  const evaluate = expression => JSON.parse(Function('document', 'window', 'getComputedStyle', 'innerWidth', 'innerHeight', 'CSS', `return ${expression}`)(
    document, { innerWidth: 1000, innerHeight: 800 }, node => node.style, 1000, 800, { escape: value => value },
  ));
  const menu = (id, testId = 'model-picker-menu', attrs = {}) => root.append(new NodeFixture({ attrs: { id, 'data-testid': testId, 'data-component': 'menu-popup', ...attrs } }));
  const row = (parent, text, attrs = {}) => parent.append(new NodeFixture({ text, attrs: { 'data-component': 'menu-row', ...attrs } }));
  return { root, composer, input, trigger, label, document, evaluate, menu, row };
}

test('production trigger expression resolves the writable input owner and accepts its child hit', () => {
  const f = pickerFixture();
  const foreign = f.root.append(new NodeFixture({ classes: ['composer-bar'], attrs: { 'data-composer-id': 'composer-foreign' } }));
  foreign.append(new NodeFixture({ classes: ['ui-model-picker__trigger'], text: 'Foreign Auto', attrs: { id: 'trigger-foreign' } }));
  const result = f.evaluate(EXPR_MODEL_PICKER_TRIGGER);
  assert.equal(result.found, true);
  assert.equal(result.interactive, true);
  assert.equal(result.triggerId, 'trigger-owned');
  assert.equal(result.composerId, 'composer-owned');
  assert.equal(result.agentId, 'agent-owned');
  assert.equal(result.text, 'Grok 4.7');
  assert.equal(result.detail, 'High');
  assert.deepEqual([result.x, result.y], [80, 35]);
});

test('production trigger expression rejects ambiguous or foreign ownership', async t => {
  for (const [name, mutate] of [
    ['multiple writable inputs', f => f.composer.append(new NodeFixture({ classes: ['ui-prompt-input-editor__input'], attrs: { contenteditable: 'true' } }))],
    ['missing composer scope', f => { f.composer.classes.clear(); }],
    ['multiple owner triggers', f => f.composer.append(new NodeFixture({ classes: ['ui-model-picker__trigger'] }))],
    ['global foreign trigger only', f => { f.trigger.classes.clear(); f.root.append(new NodeFixture({ classes: ['ui-model-picker__trigger'], text: 'Foreign Auto' })); }],
  ]) {
    await t.test(name, () => {
      const f = pickerFixture();
      mutate(f);
      assert.equal(f.evaluate(EXPR_MODEL_PICKER_TRIGGER).found, false);
    });
  }
});

test('production trigger expression refuses a blocked or noninteractive center', async t => {
  for (const [name, mutate] of [
    ['covered by another element', f => { f.document.elementFromPoint = () => f.root; }],
    ['disabled', f => { f.trigger.disabled = true; }],
    ['aria disabled', f => { f.trigger.attrs['aria-disabled'] = 'true'; }],
    ['pointer events none', f => { f.trigger.style.pointerEvents = 'none'; }],
    ['outside viewport', f => { f.trigger.rect.x = -500; }],
  ]) {
    await t.test(name, () => {
      const f = pickerFixture();
      mutate(f);
      const result = f.evaluate(EXPR_MODEL_PICKER_TRIGGER);
      assert.equal(result.found, true);
      assert.equal(result.interactive, false);
    });
  }
});

test('production menu reader rejects a foreign root when the owner link is absent', () => {
  const f = pickerFixture();
  const foreign = f.menu('menu-foreign');
  f.row(foreign, 'Foreign Grok');
  const snapshot = f.evaluate(EXPR_MODEL_PICKER_ROWS);
  assert.equal(snapshot.open, false);
  assert.deepEqual(snapshot.rows, []);
});

test('production menu reader follows linked root and submenu, excluding foreign menus', () => {
  const f = pickerFixture();
  const owned = f.menu('menu-owned', 'model-picker-menu', { 'aria-labelledby': 'trigger-owned' });
  f.row(owned, 'Model Auto', { id: 'model-control', 'aria-haspopup': 'menu', 'aria-controls': 'submenu-owned' });
  const submenu = f.menu('submenu-owned', 'selected-model-list-submenu', { 'data-submenu': 'true', 'aria-labelledby': 'model-control' });
  f.row(submenu, 'Grok 4.7');
  f.row(f.menu('menu-foreign'), 'Foreign Auto');
  f.row(f.menu('submenu-foreign', 'parameter-submenu', { 'data-submenu': 'true', 'aria-labelledby': 'foreign-control' }), 'Foreign High');
  const snapshot = f.evaluate(EXPR_MODEL_PICKER_ROWS);
  assert.equal(snapshot.open, true);
  assert.deepEqual(snapshot.rows.map(row => row.text).sort(), ['Grok 4.7', 'Model Auto']);
});

test('production menu reader accepts an exact label-only link without a menu id', () => {
  const f = pickerFixture();
  delete f.trigger.attrs['aria-controls'];
  const owned = f.menu('unused-menu-id', 'model-picker-menu', { 'aria-labelledby': 'trigger-owned' });
  delete owned.attrs.id;
  f.row(owned, 'Grok 4.7');
  f.row(f.menu('foreign-menu'), 'Foreign Auto');
  const snapshot = f.evaluate(EXPR_MODEL_PICKER_ROWS);
  assert.equal(snapshot.open, true);
  assert.deepEqual(snapshot.rows.map(row => row.text), ['Grok 4.7']);
  assert.equal(snapshot.owner.triggerId, 'trigger-owned');
});

test('production menu reader allows only the unique legacy root without ownership attributes', () => {
  const f = pickerFixture();
  delete f.trigger.attrs['aria-controls'];
  delete f.trigger.attrs.id;
  f.row(f.menu('legacy-menu'), 'Grok 4.7');
  assert.equal(f.evaluate(EXPR_MODEL_PICKER_ROWS).open, true);
  f.row(f.menu('another-legacy-menu'), 'Foreign Auto');
  const ambiguous = f.evaluate(EXPR_MODEL_PICKER_ROWS);
  assert.equal(ambiguous.open, false);
  assert.deepEqual(ambiguous.rows, []);
});

const createBridge = () => new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
const readyTrigger = (x = 80) => ({ found: true, state: 'ready', interactive: true, x, y: 35, text: 'Grok 4.7', detail: 'High', triggerId: 'trigger-owned', composerId: 'composer-owned', agentId: 'agent-owned' });
const pickerOwner = (trigger = readyTrigger()) => ({ triggerId: trigger.triggerId, composerId: trigger.composerId, agentId: trigger.agentId });

test('opening waits for fresh stable coordinates and an interactive trigger before its only click', async () => {
  const b = createBridge();
  const snapshots = [
    { ...readyTrigger(10), interactive: false },
    readyTrigger(20),
    readyTrigger(30),
  ];
  let open = false;
  const clicks = [];
  b._readModelPickerTrigger = async () => snapshots.length ? snapshots.shift() : readyTrigger(30);
  b._readModelPickerRows = async () => ({ open, rows: [], owner: pickerOwner() });
  b._clickModelPickerPoint = async (_c, trigger) => { clicks.push(trigger); open = true; };
  const result = await b._openModelPicker(null, null, { timeoutMs: 300, pollMs: 5, stableMs: 20 });
  assert.equal(result.open, true);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].interactive, true);
  assert.equal(clicks[0].x, 30);
  assert.equal(snapshots.length, 0);
});

test('opening polls beyond 450ms for a delayed menu without toggling the trigger again', async () => {
  const b = createBridge();
  let clickedAt = null;
  let clicks = 0;
  const budgets = [];
  b._readModelPickerTrigger = async (_c, options) => { budgets.push(options?.timeoutMs); return readyTrigger(); };
  b._readModelPickerRows = async (_c, options) => {
    budgets.push(options?.timeoutMs);
    return { open: clickedAt !== null && Date.now() - clickedAt >= 500, rows: [], owner: pickerOwner() };
  };
  b._clickModelPickerPoint = async () => { clicks++; clickedAt = Date.now(); };
  const result = await b._openModelPicker(null, null, { timeoutMs: 1400, pollMs: 10, stableMs: 20 });
  assert.equal(result.open, true);
  assert.equal(clicks, 1);
  assert.ok(Date.now() - clickedAt >= 500);
  assert.ok(budgets.length > 4);
  assert.ok(budgets.every(budget => Number.isFinite(budget) && budget > 0 && budget <= 1400));
  assert.ok(budgets.at(-1) < budgets[0]);
});

test('a never opening picker reports bounded diagnostics and leaves the job unsent', async () => {
  const b = createBridge();
  const openPicker = b._openModelPicker.bind(b);
  let clicks = 0;
  b._readModelPickerTrigger = async () => readyTrigger();
  b._readModelPickerRows = async () => ({ open: false, rows: [], owner: pickerOwner() });
  b._clickModelPickerPoint = async () => { clicks++; };
  b._closeModelPicker = async () => {};
  b._openModelPicker = (c, job) => openPicker(c, job, { timeoutMs: 100, pollMs: 5, stableMs: 10 });
  const job = { id: 'fixture-task', targetId: 'fixture-target', sendState: 'not_sent' };
  await assert.rejects(b._applyModelPreference(null, { model: 'grok-4.7', effort: 'high' }, job), error => {
    assert.equal(error.modelSelection.failureClass, 'picker_did_not_open');
    assert.equal(error.modelSelection.stage, 'open_picker');
    assert.equal(error.modelSelection.targetId, job.targetId);
    assert.equal(error.modelSelection.applied, false);
    assert.equal(error.modelSelection.trigger.triggerId, 'trigger-owned');
    assert.equal(error.modelSelection.trigger.composerId, 'composer-owned');
    assert.ok(error.modelSelection.attempts.length > 0);
    assert.deepEqual(error.modelSelection.menu, { open: false, rows: [] });
    return true;
  });
  assert.equal(clicks, 1);
  assert.equal(job.sendState, 'not_sent');
});

test('cancellation before opening never dispatches a click', async () => {
  const b = createBridge();
  const job = { cancelRequested: true, sendState: 'not_sent' };
  b._readModelPickerTrigger = async () => readyTrigger();
  b._readModelPickerRows = async () => ({ open: false, rows: [], owner: pickerOwner() });
  b._clickModelPickerPoint = async () => assert.fail('cancelled job must not click');
  await assert.rejects(b._openModelPicker(null, job, { timeoutMs: 100, pollMs: 5, stableMs: 10 }));
  assert.equal(job.sendState, 'not_sent');
});

test('opening discards old menu rows when the owner changes between the two reads', async () => {
  const b = createBridge();
  const nextTrigger = { ...readyTrigger(), triggerId: 'trigger-next', composerId: 'composer-next', agentId: 'agent-next' };
  const oldRows = [{ kind: 'model', text: 'Old composer model' }];
  const freshRows = [{ kind: 'model', text: 'Grok 4.7' }];
  let reads = 0;
  b._readModelPickerRows = async () => ++reads === 1
    ? { open: true, rows: oldRows, owner: pickerOwner() }
    : { open: true, rows: freshRows, owner: pickerOwner(nextTrigger) };
  b._readModelPickerTrigger = async () => nextTrigger;
  b._clickModelPickerPoint = async () => assert.fail('the new owner already has an open menu');
  const result = await b._openModelPicker(null, null, { timeoutMs: 150, pollMs: 10, stableMs: 100 });
  assert.ok(reads >= 2);
  assert.equal(result.rows, freshRows);
  assert.equal(result.trigger, nextTrigger);
  assert.deepEqual(result.owner, pickerOwner(nextTrigger));
});

test('opening cannot adopt another owner after clicking the original trigger', async () => {
  const b = createBridge();
  const nextTrigger = { ...readyTrigger(), triggerId: 'trigger-next', composerId: 'composer-next', agentId: 'agent-next' };
  let clicks = 0;
  b._readModelPickerRows = async () => ({ open: clicks > 0, rows: [], owner: pickerOwner(clicks ? nextTrigger : readyTrigger()) });
  b._readModelPickerTrigger = async () => clicks ? nextTrigger : readyTrigger();
  b._clickModelPickerPoint = async () => { clicks++; };
  await assert.rejects(b._openModelPicker(null, null, { timeoutMs: 80, pollMs: 10, stableMs: 0 }), error => {
    assert.equal(error.modelSelectionFailure.failureClass, 'picker_did_not_open');
    return true;
  });
  assert.equal(clicks, 1);
});

test('cancellation during picker reads rejects selection before any Model control click', async () => {
  const b = createBridge();
  const job = { id: 'cancelled-read-task', targetId: 'fixture-target', cancelRequested: false, sendState: 'not_sent' };
  let clicks = 0;
  b._readModelPickerRows = async () => {
    job.cancelRequested = true;
    return { open: true, rows: [{ kind: 'model_control', text: 'Model Auto', hasSubmenu: true }], owner: pickerOwner() };
  };
  b._readModelPickerTrigger = async () => readyTrigger();
  b._clickModelPickerPoint = async () => { clicks++; };
  b._hoverModelPickerPoint = async () => assert.fail('cancelled selection must not hover');
  b._closeModelPicker = async () => {};
  await assert.rejects(b._applyModelPreference(null, { model: 'grok-4.7', effort: 'high' }, job), error => error.cancelled === true);
  assert.equal(clicks, 0);
  assert.equal(job.sendState, 'not_sent');
});

test('cancelled model lookup and Model control opening both reject before dispatch', async () => {
  const b = createBridge();
  const job = { cancelRequested: true, sendState: 'not_sent' };
  const snapshot = { open: true, rows: [{ kind: 'model_control', text: 'Model Auto', hasSubmenu: true }], owner: pickerOwner() };
  b._clickModelPickerPoint = async () => assert.fail('cancelled job must not click the Model control');
  b._hoverModelPickerPoint = async () => assert.fail('cancelled job must not hover the Model control');
  await assert.rejects(b._findModelPickerModel(null, snapshot, 'grok-4.7', job), error => error.cancelled === true);
  await assert.rejects(b._openModelPickerControl(null, snapshot, 'model_control', job), error => error.cancelled === true);
  assert.equal(job.sendState, 'not_sent');
});

test('DOM recovery activates only the exact interactive and explicitly closed trigger', async () => {
  const f = pickerFixture();
  f.trigger.attrs['aria-expanded'] = 'false';
  const expected = f.evaluate(EXPR_MODEL_PICKER_TRIGGER);
  assert.equal(expected.expanded, 'false');
  const client = { send: async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: JSON.stringify(f.evaluate(params.expression)) } };
  } };
  const result = await createBridge()._activateClosedModelPicker(client, expected, { timeoutMs: 100 });
  assert.equal(result.clicked, true);
  assert.equal(f.trigger.clicks, 1);
  assert.deepEqual(result.owner, pickerOwner(expected));
});

test('DOM recovery refuses stale identity, position, expansion, hit or ambiguous ownership', async t => {
  for (const [name, mutate] of [
    ['stale trigger id', f => { f.trigger.attrs.id = 'replacement-trigger'; }],
    ['stale composer id', f => { f.composer.attrs['data-composer-id'] = 'replacement-composer'; }],
    ['stale agent id', f => { f.root.attrs['data-glass-agent-id'] = 'replacement-agent'; }],
    ['stale horizontal position', f => { f.trigger.rect.x += 10; }],
    ['stale vertical position', f => { f.trigger.rect.y += 10; }],
    ['missing trigger id', f => { delete f.trigger.attrs.id; }],
    ['already expanded', f => { f.trigger.attrs['aria-expanded'] = 'true'; }],
    ['unknown expansion', f => { delete f.trigger.attrs['aria-expanded']; }],
    ['covered center', f => { f.document.elementFromPoint = () => f.root; }],
    ['ambiguous input', f => f.composer.append(new NodeFixture({ classes: ['ui-prompt-input-editor__input'], attrs: { contenteditable: 'true' } }))],
    ['ambiguous trigger', f => f.composer.append(new NodeFixture({ classes: ['ui-model-picker__trigger'] }))],
  ]) {
    await t.test(name, () => {
      const f = pickerFixture();
      f.trigger.attrs['aria-expanded'] = 'false';
      const expected = f.evaluate(EXPR_MODEL_PICKER_TRIGGER);
      mutate(f);
      const result = f.evaluate(exprActivateClosedModelPicker(expected));
      assert.equal(result.clicked, false);
      assert.equal(f.trigger.clicks, 0);
    });
  }
});

test('an unexpanded native click recovers once while waiting for the recovered menu', async () => {
  const b = createBridge();
  const trigger = { ...readyTrigger(), expanded: 'false' };
  let nativeClicks = 0;
  let activations = 0;
  let recoveredReads = 0;
  b._readModelPickerTrigger = async () => trigger;
  b._readModelPickerRows = async () => ({
    open: activations > 0 && ++recoveredReads >= 3, rows: [], owner: pickerOwner(trigger),
  });
  b._clickModelPickerPoint = async () => { nativeClicks++; };
  b._activateClosedModelPicker = async (_c, current, options) => {
    assert.equal(current, trigger);
    assert.ok(options.timeoutMs >= 10 && options.timeoutMs <= 250);
    activations++;
    return { clicked: true, owner: pickerOwner(current) };
  };
  const result = await b._openModelPicker(null, null, { timeoutMs: 250, pollMs: 10, stableMs: 0, recoveryDelayMs: 10 });
  assert.equal(result.open, true);
  assert.equal(nativeClicks, 1);
  assert.equal(activations, 1);
  assert.ok(recoveredReads >= 3);
});

test('an expanded trigger waits for delayed menu rendering without DOM reactivation', async () => {
  const b = createBridge();
  let clickedAt = null;
  let nativeClicks = 0;
  b._readModelPickerTrigger = async () => ({ ...readyTrigger(), expanded: clickedAt === null ? 'false' : 'true' });
  b._readModelPickerRows = async () => ({ open: clickedAt !== null && Date.now() - clickedAt >= 60, rows: [], owner: pickerOwner() });
  b._clickModelPickerPoint = async () => { nativeClicks++; clickedAt = Date.now(); };
  b._activateClosedModelPicker = async () => assert.fail('aria-expanded=true must never be activated again');
  const result = await b._openModelPicker(null, null, { timeoutMs: 250, pollMs: 10, stableMs: 0, recoveryDelayMs: 10 });
  assert.equal(result.open, true);
  assert.equal(nativeClicks, 1);
  assert.ok(Date.now() - clickedAt >= 60);
});

test('the final polling budget does not manufacture a one-millisecond CDP read', async t => {
  const b = createBridge();
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const budgets = [];
  b._readModelPickerRows = async (_c, options) => {
    budgets.push(options.timeoutMs);
    now = 25;
    return { open: false, rows: [], owner: pickerOwner() };
  };
  b._readModelPickerTrigger = async () => assert.fail('five milliseconds remaining must not cause another CDP read');
  b._clickModelPickerPoint = async () => assert.fail('no trigger was observed');
  await assert.rejects(b._openModelPicker(null, null, { timeoutMs: 30 }), error => {
    assert.equal(error.modelSelectionFailure.failureClass, 'picker_did_not_open');
    assert.equal(error.modelSelectionFailure.lastPollError, null);
    assert.deepEqual(error.modelSelectionFailure.menu, { open: false, rows: [] });
    return true;
  });
  assert.deepEqual(budgets, [30]);
});

test('a real polling timeout at the deadline retains the last observations and timeout cause', async t => {
  const b = createBridge();
  const openPicker = b._openModelPicker.bind(b);
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const trigger = readyTrigger();
  const pickerRead = { kind: 'rows', code: 'CDP_COMMAND_TIMEOUT', message: 'timed out waiting for renderer', elapsedMs: 100 };
  const timeout = Object.assign(new Error(pickerRead.message), { code: pickerRead.code, pickerRead });
  let reads = 0;
  b._readModelPickerRows = async () => {
    if (++reads > 1) { now = 100; throw timeout; }
    return { open: false, rows: [], owner: pickerOwner() };
  };
  b._readModelPickerTrigger = async () => trigger;
  b._clickModelPickerPoint = async () => {};
  b._closeModelPicker = async () => {};
  b._openModelPicker = (c, job) => openPicker(c, job, { timeoutMs: 100, pollMs: 10, stableMs: 0 });
  const job = { id: 'timeout-task', targetId: 'fixture-target', sendState: 'not_sent' };
  await assert.rejects(b._applyModelPreference(null, { model: 'grok-4.7', effort: 'high' }, job), error => {
    assert.equal(error.modelSelection.failureClass, 'picker_did_not_open');
    assert.equal(error.modelSelection.stage, 'open_picker');
    assert.deepEqual(error.modelSelection.lastPollError, pickerRead);
    assert.equal(error.modelSelection.trigger, trigger);
    assert.deepEqual(error.modelSelection.menu, { open: false, rows: [] });
    return true;
  });
  assert.equal(job.sendState, 'not_sent');
});

test('transport failures before the polling deadline propagate unchanged', async t => {
  for (const code of ['ECONNRESET', 'CDP_COMMAND_TIMEOUT']) {
    await t.test(code, async () => {
      const b = createBridge();
      const failure = Object.assign(new Error('early transport failure'), { code });
      b._readModelPickerRows = async () => { throw failure; };
      b._readModelPickerTrigger = async () => assert.fail('transport failure must stop polling');
      b._clickModelPickerPoint = async () => assert.fail('transport failure must not click');
      await assert.rejects(b._openModelPicker(null, null, { timeoutMs: 1000 }), error => error === failure);
    });
  }
});
