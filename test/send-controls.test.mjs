import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPR_SNAP, EXPR_CLICK_SEND } from '../server.mjs';

function fixture(controls) {
  let clicks = 0;
  const composer = { querySelectorAll: () => buttons };
  const input = { offsetParent: {}, innerText: 'read-only test', getAttribute: () => null,
    classList: { contains: () => false }, closest: () => composer };
  const buttons = controls.map(control => ({
    offsetParent: control.hidden ? null : {}, disabled: !!control.disabled,
    getAttribute: name => control[name] || null,
    classList: { contains: name => name === 'disabled' && control.disabledClass },
    closest: () => control.foreign ? {} : composer,
    matches: () => control.legacy !== false,
    querySelector: () => control.stop ? null : {},
    click: () => clicks++, control,
  }));
  const document = { querySelectorAll: selector => selector.includes('contenteditable') ? [input] : [] };
  const evaluate = expr => Function('document', 'getComputedStyle', `return ${expr}`)(document,
    button => ({ pointerEvents: button.control.pointerEvents || 'auto' }));
  return { evaluate, clicks: () => clicks };
}

test('IDE icon Send and Agents Window button share readiness and exact-composer submission', () => {
  for (const control of [{}, { legacy: false }]) {
    const f = fixture([control]);
    assert.equal(JSON.parse(f.evaluate(EXPR_SNAP)).sendReady, true);
    assert.equal(f.evaluate(EXPR_CLICK_SEND), 'CLICKED');
    assert.equal(f.clicks(), 1);
  }
});

test('hidden, disabled, foreign, stop, and ambiguous controls never become Send', () => {
  for (const controls of [
    [{ hidden: true }], [{ disabled: true }], [{ 'aria-disabled': 'true' }],
    [{ 'data-disabled': 'true' }], [{ disabledClass: true }], [{ pointerEvents: 'none' }],
    [{ foreign: true }], [{ stop: true }], [{}, {}],
  ]) {
    const f = fixture(controls);
    assert.equal(JSON.parse(f.evaluate(EXPR_SNAP)).sendReady, false);
    assert.notEqual(f.evaluate(EXPR_CLICK_SEND), 'CLICKED');
    assert.equal(f.clicks(), 0);
  }
});
