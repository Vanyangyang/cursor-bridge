import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorBridge, exprCreateAgentForWorkspace, exprSelectAgentWorkspace, exprInspectWorkspaceRepository, exprInspectAgentWorkspace, exprRegisterAgentsWorkspace } from '../server.mjs';

const path = 'G:/VibeProj/spellcast';
const environment = (localPath = path, id = 'workspace-spellcast') => ({ id, uri: { scheme: 'file', path: localPath } });
const project = (localPath = path, extra = {}) => ({ type: 'workspace', workspaceIdentifier: environment(localPath), ...extra });
const section = (projects, extra = {}) => ({ id: 'repo:github.com/vanyangyang/spellcast', displayName: 'vanyangyang/spellcast', projects, headers: [], ...extra });
const evaluate = (expression, document) => JSON.parse(Function('document', `return ${expression}`)(document));
const evaluateAsync = async (expression, document) => JSON.parse(await Function('document', `return ${expression}`)(document));

function workspacePicker(rowSpecs, { outsideProject, bounded = true, ancestorDepth = 0 } = {}) {
  let triggerClicks = 0;
  const rowClicks = rowSpecs.map(() => 0);
  const selections = [];
  const pair = (oldProps = {}, currentProps = oldProps, stateNode = null) => {
    const old = { memoizedProps: oldProps, stateNode };
    const current = { memoizedProps: currentProps, stateNode };
    old.alternate = current; current.alternate = old;
    return [old, current];
  };
  const root = {};
  const roots = pair({}, {}, root);
  root.current = roots[1];
  const trigger = { offsetParent: {}, innerText: 'G:\\other\\spellcast', click: () => triggerClicks++ };
  const menu = {
    offsetParent: {},
    getAttribute: key => key === 'role' ? 'menu' : key === 'aria-label' ? 'Select a project' : null,
    querySelector: () => null,
    querySelectorAll: () => rows,
  };
  const menuPair = pair({}, {}, bounded ? menu : {});
  const topPair = outsideProject ? pair({ project: outsideProject }) : menuPair;
  if (outsideProject) for (let side = 0; side < 2; side++) {
    topPair[side].child = menuPair[side]; menuPair[side].return = topPair[side];
  }
  let ancestorPair = topPair;
  for (let depth = 0; depth < ancestorDepth; depth++) {
    const parentPair = pair();
    for (let side = 0; side < 2; side++) {
      parentPair[side].child = ancestorPair[side]; ancestorPair[side].return = parentPair[side];
    }
    ancestorPair = parentPair;
  }
  for (let side = 0; side < 2; side++) {
    roots[side].child = ancestorPair[side]; ancestorPair[side].return = roots[side];
  }
  const rowPairs = [];
  const rows = rowSpecs.map((spec, index) => {
    const currentProjects = spec.currentProjects || spec.projects || ('project' in spec ? [spec.project] : []);
    const oldProjects = spec.oldProjects || currentProjects;
    assert.equal(oldProjects.length, currentProjects.length);
    const selectedProject = currentProjects[0];
    const onClick = () => {
      rowClicks[index]++;
      const identifier = selectedProject?.workspaceIdentifier;
      const uri = identifier?.uri || identifier?.configPath;
      selections.push({ path: uri?.path || spec.text, id: identifier?.id || null });
    };
    const row = { offsetParent: {}, innerText: spec.text, click: () => row.__reactProps$test.onClick() };
    row.__reactProps$test = { onClick };
    const chain = [pair(row.__reactProps$test, row.__reactProps$test, row)];
    // Cursor 3.23 exposes the row project several component fibers above the host row.
    for (let depth = 0; depth < 9; depth++) chain.push(pair());
    for (let depth = 0; depth < currentProjects.length; depth++) {
      chain.push(pair({ project: oldProjects[depth] }, { project: currentProjects[depth] }));
    }
    for (let side = 0; side < 2; side++) {
      for (let depth = 0; depth < chain.length - 1; depth++) {
        chain[depth][side].return = chain[depth + 1][side];
        chain[depth + 1][side].child = chain[depth][side];
      }
      chain.at(-1)[side].return = menuPair[side];
      if (index) rowPairs[index - 1].at(-1)[side].sibling = chain.at(-1)[side];
      else menuPair[side].child = chain.at(-1)[side];
    }
    rowPairs.push(chain);
    row.__reactFiber$test = chain[0][0];
    return row;
  });
  const popup = { offsetParent: {}, getAttribute: () => null, querySelector: () => menu };
  return {
    get triggerClicks() { return triggerClicks; }, rowClicks, selections, rows, rowPairs, root, roots, menuPair,
    querySelectorAll: selector => selector.startsWith('button.ui-select-trigger') ? [trigger]
      : selector.startsWith('[data-component="menu-popup"]') ? [popup, menu] : [],
  };
}

function page(sections, composers = [], hasTranscript = true) {
  let clicks = 0;
  const heads = sections.map(metadata => {
    const button = { getAttribute: key => key === 'aria-label' ? 'New Agent' : null, click: () => clicks++ };
    const head = { innerText: metadata.displayName, querySelectorAll: () => [], __reactFiber$test: { memoizedProps: { section: metadata } } };
    head.parentElement = { querySelectorAll: selector => selector === '.ui-sidebar-section-head' ? [head] : [button] };
    return head;
  });
  return {
    get clicks() { return clicks; },
    activeElement: composers[0] || null,
    querySelectorAll: selector => selector === '.ui-sidebar-section-head' ? heads
      : selector.includes('contenteditable') ? composers
      : selector === '.composer-bar[data-composer-id]' && hasTranscript ? composers : [],
  };
}

function composer(overrides = {}, id = 'agent-1') {
  const header = { id, targetEnvironment: { type: 'existing', environment: environment() }, environment: environment(), location: { type: 'local', environment: environment() }, ...overrides };
  return { dataset: { composerId: id }, offsetParent: {}, getAttribute: () => null,
    __reactFiber$test: { memoizedProps: { selectedAgent: { reference: { header } } } } };
}

test('registered file URI binds local, single remote and dual remote group labels without title heuristics', () => {
  for (const title of ['spellcast', 'vanyangyang/spellcast', 'flyingmoonc/spellcast, vanyangyang/spellcast', 'unrelated display label']) {
    const document = page([section([project()], { displayName: title })]);
    const found = evaluate(exprInspectWorkspaceRepository('g:\\VibeProj\\spellcast\\'), document);
    assert.equal(found.ok, true, title);
    assert.equal(found.workspaceId, 'workspace-spellcast');
    assert.equal(found.workspace, 'g:/vibeproj/spellcast');
    assert.equal(document.clicks, 0);
    assert.equal(evaluate(exprCreateAgentForWorkspace(path), document).ok, true);
    assert.equal(document.clicks, 1);
  }
});

function registrationPage({ workspacePath = path, workspaceFile = false, identifierPath = workspacePath, fail = false } = {}) {
  const metadata = section([]);
  const document = page([metadata]);
  const calls = [];
  class URI {
    constructor(path) { this.scheme = 'file'; this.path = path; }
    static file(path) { calls.push(['file', path]); return new URI(path); }
  }
  const identifier = { id: 'registered-target', [workspaceFile ? 'configPath' : 'uri']: new URI(identifierPath) };
  const workspaces = {
    getSingleFolderWorkspaceIdentifier: async uri => { calls.push(['folder', uri.path]); return identifier; },
    getWorkspaceIdentifier: async uri => { calls.push(['workspaceFile', uri.path]); return identifier; },
  };
  const projects = { replaceWorkspaceProject: async request => {
    calls.push(['register', request]);
    if (fail) throw Error('registration rejected');
    metadata.projects.push(request.project);
  }, refresh: async () => { calls.push(['refresh']); } };
  const context = { workspace: { instantiationService: { _services: { _entries: new Map([
    ['glassWorkspacesService', projects], ['workspacesService', workspaces],
    ['environmentService', { userHome: new URI('/user') }],
  ]) } } } };
  const head = document.querySelectorAll('.ui-sidebar-section-head')[0];
  head.__reactFiber$test.dependencies = { firstContext: { memoizedValue: context } };
  const query = document.querySelectorAll;
  document.querySelectorAll = selector => selector.includes('Open Workspace') ? [head] : query(selector);
  return { document, calls, head, identifier };
}

test('explicit registration uses Cursor identity factory, preserves the exact path and is idempotent', async () => {
  const target = 'C:/projects/中文 project/quote"dir';
  const { document, calls, identifier } = registrationPage({ workspacePath: target });
  const expression = exprRegisterAgentsWorkspace(target);
  const registered = await evaluateAsync(expression, document);
  assert.equal(registered.state, 'workspace_registration_requested');
  assert.deepEqual(calls.map(([name]) => name), ['file', 'folder', 'register', 'refresh']);
  assert.deepEqual(calls[2], ['register', { project: { type: 'workspace', workspaceIdentifier: identifier } }]);
  assert.equal('replaces' in calls[2][1], false);
  assert.equal((await evaluateAsync(expression, document)).state, 'workspace_ready');
  assert.equal(calls.length, 4);
  assert.equal(document.clicks, 0);
});

test('workspace files use their own identifier factory and URI, not one of their folders', async () => {
  const target = 'C:/projects/my.code-workspace';
  const { document, calls } = registrationPage({ workspacePath: target, workspaceFile: true });
  assert.equal((await evaluateAsync(exprRegisterAgentsWorkspace(target, true), document)).state, 'workspace_registration_requested');
  assert.deepEqual(calls[1], ['workspaceFile', target]);
  assert.equal(calls[2][1].project.workspaceIdentifier.configPath.path, target);
});

test('different factory identity, missing service and ambiguous existing targets never add a project', async () => {
  const wrong = registrationPage({ identifierPath: 'G:/other/spellcast' });
  assert.equal((await evaluateAsync(exprRegisterAgentsWorkspace(path), wrong.document)).state, 'workspace_registration_identity_mismatch');
  assert.equal(wrong.calls.some(([name]) => name === 'register'), false);
  const absent = registrationPage();
  delete absent.head.__reactFiber$test.dependencies;
  assert.equal((await evaluateAsync(exprRegisterAgentsWorkspace(path), absent.document)).state, 'workspace_registration_unavailable');
  assert.equal(absent.calls.length, 0);
  const ambiguous = page([section([project(), project()])]);
  assert.equal((await evaluateAsync(exprRegisterAgentsWorkspace(path), ambiguous)).state, 'workspace_ambiguous');
  assert.equal(ambiguous.clicks, 0);
});

test('registration exceptions are diagnostic failures and cannot report ready', async () => {
  const { document } = registrationPage({ fail: true });
  const result = await evaluateAsync(exprRegisterAgentsWorkspace(path), document);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'workspace_registration_failed');
  assert.match(result.error, /registration rejected/);
});

test('historical dual repository group does not compete with the registered local workspace', () => {
  const history = section([], { id: 'repo:github.com/flyingmoonc/spellcast|github.com/vanyangyang/spellcast', displayName: 'flyingmoonc/spellcast, vanyangyang/spellcast', headers: [{ environment: environment() }] });
  const registered = section([project(path, { repoUrls: ['github.com/vanyangyang/spellcast'] })]);
  const found = evaluate(exprInspectWorkspaceRepository(path), page([history, registered]));
  assert.equal(found.ok, true);
  assert.equal(found.sectionId, registered.id);
  assert.deepEqual(found.repoUrls, ['github.com/vanyangyang/spellcast']);
  const absent = page([history]);
  const diagnostic = evaluate(exprCreateAgentForWorkspace(path), absent);
  assert.equal(diagnostic.state, 'workspace_registration_required');
  assert.match(diagnostic.nextStep, /exact local folder/);
  assert.equal(absent.clicks, 0);
});

test('same names, aliases and remote repositories cannot select another checkout', () => {
  const document = page([section([project('G:/other/spellcast')]), section([{ type: 'repo', repoUrls: ['github.com/vanyangyang/spellcast'] }])]);
  assert.equal(evaluate(exprCreateAgentForWorkspace(path), document).ok, false);
  assert.equal(document.clicks, 0);
  const exact = page([section([project('G:/other/spellcast')]), section([project()])]);
  assert.equal(evaluate(exprCreateAgentForWorkspace(path), exact).ok, true);
  assert.equal(exact.clicks, 1);
});

test('multiple registrations for the exact path fail without a click', () => {
  for (const sections of [
    [section([project()]), section([project()])],
    [section([project()]), section([project()], { id: 'repo:another/alias' })],
    [section([project(), project()])],
  ]) {
    const document = page(sections);
    const result = evaluate(exprCreateAgentForWorkspace(path), document);
    assert.equal(result.ok, false);
    assert.match(result.state, /ambiguous/);
    assert.equal(document.clicks, 0);
  }
});

test('Cursor 3.21 grouped repository selects the exact registered workspace in the draft picker', async () => {
  const grouped = page([section([project('G:/other/spellcast', { workspaceIdentifier: environment('G:/other/spellcast', 'workspace-other') }), project()])]);
  const ready = evaluate(exprInspectWorkspaceRepository(path), grouped);
  assert.equal(ready.ok, true);
  assert.equal(ready.workspaceSelectionRequired, true);
  const created = evaluate(exprCreateAgentForWorkspace(path), grouped);
  assert.equal(created.ok, true);
  assert.equal(created.workspaceSelectionRequired, true);
  assert.equal(grouped.clicks, 1);

  const document = workspacePicker([{ text: path }]);
  const selected = await evaluateAsync(exprSelectAgentWorkspace(path), document);
  assert.equal(selected.ok, true);
  assert.equal(selected.state, 'workspace_project_selection_requested');
  assert.equal(document.triggerClicks, 1);
  assert.deepEqual(document.rowClicks, [1]);
});

test('Cursor 3.23 basename rows select only the exact local project file URI and workspace ID', async () => {
  const target = 'C:/Users/Administrator/.codex/worktrees/cursor-3-21-16/cursor-bridge';
  const identifier = { id: 'd37abfbf7a774f6e5470cc8cdd1c140e', uri: {
    scheme: 'file', authority: '', path: '/' + target, fsPath: target.replaceAll('/', '\\'), _fsPath: target.replaceAll('/', '\\'),
  } };
  const document = workspacePicker([
    { text: 'cursor-bridge', project: { workspaceIdentifier: environment('C:/Users/Administrator/plugins/cursor-bridge', 'other') } },
    { text: 'cursor-bridge', project: { id: 'workspace:' + identifier.id, workspaceIdentifier: identifier, name: 'cursor-bridge' } },
  ]);
  const result = await evaluateAsync(exprSelectAgentWorkspace(target), document);
  assert.equal(result.ok, true);
  assert.equal(result.workspace, target.toLowerCase());
  assert.deepEqual(document.rowClicks, [0, 1]);
  assert.deepEqual(document.selections, [{ path: '/' + target, id: identifier.id }]);
});

test('same basename and repository URL cannot establish the requested picker path', async () => {
  const document = workspacePicker([{ text: 'spellcast', project: project('G:/other/spellcast', { repoUrls: ['github.com/vanyangyang/spellcast'] }) }]);
  assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).state, 'workspace_project_option_unavailable');
  assert.deepEqual(document.rowClicks, [0]);
});

test('basename picker rows preserve exact code-workspace configPath identity', async () => {
  const target = 'G:/projects/app.code-workspace';
  const document = workspacePicker([{ text: 'app', project: {
    workspaceIdentifier: { id: 'multi-root', configPath: { scheme: 'file', path: '/' + target } },
  } }]);
  assert.equal((await evaluateAsync(exprSelectAgentWorkspace(target), document)).ok, true);
  assert.deepEqual(document.rowClicks, [1]);
  assert.deepEqual(document.selections, [{ path: '/' + target, id: 'multi-root' }]);
});

test('picker project metadata rejects remote, missing and conflicting identities despite exact row text', async () => {
  for (const metadata of [
    project(path, { remoteAuthority: 'ssh-remote+host' }),
    project(path, { workspaceIdentifier: { ...environment(), remoteAuthority: 'ssh-remote+host' } }),
    project(path, { workspaceIdentifier: { id: 'remote', uri: { scheme: 'file', authority: 'host', path } } }),
    project(path, { workspaceIdentifier: { id: 'remote', uri: { scheme: 'file', remoteAuthority: 'ssh-remote+host', path } } }),
    project(path, { workspaceIdentifier: { id: 'remote', uri: { scheme: 'vscode-remote', path } } }),
    project(path, { workspaceIdentifier: { uri: environment().uri } }),
    project(path, { workspaceIdentifier: { id: 'conflicting', uri: { scheme: 'file', path, fsPath: 'G:/other/spellcast' } } }),
    project(path, { workspaceIdentifier: { id: 'missing-uri' } }),
    null,
  ]) {
    const document = workspacePicker([{ text: path, project: metadata }]);
    assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).state, 'workspace_project_option_unavailable');
    assert.deepEqual(document.rowClicks, [0]);
  }
});

test('duplicate exact project rows and conflicting row project metadata fail without selecting', async () => {
  const duplicate = workspacePicker([{ text: 'spellcast', project: project() }, { text: 'spellcast', project: project() }]);
  assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), duplicate)).state, 'workspace_project_option_ambiguous');
  assert.deepEqual(duplicate.rowClicks, [0, 0]);
  for (const conflictingProject of [project('G:/other/spellcast'), project(path, { workspaceIdentifier: environment(path, 'other-id') })]) {
    const document = workspacePicker([{ text: path, projects: [project(), conflictingProject] }]);
    assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).ok, false);
    assert.deepEqual(document.rowClicks, [0]);
  }
});

test('picker metadata search stops at the menu host and requires a verified fiber boundary', async () => {
  for (const document of [
    workspacePicker([{ text: 'spellcast' }], { outsideProject: project() }),
    workspacePicker([{ text: 'spellcast', project: project('G:/other/spellcast') }], { outsideProject: project() }),
    workspacePicker([{ text: path, project: project() }], { bounded: false }),
  ]) {
    assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).ok, false);
    assert.deepEqual(document.rowClicks, [0]);
  }
});

test('picker resolves swapped old/current project identities through committed child edges', async () => {
  const wanted = project(path, { workspaceIdentifier: environment(path, 'current-wanted') });
  const other = project('G:/other/spellcast', { workspaceIdentifier: environment('G:/other/spellcast', 'current-other') });
  const document = workspacePicker([
    { text: 'spellcast', oldProjects: [wanted], currentProjects: [other] },
    { text: 'spellcast', oldProjects: [other], currentProjects: [wanted] },
  ]);
  assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).ok, true);
  assert.deepEqual(document.rowClicks, [0, 1]);
  assert.deepEqual(document.selections, [{ path, id: 'current-wanted' }]);
});

test('a raw return chain reaching currentRoot cannot override its alternate child selection', async () => {
  const other = project('G:/other/spellcast', { workspaceIdentifier: environment('G:/other/spellcast', 'other-id') });
  const document = workspacePicker([{ text: path, oldProjects: [project()], currentProjects: [other] }]);
  document.menuPair[0].return = document.roots[1];
  assert.equal(document.root.current.child, document.menuPair[1]);
  assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).ok, false);
  assert.deepEqual(document.selections, []);
  assert.deepEqual(document.rowClicks, [0]);
});

test('shared child and identical host props still use the committed project ancestor', async () => {
  const other = project('G:/other/spellcast');
  const wanted = project(path, { workspaceIdentifier: environment(path, 'shared-current') });
  const document = workspacePicker([{ text: 'spellcast', oldProjects: [other], currentProjects: [wanted] }]);
  const chain = document.rowPairs[0];
  chain.at(-1)[1].child = chain.at(-2)[0];
  assert.equal(chain[0][0].memoizedProps, chain[0][1].memoizedProps);
  assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).ok, true);
  assert.deepEqual(document.selections, [{ path, id: 'shared-current' }]);
});

test('the observed 148-level Cursor 3.23 picker proves its current local identity', async () => {
  const metadata = project(path, { workspaceIdentifier: environment(path, 'deep-local') });
  const document = workspacePicker([{ text: 'spellcast', project: metadata }], { ancestorDepth: 135 });
  assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).ok, true);
  assert.deepEqual(document.selections, [{ path, id: 'deep-local' }]);
});

test('unprovable current fiber paths, cycles and traversal limits never click a metadata row', async () => {
  const corruptions = [
    document => { document.root.current = {}; },
    document => { document.rowPairs[0].at(-1)[1].child = null; },
    document => { const chain = document.rowPairs[0]; chain.at(-2)[1].sibling = chain.at(-2)[0]; },
    document => { const node = document.rowPairs[0].at(-1)[0]; node.return = node; },
    document => { const node = document.rowPairs[0].at(-1)[1]; node.sibling = node; },
    document => { document.rowPairs[0][0][1].stateNode = {}; },
    document => { document.rowPairs[0][0][1].alternate = {}; },
    document => {
      let tail = document.menuPair[0];
      for (let depth = 0; depth < 256; depth++) tail = { return: tail };
      document.rowPairs[0].at(-1)[0].return = tail;
    },
    document => {
      let tail = document.menuPair[1].child;
      for (let count = 0; count < 2048; count++) tail = { sibling: tail };
      document.menuPair[1].child = tail;
    },
  ];
  for (const corrupt of corruptions) {
    const document = workspacePicker([{ text: path, project: project() }]);
    corrupt(document);
    assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).ok, false);
    assert.deepEqual(document.rowClicks, [0]);
    assert.deepEqual(document.selections, []);
  }
});

test('a root commit change after metadata validation prevents the row click', async () => {
  const metadata = project();
  const document = workspacePicker([{ text: path, project: metadata }]);
  const identifier = metadata.workspaceIdentifier;
  Object.defineProperty(metadata, 'workspaceIdentifier', { get() {
    document.root.current = document.roots[0];
    return identifier;
  } });
  assert.equal((await evaluateAsync(exprSelectAgentWorkspace(path), document)).ok, false);
  assert.deepEqual(document.rowClicks, [0]);
  assert.deepEqual(document.selections, []);
});

test('remote authority, missing workspace ID, SSH URI and substituted target source fail closed', () => {
  for (const metadata of [
    section([project(path, { remoteAuthority: 'ssh-remote+host' })]),
    section([project(path, { workspaceIdentifier: { uri: environment().uri } })]),
    section([project(path, { workspaceIdentifier: { id: 'ssh', uri: { scheme: 'vscode-remote', path } } })]),
    section([project()], { newAgentTargetSource: section([project('G:/other/spellcast')]) }),
  ]) {
    const document = page([metadata]);
    assert.equal(evaluate(exprCreateAgentForWorkspace(path), document).ok, false);
    assert.equal(document.clicks, 0);
  }
});

test('workspace files match their own exact URI, not one constituent directory', () => {
  const workspacePath = 'G:/projects/app.code-workspace';
  const document = page([section([project(path, { workspaceIdentifier: { id: 'multi-root', configPath: { scheme: 'file', path: '/G:/projects/app.code-workspace' } } })])]);
  assert.equal(evaluate(exprInspectWorkspaceRepository(workspacePath), document).ok, true);
  assert.equal(evaluate(exprInspectWorkspaceRepository(path), document).ok, false);
});

test('selected Agent verifies actual existing file environment and exact identity', () => {
  const document = page([], [composer()]);
  const found = evaluate(exprInspectAgentWorkspace(path, { agentId: 'local:agent-1' }), document);
  assert.equal(found.ok, true);
  assert.equal(found.agentId, 'local:agent-1');
  assert.equal(found.identitySource, 'selected_agent_existing_file_uri');
  assert.equal(evaluate(exprInspectAgentWorkspace(path, { agentId: 'other' }), document).ok, false);
  assert.equal(evaluate(exprInspectAgentWorkspace(path, { excludedAgentIds: ['agent-1'] }), document).ok, false);
  assert.equal(evaluate(exprInspectAgentWorkspace(path), page([], [composer(), composer({}, 'agent-2')])).ok, false);
});

test('empty draft is identified through its input before transcript DOM exists', () => {
  const draft = composer({ location: undefined }, 'empty-draft');
  const document = page([section([project()])], [draft], false);
  assert.equal(document.querySelectorAll('.composer-bar[data-composer-id]').length, 0);
  const found = evaluate(exprInspectAgentWorkspace(path), document);
  assert.equal(found.ok, true);
  assert.equal(found.agentId, 'local:empty-draft');
  assert.deepEqual(evaluate(exprCreateAgentForWorkspace(path), document).previousAgentIds, ['empty-draft']);
  const reused = evaluate(exprInspectAgentWorkspace(path, { excludedAgentIds: ['empty-draft'] }), document);
  assert.equal(reused.ok, false);
  assert.deepEqual(reused.observed.excludedAgentIdsMatched, ['empty-draft']);
  assert.equal(reused.observed.inputCount, 1);
});

test('input identity conflicts, extra inputs and lost focus never authorize Enter', () => {
  const input = composer();
  const document = page([], [input]);
  assert.equal(evaluate(exprInspectAgentWorkspace(path, { requireInputFocus: true }), document).ok, true);
  document.activeElement = {};
  assert.equal(evaluate(exprInspectAgentWorkspace(path, { requireInputFocus: true }), document).state, 'agent_input_focus_mismatch');
  input.parentElement = composer({}, 'different-agent');
  assert.equal(evaluate(exprInspectAgentWorkspace(path), document).ok, false);
  const ambiguous = evaluate(exprInspectAgentWorkspace(path, { agentId: 'agent-1' }), page([], [composer(), composer({}, 'agent-2')]));
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.observed.inputCount, 2);
});

test('cloud, SSH, different checkout, changed environment ID and unresolved Agent metadata cannot receive a prompt', () => {
  for (const overrides of [
    { targetEnvironment: { type: 'cloud', environment: environment() } },
    { targetEnvironment: { type: 'worktree', environment: environment() } },
    { environment: environment('G:/other/spellcast') },
    { environment: environment(path, 'different-id') },
    { environment: { id: 'workspace-spellcast', uri: { scheme: 'vscode-remote', path } } },
    { location: { type: 'worktree', environment: environment(), worktreePath: 'G:/other/spellcast' } },
    { location: { type: 'cloud', environment: environment() } },
    { targetEnvironment: undefined },
  ]) {
    const document = page([], [composer(overrides)]);
    assert.equal(evaluate(exprInspectAgentWorkspace(path), document).state, 'agent_workspace_mismatch');
  }
});

test('shared prompt fill rejects a mismatched Agent before inserting text and exposes diagnostics', async () => {
  const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
  const document = page([], [composer({ environment: environment('G:/other/spellcast') })]);
  const calls = [];
  const client = { send: async (method, params) => {
    calls.push(method);
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: JSON.stringify(evaluate(params.expression, document)) } };
  } };
  const job = { projectPath: path, targetUiFlavor: 'agents_v2', agentId: 'local:agent-1' };
  await assert.rejects(bridge._fillPrompt(client, 'must remain unsent', job), error => error.code === 'CURSOR_WORKSPACE_BINDING_FAILED' && error.confirmedNotSent === true);
  assert.deepEqual(calls, ['Runtime.evaluate']);
  assert.equal(job.workspaceBinding.state, 'agent_workspace_mismatch');
  assert.equal(job.workspaceBindingChecks.before_fill.ok, false);
});

test('submission fallback never clicks a changed workspace and retains uncertainty after Enter', async () => {
  const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
  bridge._throwIfNewProviderError = async () => {};
  bridge._verifyAgentsWorkspace = async (_client, _job, stage) => {
    assert.equal(stage, 'before_send_fallback');
    throw Object.assign(new Error('workspace changed'), { confirmedNotSent: true });
  };
  const client = { send: async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    assert.doesNotMatch(params.expression, /btn\.click\(\)/);
    return { result: { value: JSON.stringify({ inputTextLength: 30, messageCount: 0, stop: 0 }) } };
  } };
  await assert.rejects(bridge._confirmSubmission(client, 0, '', {}), error => error.sent === true && error.confirmedNotSent === false);
});
