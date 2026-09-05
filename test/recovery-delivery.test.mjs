import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorBridge, isSessionTurnReplyReady } from '../server.mjs';
import { updateCursorSessionRegistry } from '../cursor-session-registry.mjs';
import { writeWorkspaceBinding } from '../workspace-binding.mjs';

class OfflineBridge extends CursorBridge {
  constructor(options = {}) {
    super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null, runtimeMode: 'normal', ...options });
  }
  async _ensureCursor() {}
  _drain() {}
}

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-recovery-delivery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function recoveredSession(t) {
  const sessionFile = join(temporary(t), 'sessions.json');
  const sender = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  const created = await sender.doTask('review only', { sessionMode: 'create', readOnly: true });
  const job = sender.tasks.get(created.taskId);
  job.agentId = 'exact-recovery-agent';
  sender._bindSessionAgent(job);
  const bridge = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  bridge._readStableParallelEntry = async () => ({ stable: true, entry: { id: job.agentId, showSpinner: false, icon: 'check-circled' } });
  await bridge.sessionControl(created.sessionId, { action: 'reconcile' });
  return { bridge, created, sessionFile };
}

test('completed Agent with an uncollected reply retains the specific reap guidance', () => {
  const bridge = new OfflineBridge();
  const job = { id: 'finished-agent', status: 'running', execution: 'fifo', agentId: 'exact-agent', readOnly: true };
  bridge._reapWithoutResult(job, new Error('reply not hydrated'), 'stable_completed_history_icon');
  assert.equal(job.recoveryState, 'terminal_result_uncollected');
  assert.equal(job.resultUnavailable, true);
  assert.match(bridge._taskView(job).attention, /Retry with reap/);
});

test('reconciled sessions can explicitly collect the completed reply without resending or persisting it', async (t) => {
  const { bridge, created, sessionFile } = await recoveredSession(t);
  await assert.rejects(bridge.doTask('next turn', {
    sessionMode: 'continue', sessionId: created.sessionId, readOnly: true, readOnlySpecified: true,
  }), /SESSION_RESULT_UNCOLLECTED/);
  bridge._collectParallelAgent = async (probe) => {
    assert.equal(probe.agentId, 'exact-recovery-agent');
    return 'recovered-private-answer';
  };
  const result = await bridge.sessionControl(created.sessionId, { action: 'collect_result' });
  assert.equal(result.action, 'collect_result');
  assert.equal(result.result, 'recovered-private-answer');
  assert.equal(result.resultPersisted, false);
  assert.equal(bridge.tasks.size, 0);
  assert.equal(result.recoveryState, 'reconciled_result_collected');
  assert.doesNotMatch(readFileSync(sessionFile, 'utf8'), /recovered-private-answer/);
  bridge._collectParallelAgent = async () => assert.fail('an already collected turn must not read a later manual reply');
  const repeated = await bridge.sessionControl(created.sessionId, { action: 'collect_result' });
  assert.equal(repeated.state, 'already_collected');
  assert.equal(repeated.result, undefined);
  const continued = await bridge.doTask('next turn', {
    sessionMode: 'continue', sessionId: created.sessionId, readOnly: true, readOnlySpecified: true,
  });
  assert.equal(continued.sessionTurn, 2);
});

test('reply collection refuses running Agents and does not overwrite failed retrieval metadata', async (t) => {
  const { bridge, created, sessionFile } = await recoveredSession(t);
  const before = readFileSync(sessionFile, 'utf8');
  bridge._readStableParallelEntry = async () => ({ stable: true, entry: { id: 'exact-recovery-agent', showSpinner: true, icon: 'check-circled' } });
  bridge._collectParallelAgent = async () => assert.fail('must not read an active turn');
  await assert.rejects(bridge.sessionControl(created.sessionId, { action: 'collect_result' }), /SESSION_RESULT_NOT_READY/);
  assert.equal(readFileSync(sessionFile, 'utf8'), before);
  bridge._readStableParallelEntry = async () => ({ stable: true, entry: { id: 'exact-recovery-agent', showSpinner: false, icon: 'check-circled' } });
  bridge._collectParallelAgent = async (probe) => {
    probe.uiDiagnostic = { selectionRestore: { state: 'failed' } };
    throw new Error('hydration failed');
  };
  await assert.rejects(bridge.sessionControl(created.sessionId, { action: 'collect_result' }), (error) => {
    assert.match(error.message, /hydration failed/);
    assert.equal(error.uiDiagnostic.selectionRestore.state, 'failed');
    return true;
  });
  assert.equal(readFileSync(sessionFile, 'utf8'), before);
});

test('reply collection discards a result when another sender advances the session epoch', async (t) => {
  const { bridge, created, sessionFile } = await recoveredSession(t);
  bridge._collectParallelAgent = async () => {
    updateCursorSessionRegistry(sessionFile, (registry) => { registry.sessions[created.sessionId].epoch++; });
    return 'must-not-deliver-stale-reply';
  };
  const result = await bridge.sessionControl(created.sessionId, { action: 'collect_result' });
  assert.equal(result.state, 'stale_observation');
  assert.equal(result.result, undefined);
});

test('automatic monitoring recovery shares the original submission deadline', async () => {
  const bridge = new OfflineBridge();
  const job = { id: 'expired', status: 'running', timeoutMs: 30000, sentAt: new Date(Date.now() - 60000).toISOString(), monitorGeneration: 1 };
  const deadline = bridge._taskWaitDeadline(job);
  bridge.activeParallel.set(job.id, job);
  bridge._readParallelEntry = async () => assert.fail('expired recovery must not start another waiting cycle');
  await assert.rejects(bridge._monitorParallelAgent(job, 1), /timed out/);
  assert.equal(bridge._taskWaitDeadline(job), deadline);
});

test('unread terminal replies block further submissions instead of being silently evicted', async (t) => {
  const bridge = new OfflineBridge({ sessionFile: join(temporary(t), 'sessions.json'), projectPath: process.cwd() });
  for (let index = 0; index < 50; index++) bridge.tasks.set(`old-${index}`, { id: `old-${index}`, status: 'completed', result: `answer-${index}` });
  await assert.rejects(bridge.doTask('new session', { sessionMode: 'create', readOnly: true }), /TASK_RETENTION_FULL/);
  assert.equal(bridge.tasks.size, 50);
  assert.equal(bridge._readSession('anything'), null);
  const collected = await bridge.status('old-0');
  assert.equal(collected.result, 'answer-0');
  const next = await bridge.doTask('new session', { sessionMode: 'create', readOnly: true });
  assert.ok(next.sessionId);
  assert.equal(bridge.tasks.size, 50);
  assert.equal(bridge.tasks.has('old-0'), false);
  assert.equal(bridge.tasks.has('old-1'), true);
});

test('an ambiguous saved default workspace must be explicitly initialized before submission', async (t) => {
  const root = temporary(t);
  const workspaceFile = join(root, 'workspaces.json');
  writeWorkspaceBinding(workspaceFile, 'default', root);
  const bridge = new OfflineBridge({ workspaceFile, workspaceKey: 'default' });
  assert.equal(bridge.workspaceView().workspaceConfirmationRequired, true);
  await assert.rejects(bridge.contextEngine('review'), /WORKSPACE_CONFIRMATION_REQUIRED/);
  await assert.rejects(bridge.doTask('review', { readOnly: true }), /WORKSPACE_CONFIRMATION_REQUIRED/);
  await bridge.initializeWorkspace(root);
  assert.equal(bridge.workspaceView().workspaceConfirmationRequired, false);
  assert.ok((await bridge.doTask('review', { readOnly: true })).taskId);
});

test('collection restores the original Agent on errors without hiding the original error', async () => {
  const bridge = new OfflineBridge();
  bridge._readAgentEntries = async () => [{ id: 'user-agent', isSelected: true }];
  const restored = [];
  bridge._requestExactAgentSelection = async (_client, id) => { restored.push(id); return 'OPENED'; };
  bridge._waitForSelectedAgent = async (_client, id) => assert.equal(id, 'user-agent');
  const failure = new Error('reply hydration failed');
  await assert.rejects(bridge._withRestoredAgentSelection({}, { agentId: 'recovery-agent' }, async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(restored, ['user-agent']);
  bridge._requestExactAgentSelection = async () => { throw new Error('restore failed'); };
  const job = { agentId: 'recovery-agent' };
  await assert.rejects(bridge._withRestoredAgentSelection({}, job, async () => { throw failure; }), (error) => error === failure);
  assert.equal(job.uiDiagnostic.selectionRestore.state, 'failed');
});

test('ordinary task views omit replies and exact reads record receipt', async () => {
  const bridge = new OfflineBridge();
  const job = { id: 'private-result', status: 'completed', result: 'private reply' };
  bridge.tasks.set(job.id, job);
  assert.equal(bridge._taskView(job).result, undefined);
  assert.equal(job.resultCollectedAt, undefined);
  assert.equal((await bridge.status(job.id)).result, 'private reply');
  assert.ok(job.resultCollectedAt);
});

test('completion before first result read remains recoverable after adapter restart', async (t) => {
  const sessionFile = join(temporary(t), 'sessions.json');
  const sender = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  const created = await sender.doTask('background task', { sessionMode: 'create', readOnly: true });
  const job = sender.tasks.get(created.taskId);
  job.agentId = 'unread-completed-agent';
  sender._bindSessionAgent(job);
  sender._finishJob(job, 'unread original reply');
  const restarted = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  await assert.rejects(restarted.doTask('next turn', { sessionMode: 'continue', sessionId: created.sessionId, readOnly: true, readOnlySpecified: true }), /SESSION_RECONCILE_REQUIRED/);
  restarted._readStableParallelEntry = async () => ({ stable: true, entry: { id: job.agentId, showSpinner: false, icon: 'check-circled' } });
  assert.equal((await restarted.sessionControl(created.sessionId, { action: 'reconcile' })).state, 'completed');
  restarted._collectParallelAgent = async () => 'unread original reply';
  assert.equal((await restarted.sessionControl(created.sessionId, { action: 'collect_result' })).result, 'unread original reply');
});

test('read receipts survive restart and ordinary completed sessions cannot collect arbitrary latest replies', async (t) => {
  const sessionFile = join(temporary(t), 'sessions.json');
  const sender = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  const created = await sender.doTask('task', { sessionMode: 'create', readOnly: true });
  const job = sender.tasks.get(created.taskId);
  job.agentId = 'read-completed-agent';
  sender._bindSessionAgent(job);
  sender._finishJob(job, 'delivered reply');
  await assert.rejects(sender.doTask('next turn', { sessionMode: 'continue', sessionId: created.sessionId, readOnly: true, readOnlySpecified: true }), /SESSION_RESULT_UNCOLLECTED/);
  await sender.status(job.id);
  const restarted = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  restarted._collectParallelAgent = async () => assert.fail('normal ready session must not read arbitrary latest replies');
  await assert.rejects(restarted.sessionControl(created.sessionId, { action: 'collect_result' }), /SESSION_RESULT_NOT_READY/);
  const next = await restarted.doTask('next turn', { sessionMode: 'continue', sessionId: created.sessionId, readOnly: true, readOnlySpecified: true });
  assert.equal(next.sessionTurn, 2);
});

test('continued-turn numeric baselines survive restart and reject the prior reply during hydration', async (t) => {
  const sessionFile = join(temporary(t), 'sessions.json');
  const sender = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  const created = await sender.doTask('first turn', { sessionMode: 'create', readOnly: true });
  const first = sender.tasks.get(created.taskId);
  first.agentId = 'baseline-agent';
  sender._bindSessionAgent(first);
  sender._finishJob(first, 'first private reply');
  await sender.status(first.id);
  const continued = await sender.doTask('second turn', { sessionMode: 'continue', sessionId: created.sessionId, readOnly: true, readOnlySpecified: true });
  const second = sender.tasks.get(continued.taskId);
  const baseline = { messageCount: 2, replyLength: 19, replyHash: 12345 };
  second.responseBaseline = baseline;
  sender._persistSessionResponseBaseline(second);
  assert.throws(() => sender._persistSessionResponseBaseline({ ...second, sessionEpoch: second.sessionEpoch - 1 }), /SESSION_STALE_SENDER/);
  assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')).sessions[created.sessionId].responseBaseline, baseline);
  assert.doesNotMatch(readFileSync(sessionFile, 'utf8'), /first private reply/);
  const restarted = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  restarted._readStableParallelEntry = async () => ({ stable: true, entry: { id: second.agentId, showSpinner: false, icon: 'check-circled' } });
  await restarted.sessionControl(created.sessionId, { action: 'reconcile' });
  restarted._collectParallelAgent = async (probe) => {
    assert.deepEqual(probe.responseBaseline, baseline);
    assert.equal(isSessionTurnReplyReady(probe.responseBaseline, baseline), false);
    assert.equal(isSessionTurnReplyReady(probe.responseBaseline, { ...baseline, replyHash: 67890 }), true);
    return 'second private reply';
  };
  assert.equal((await restarted.sessionControl(created.sessionId, { action: 'collect_result' })).result, 'second private reply');
  assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).sessions[created.sessionId].responseBaseline, undefined);
});
