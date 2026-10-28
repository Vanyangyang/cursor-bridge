import test from 'node:test';
import assert from 'node:assert/strict';
const { exprSelectAgentWorkspace } = await import(process.env.CURSOR_BRIDGE_TEST_SERVER || '../server.mjs');

const target = 'G:/VibeProj/spellcast';
const project = (path = target, id = 'wanted', extra = {}) => ({
  type: 'workspace', workspaceIdentifier: { id, uri: { scheme: 'file', path } }, ...extra,
});

// Match the actual tag/class/attribute selectors against a small DOM tree;
// do not return rows merely because a selector contains a familiar substring.
class Element {
  constructor(tag, attrs = {}, text = '', children = []) {
    Object.assign(this, { tag, attrs, innerText: text, textContent: text, children, offsetParent: {}, clicks: 0 });
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  click() { this.clicks++; }
  querySelectorAll(selector) {
    const matches = node => selector.split(',').some(part => {
      const tag = part.match(/^[a-z]+/i)?.[0];
      if (tag && tag !== node.tag) return false;
      const cls = part.match(/\.([\w-]+)/)?.[1];
      if (cls && !(node.attrs.class || '').split(' ').includes(cls)) return false;
      return [...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]
        .every(([, key, value]) => value === undefined ? node.getAttribute(key) !== null : node.getAttribute(key) === value);
    });
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class SearchInput extends Element {
  constructor(onInput) { super('input', { role: 'combobox' }); this.onInput = onInput; this.events = []; this.values = []; }
  set value(value) { this.searchValue = value; this.values.push(value); }
  get value() { return this.searchValue || ''; }
  dispatchEvent(event) { this.events.push(event); this.onInput(this.value); }
}

function row(metadata, text = 'spellcast', attrs = {}) {
  const node = new Element('div', { role: 'option', ...attrs }, text);
  node.project = metadata;
  return node;
}

function mountRows(list) {
  const pair = (props = {}, stateNode = null) => {
    const sides = [{ memoizedProps: props, stateNode }, { memoizedProps: props, stateNode }];
    sides[0].alternate = sides[1]; sides[1].alternate = sides[0];
    return sides;
  };
  const root = {};
  const roots = pair({}, root);
  root.current = roots[1];
  const boundary = pair({}, list);
  for (let side = 0; side < 2; side++) { roots[side].child = boundary[side]; boundary[side].return = roots[side]; }
  let previous;
  for (const node of list.children) {
    node.__reactProps$test = { onClick: () => node.clicks++ };
    node.click = () => node.__reactProps$test.onClick();
    const chain = [pair(node.__reactProps$test, node)];
    for (let depth = 0; depth < 13; depth++) chain.push(pair());
    chain.push(pair(node.project ? { project: node.project } : {}));
    for (let side = 0; side < 2; side++) {
      for (let depth = 0; depth < chain.length - 1; depth++) {
        chain[depth][side].return = chain[depth + 1][side];
        chain[depth + 1][side].child = chain[depth][side];
      }
      chain.at(-1)[side].return = boundary[side];
      if (previous) previous[side].sibling = chain.at(-1)[side];
      else boundary[side].child = chain.at(-1)[side];
    }
    previous = chain.at(-1);
    node.__reactFiber$test = chain[0][0];
  }
  return { root, roots };
}

function picker(rows, { modern = true, search, onTick } = {}) {
  const trigger = new Element('button', { class: 'ui-select-trigger', 'aria-haspopup': 'menu' }, 'G:/other/spellcast');
  const list = new Element('div', { role: modern ? 'listbox' : 'menu', 'aria-label': 'Select a project' }, '', rows);
  const commit = mountRows(list);
  const input = search ? new SearchInput(value => { search(value, list); mountRows(list); }) : null;
  const popup = new Element('div', {
    role: modern ? 'dialog' : 'menu', 'data-component': modern ? 'search-menu-popup' : 'menu-popup', 'aria-label': 'Select a project',
  }, '', [...(input ? [input] : []), list]);
  const document = new Element('document', {}, '', [trigger, popup]);
  const waits = [];
  return { document, trigger, popup, list, input, waits, commit,
    async run(path = target, options = {}) {
      const timer = (callback, ms) => { waits.push(ms); onTick?.({ document, popup, list, waits }); if (onTick) mountRows(list); callback(); };
      return JSON.parse(await Function('document', 'setTimeout', 'Event', `return ${exprSelectAgentWorkspace(path, options)}`)(document, timer, Event));
    },
  };
}

test('dialog/listbox deduplicates basename-only rows and matches deep React file identity', async () => {
  const wrong = row(project('G:/other/spellcast', 'other'));
  const wanted = row(project());
  const fixture = picker([wrong, wanted]);
  assert.equal((await fixture.run(target, { workspaceId: 'wanted' })).ok, true);
  assert.equal(wanted.clicks, 1);
  assert.equal(wrong.clicks, 0);
  assert.equal(fixture.trigger.clicks, 1);
});

test('full-path input event exposes a registered project outside Recents', async () => {
  const wanted = row(project());
  const recent = row(project('G:/other/spellcast', 'other'));
  const fixture = picker([recent], { search(value, list) {
    if (value === 'g:\\vibeproj\\spellcast') list.children = [wanted];
  } });
  assert.equal((await fixture.run(target, { workspaceId: 'wanted' })).ok, true);
  assert.deepEqual(fixture.input.values, ['g:\\vibeproj\\spellcast']);
  assert.equal(fixture.input.events.length, 1);
  assert.equal(fixture.input.events[0].type, 'input');
  assert.equal(fixture.input.events[0].bubbles, true);
  assert.equal(wanted.clicks, 1);
  assert.equal(recent.clicks, 0);
});

test('Windows URI paths normalize case, separators and padding; legacy text remains supported', async () => {
  const wanted = row(project('  /g:/VIBEPROJ/spellcast/  '));
  assert.equal((await picker([wanted]).run(' G:\\VibeProj\\spellcast\\ ')).ok, true);
  const legacy = row(null, '  G:\\VibeProj\\spellcast\n', { role: 'menuitem', 'data-component': 'menu-row' });
  assert.equal((await picker([legacy], { modern: false }).run()).ok, true);
  assert.equal(legacy.clicks, 1);
});

test('Unix identity remains case sensitive', async () => {
  const wrong = row(project('/Projects/app'));
  const wanted = row(project('/projects/app'));
  const fixture = picker([wrong, wanted]);
  fixture.trigger.innerText = '/projects/other';
  assert.equal((await fixture.run('/projects/app')).ok, true);
  assert.equal(wrong.clicks, 0);
  assert.equal(wanted.clicks, 1);
});

test('cloud, SSH, missing and mismatched metadata cannot fall back to visible path text', async () => {
  for (const metadata of [
    project(target, 'wanted', { type: 'repo' }),
    project(target, 'wanted', { remoteAuthority: 'ssh-remote+host' }),
    project(target, 'wanted', { workspaceIdentifier: { id: 'wanted', uri: { scheme: 'vscode-remote', path: target } } }),
    project('G:/other/spellcast'),
    project(target, ''),
    null,
  ]) {
    const candidate = row(metadata, target);
    assert.equal((await picker([candidate]).run()).state, 'workspace_project_option_unavailable');
    assert.equal(candidate.clicks, 0);
  }
});

test('disabled, absent and duplicate identities reject without any row click', async () => {
  for (const candidates of [[], [row(project(), target, { 'aria-disabled': 'true' })],
    [row(project(), target, { 'data-disabled': '' })], [row(project()), row(project())]]) {
    const result = await picker(candidates).run();
    assert.equal(result.ok, false);
    assert.equal(result.state, candidates.length === 2 ? 'workspace_project_option_ambiguous' : 'workspace_project_option_unavailable');
    assert.ok(candidates.every(candidate => candidate.clicks === 0));
  }
});

test('same-path Worktree with another ID cannot replace the confirmed local workspace', async () => {
  for (const options of [{ workspaceId: 'wanted' }, {}]) {
    const worktree = row(project(target, 'worktree', { worktreePath: 'G:/worktrees/spellcast' }));
    const wanted = row(project());
    assert.equal((await picker([worktree, wanted]).run(target, options)).ok, true);
    assert.equal(worktree.clicks, 0);
    assert.equal(wanted.clicks, 1);
  }
  const wrongId = row(project(target, 'other'));
  assert.equal((await picker([wrongId]).run(target, { workspaceId: 'wanted' })).ok, false);
  assert.equal(wrongId.clicks, 0);
});

test('stale alternate metadata and detached committed parent chains cannot authorize a click', async () => {
  const stale = row(project());
  const staleFixture = picker([stale]);
  let old = stale.__reactFiber$test;
  for (let depth = 0; depth < 14; depth++) old = old.return;
  old.alternate.memoizedProps = { project: project('G:/other/spellcast', 'other') };
  assert.equal((await staleFixture.run()).ok, false);
  assert.equal(stale.clicks, 0);

  const detached = row(project());
  const detachedFixture = picker([detached]);
  detached.__reactFiber$test.alternate.return.child = null;
  assert.equal((await detachedFixture.run()).ok, false);
  assert.equal(detached.clicks, 0);
});

test('a root commit change during metadata validation rejects the pending row click', async () => {
  const metadata = project();
  const wanted = row(metadata);
  const fixture = picker([wanted]);
  const identifier = metadata.workspaceIdentifier;
  let commits = 0;
  Object.defineProperty(metadata, 'workspaceIdentifier', { get() {
    if (!commits) {
      fixture.commit.root.current = fixture.commit.roots[0];
      commits++;
    }
    return identifier;
  } });
  const result = await fixture.run(target, { workspaceId: 'wanted' });
  assert.equal(commits, 1);
  assert.equal(result.state, 'workspace_project_option_unavailable');
  assert.equal(result.ok, false);
  assert.equal(wanted.clicks, 0);
});

test('delayed menu and delayed options are observed within a bounded wait', async () => {
  const wanted = row(project());
  const fixture = picker([], { onTick({ document, popup, list, waits }) {
    if (waits.length === 2) document.children.push(popup);
    if (waits.length === 4) list.children = [wanted];
  } });
  fixture.document.children = [fixture.trigger];
  assert.equal((await fixture.run()).ok, true);
  assert.equal(wanted.clicks, 1);
  assert.deepEqual(fixture.waits, [100, 100, 100, 100, 350]);
});

test('missing menu and missing options stop after bounded polling', async () => {
  const absentMenu = picker([]);
  absentMenu.document.children = [absentMenu.trigger];
  assert.equal((await absentMenu.run()).state, 'workspace_project_menu_unavailable');
  assert.equal(absentMenu.waits.length, 20);
  const absentOption = picker([]);
  assert.equal((await absentOption.run()).state, 'workspace_project_option_unavailable');
  assert.equal(absentOption.waits.length, 20);
});

test('selecting the current project closes its remaining dialog through the exact expanded trigger', async () => {
  const wanted = row(project());
  const other = row(project('G:/other/spellcast', 'other'));
  const fixture = picker([wanted, other]);
  fixture.trigger.innerText = target;
  fixture.trigger.attrs['aria-expanded'] = 'false';
  fixture.trigger.click = () => {
    fixture.trigger.clicks++;
    fixture.trigger.attrs['aria-expanded'] = fixture.trigger.clicks === 1 ? 'true' : 'false';
  };
  // The row's ordinary click leaves this already-selected project's dialog open.
  const result = await fixture.run(target, { workspaceId: 'wanted' });
  assert.equal(result.ok, true);
  assert.equal(fixture.trigger.clicks, 2);
  assert.equal(fixture.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(wanted.clicks, 1);
  assert.equal(other.clicks, 0);
  assert.deepEqual(fixture.waits, [350, 100]);
});

test('a remaining project dialog fails closed when its trigger cannot close or changes target', async () => {
  for (const changedTarget of [false, true]) {
    const wanted = row(project());
    const other = row(project('G:/other/spellcast', 'other'));
    const fixture = picker([wanted, other]);
    fixture.trigger.innerText = target;
    fixture.trigger.attrs['aria-expanded'] = 'false';
    fixture.trigger.click = () => {
      fixture.trigger.clicks++;
      fixture.trigger.attrs['aria-expanded'] = 'true';
    };
    if (changedTarget) wanted.__reactProps$test.onClick = () => {
      wanted.clicks++;
      fixture.trigger.innerText = 'G:/other/spellcast';
    };
    const result = await fixture.run(target, { workspaceId: 'wanted' });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'workspace_project_menu_did_not_close');
    assert.equal(fixture.trigger.clicks, changedTarget ? 1 : 2);
    assert.equal(wanted.clicks, 1);
    assert.equal(other.clicks, 0);
    assert.deepEqual(fixture.waits, changedTarget ? [350] : [350, 100]);
  }
});
