import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorBridge, exprCreateAgentForWorkspace, exprInspectWorkspaceRepository, exprInspectAgentWorkspace } from '../server.mjs';

const path = 'G:/VibeProj/spellcast';
const environment = (localPath = path, id = 'workspace-spellcast') => ({ id, uri: { scheme: 'file', path: localPath } });
const project = (localPath = path, extra = {}) => ({ type: 'workspace', workspaceIdentifier: environment(localPath), ...extra });
const section = (projects, extra = {}) => ({ id: 'repo:github.com/vanyangyang/spellcast', displayName: 'vanyangyang/spellcast', projects, headers: [], ...extra });
const evaluate = (expression, document) => JSON.parse(Function('document', `return ${expression}`)(document));

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

test('multiple registrations and multiple targets in one section fail without a click', () => {
  for (const sections of [
    [section([project()]), section([project()])],
    [section([project()]), section([project()], { id: 'repo:another/alias' })],
    [section([project(), project()])],
    [section([project(), project('G:/other/spellcast')])],
    [section([{ type: 'repo', repoUrls: ['github.com/vanyangyang/spellcast'] }, project()])],
  ]) {
    const document = page(sections);
    const result = evaluate(exprCreateAgentForWorkspace(path), document);
    assert.equal(result.ok, false);
    assert.match(result.state, /ambiguous/);
    assert.equal(document.clicks, 0);
  }
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
