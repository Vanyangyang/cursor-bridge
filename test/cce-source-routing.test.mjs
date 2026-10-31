import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { CursorBridge, buildContextEnginePrompt, normalizeRequestContext, buildToolDefinitions, toolErrorResult } from '../server.mjs';
import { writeCcePreferences } from '../cursor-cce-preferences.mjs';

const preference = { model: 'grok-4.7', effort: 'high' };
const answer = 'CCE_SEARCH_RESULT\nintent: 查询\ncoverage: focused | source\nevidence:\n- server.mjs:1 | symbol | evidence | source-read\ngaps: none\nconfidence: high';
const verified = { configured: true, applied: true, requestedModel: 'grok-4.7', requestedEffort: 'high', effectiveModel: 'grok-4.7', effectiveEffort: 'high', verificationSource: 'cursor_cli_init', cliModel: 'grok-4.7-high' };

function harness(t, source = 'cli') {
  const root = mkdtempSync(join(tmpdir(), 'cce-source-routing-'));
  const project = join(root, 'project'); mkdirSync(project);
  const cceSourceFile = join(root, 'source.json'); writeCcePreferences(cceSourceFile, { source });
  const calls = [];
  const bridge = new CursorBridge({ projectPath: project, cceSourceFile, runtimeFile: null, modelPreferencesFile: null, sessionFile: null,
    workspaceFile: join(root, 'workspaces.json'),
    cliInspector: async () => { calls.push('inspect'); return { brand: 'Cursor' }; },
    cliRunner: async options => {
      calls.push(['cli', options]); options.onDispatch(); options.onInit({ sessionId: 'cli-session', modelSelection: verified });
      return { result: answer, sessionId: 'cli-session', modelSelection: verified };
    },
  });
  bridge.modelPreferences = { version: 1, targets: { cce: preference, cursor_do: preference }, updatedAt: null };
  bridge._ensureCursor = async () => { calls.push('ensure-ide'); };
  bridge._run = async (prompt, job) => { calls.push(['ide', { prompt, job }]); return answer; };
  t.after(async () => { await bridge.shutdownCli(); rmSync(root, { recursive: true, force: true }); });
  return { bridge, project, calls, cceSourceFile };
}

async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await setImmediate(); }
  assert.fail('Expected asynchronous task state was not reached');
}

test('CLI and IDE use the identical CCE prompt, admission and normalized result contracts', async t => {
  const context = { sender: 'model', source: 'model' }, query = '查询调用链及证据';
  for (const source of ['cli', 'ide']) {
    const { bridge, project, calls } = harness(t, source);
    const result = await bridge.contextEngine(query, { workspacePath: project, requestContext: context });
    assert.equal(result, answer);
    const dispatch = calls.find(call => Array.isArray(call) && call[0] === source);
    assert.equal(dispatch[1].prompt, buildContextEnginePrompt(query, normalizeRequestContext(context)));
    const job = [...bridge.tasks.values()][0];
    assert.equal(job.cceSource, source);
    assert.equal(job.readOnly, true);
    assert.deepEqual(job.allowedPaths, []);
    assert.deepEqual(job.modelPreference, preference);
    assert.equal(job.resultCollectedAt != null, true);
    assert.equal(calls.includes('ensure-ide'), source === 'ide');
    assert.equal(calls.includes('inspect'), source === 'cli');
    if (source === 'cli') {
      assert.equal(job.agentId, null);
      assert.equal(job.cliSessionId, 'cli-session');
      assert.equal(job.modelSelection.applied, true);
    }
  }
});

test('CLI initializes a bound workspace without launching or registering an IDE', async t => {
  const { bridge, project, calls } = harness(t);
  bridge._ensureCursor = async () => assert.fail('CLI initialization must not launch Cursor IDE');
  const ready = await bridge.initializeWorkspace(project);
  assert.equal(ready.ready, true);
  assert.equal(ready.cceSource, 'cli');
  assert.equal(ready.workspaceBinding.ok, true);
  assert.equal(ready.workspaceBinding.identitySource, 'cursor_cli_workspace');
  assert.deepEqual(calls, ['inspect']);
  assert.equal(bridge.shouldPrewarmIde(), false);
});

test('source and model snapshots survive a source switch while a request is queued', async t => {
  const { bridge, project, calls } = harness(t);
  bridge.busy = true;
  const pending = bridge.contextEngine('queued question', { workspacePath: project });
  await until(() => bridge.queue.length === 1);
  bridge.configureCcePreferences({ action: 'set', source: 'ide' });
  bridge.modelPreferences.targets.cce = { model: 'another-fixture', effort: 'low' };
  bridge.busy = false; void bridge._drain();
  assert.equal(await pending, answer);
  const cli = calls.find(call => Array.isArray(call) && call[0] === 'cli')[1];
  assert.deepEqual(cli.modelPreference, preference);
  await bridge.contextEngine('later question', { workspacePath: project });
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'ide'));
});

test('workspace mismatch and cancelled inspection cannot dispatch a CLI query', async t => {
  const { bridge, project, calls } = harness(t);
  await assert.rejects(bridge.contextEngine('question', { workspacePath: join(project, 'wrong') }), error => error.code === 'WORKSPACE_MISMATCH');
  assert.deepEqual(calls, []);
  const controller = new AbortController();
  bridge.cliInspector = async () => { controller.abort(); return { brand: 'Cursor' }; };
  await assert.rejects(bridge.contextEngine('question', { workspacePath: project, signal: controller.signal }), error => error.code === 'CURSOR_CLI_CANCELLED' && error.confirmedNotSent);
  assert.equal(bridge.tasks.size, 0);
});

test('CLI failures retain their task identity without an IDE fallback or resubmission', async t => {
  const { bridge, project, calls } = harness(t);
  const failure = Object.assign(new Error('CLI unavailable fixture'), { code: 'CURSOR_CLI_PROTOCOL_ERROR', confirmedTerminal: true });
  bridge.cliRunner = async () => { throw failure; };
  await assert.rejects(bridge.contextEngine('question', { workspacePath: project }), error => error === failure);
  assert.equal(bridge.tasks.get(failure.taskId).status, 'failed');
  assert.equal(calls.includes('ensure-ide'), false);
  const payload = toolErrorResult(failure).structuredContent;
  assert.equal(payload.error.code, failure.code);
  assert.equal(payload.taskId, failure.taskId);
});

test('CLI cancellation and host disconnect stop the owned execution without a UI Stop', async t => {
  for (const action of ['cancel', 'disconnect']) {
    const { bridge, project } = harness(t);
    bridge.cliRunner = options => new Promise((resolve, reject) => {
      options.onDispatch(); options.onInit({ sessionId: 'owned-cli-session', modelSelection: verified });
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled fixture'), { cancelled: true, stopConfirmed: true, confirmedTerminal: true })), { once: true });
    });
    bridge._stopParallelAgent = async () => assert.fail('A CLI session must never use Agent History Stop');
    const pending = bridge.contextEngine('question', { workspacePath: project });
    const rejected = assert.rejects(pending, error => error.cancelled);
    await until(() => bridge.currentJob?.cliAbortController);
    const job = bridge.currentJob;
    if (action === 'cancel') await bridge.taskControl(job.id, { action: 'cancel', confirm: true });
    else await bridge.shutdownCli();
    await rejected;
    assert.equal(job.status, 'cancelled');
    assert.equal(job.underlyingStopConfirmed, true);
  }
});

test('the source tool is explicit and invalid source input cannot change preferences', t => {
  const { bridge } = harness(t);
  const tool = buildToolDefinitions(bridge).find(tool => tool.name === 'cursor_cce');
  assert.deepEqual(tool.inputSchema.properties.source.enum, ['ide', 'cli']);
  assert.throws(() => bridge.configureCcePreferences({ action: 'set', source: 'auto' }));
  assert.equal(bridge.ccePreferencesView().cceSource, 'cli');
});

test('a cancelled queued CLI request settles even when the preceding queue cannot advance', async t => {
  const { bridge, project } = harness(t);
  bridge.busy = true;
  const controller = new AbortController();
  const pending = bridge.contextEngine('queued question', { workspacePath: project, signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.code === 'CURSOR_CLI_CANCELLED' && error.confirmedNotSent);
  await until(() => bridge.queue.length === 1);
  const job = bridge.queue[0]; controller.abort();
  await rejected;
  assert.equal(job.status, 'cancelled'); assert.equal(bridge.queue.length, 0);
});

test('unconfirmed CLI cancellation keeps the task identity and global reservation in its error', async t => {
  const { bridge, project } = harness(t);
  const failure = Object.assign(new Error('CLI stop unconfirmed fixture'), {
    code: 'CURSOR_CLI_CANCELLED', cancelled: true, stopConfirmed: false,
    confirmedTerminal: false, sent: true, cliProcessId: 12345,
  });
  bridge.cliRunner = options => new Promise((resolve, reject) => {
    options.onDispatch(); options.onInit({ sessionId: 'owned-cli-session', modelSelection: verified });
    options.signal.addEventListener('abort', () => reject(failure), { once: true });
  });
  const pending = bridge.contextEngine('question', { workspacePath: project });
  const rejected = assert.rejects(pending, error => error === failure);
  await until(() => bridge.currentJob?.cliAbortController);
  const job = bridge.currentJob;
  await bridge.taskControl(job.id, { action: 'cancel', confirm: true }); await rejected;
  const payload = toolErrorResult(failure).structuredContent;
  assert.equal(payload.taskId, job.id); assert.equal(payload.cliProcessId, 12345);
  assert.equal(payload.confirmedTerminal, false); assert.equal(payload.error.code, 'CURSOR_CLI_CANCELLED');
  assert.equal(bridge.activeParallel.has(job.id), true);
  assert.equal(job.reservationScope, 'global');
});

test('shutdown aborts and waits for CLI inspections before either initialization or query enqueue', async t => {
  for (const operation of ['query', 'initialize']) {
    const { bridge, project } = harness(t);
    let signal, finish;
    bridge.cliInspector = options => {
      signal = options.signal;
      return new Promise((resolve, reject) => { finish = () => reject(Object.assign(new Error('inspection cancelled fixture'), { code: 'CURSOR_CLI_CANCELLED', confirmedNotSent: true })); });
    };
    const pending = operation === 'query' ? bridge.contextEngine('question', { workspacePath: project }) : bridge.initializeWorkspace(project);
    const rejected = assert.rejects(pending, error => error.code === 'CURSOR_CLI_CANCELLED');
    await until(() => !!signal);
    let settled = false;
    const shutdown = bridge.shutdownCli().then(() => { settled = true; });
    await setImmediate(); assert.equal(signal.aborted, true); assert.equal(settled, false);
    finish(); await shutdown; await rejected;
    assert.equal(bridge.cliInspections.size, 0); assert.equal(bridge.tasks.size, 0);
  }
});

test('an inspection resolving after shutdown cannot enqueue or dispatch a CLI query', async t => {
  const { bridge, project, calls } = harness(t);
  let shutdown;
  bridge.cliInspector = async () => { shutdown = bridge.shutdownCli(); return { brand: 'Cursor' }; };
  await assert.rejects(bridge.contextEngine('question', { workspacePath: project }), error => error.code === 'CURSOR_CLI_CANCELLED' && error.confirmedNotSent);
  await shutdown;
  assert.equal(bridge.tasks.size, 0);
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'cli'), false);
});

test('CLI status uses cached metadata without depending on a live IDE connection', async t => {
  const { bridge, project } = harness(t);
  let finish;
  bridge.cliRunner = options => new Promise(resolve => {
    options.onDispatch(); options.onInit({ sessionId: 'status-cli-session', modelSelection: verified });
    finish = () => resolve({ result: answer, sessionId: 'status-cli-session', modelSelection: verified });
  });
  const pending = bridge.contextEngine('question', { workspacePath: project });
  await until(() => !!finish);
  const status = await bridge.status();
  assert.equal(status.statusPath, 'cli-metadata'); assert.equal(status.connected, true);
  assert.equal(status.cli.available, true); assert.ok(status.cli.checkedAt);
  assert.equal(status.busy, true); assert.equal(status.uiBusy, false); assert.equal(status.idle, false);
  finish(); await pending;
});
