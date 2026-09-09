import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CursorBridge } from '../server.mjs';

class OfflineBridge extends CursorBridge {
  constructor(options = {}) {
    super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null,
      sessionFile: null, projectPath: process.cwd(), ...options });
  }
  async _ensureCursor() {}
  _drain() {}
}

async function finishedTask(bridge, result = '完整结果 😀') {
  const receipt = await bridge.doTask('只读测试', { readOnly: true });
  const job = bridge.tasks.get(receipt.taskId);
  job.agentId = 'exact-test-agent';
  bridge._finishJob(job, result);
  return job;
}

test('compact status never delivers or acknowledges a result; explicit full reads are repeatable', async () => {
  const bridge = new OfflineBridge();
  const job = await finishedTask(bridge);
  const short = await bridge.status(job.id);
  assert.equal(short.status, 'completed');
  assert.equal(short.agentId, job.agentId);
  assert.equal(Object.hasOwn(short, 'result'), false);
  assert.equal(job.resultCollectedAt ?? null, null);
  job.result = '结果 😀\n'.repeat(100000);
  const long = await bridge.status(job.id);
  assert.ok(JSON.stringify(long).length < JSON.stringify(short).length + 30,
    'compact size must not grow with the body');
  assert.equal(job.resultCollectedAt ?? null, null);
  const full = await bridge.status(job.id, { detail: 'full' });
  assert.equal(full.result, job.result);
  assert.ok(job.resultCollectedAt);
  const receiptTime = job.resultCollectedAt;
  assert.equal((await bridge.status(job.id, { detail: 'full' })).result, job.result);
  assert.equal(job.resultCollectedAt, receiptTime);
  assert.equal(Object.hasOwn(await bridge.status(job.id), 'result'), false);
});

test('task control of an already terminal task does not silently consume its reply', async () => {
  const bridge = new OfflineBridge();
  const job = await finishedTask(bridge, 'still unread');
  for (const action of ['reap', 'cancel', 'abandon']) {
    const controlled = await bridge.taskControl(job.id, {
      action, confirm: true, expectedAgentId: job.agentId,
      reason: 'terminal task test', acknowledgeMayStillWrite: true,
    });
    assert.equal(controlled.task.taskId, job.id);
    assert.equal(Object.hasOwn(controlled.task, 'result'), false);
    assert.equal(job.resultCollectedAt ?? null, null);
  }
  assert.equal((await bridge.status(job.id, { detail: 'full' })).result, 'still unread');
});

test('result-only reads preserve exact text, acknowledge delivery and remain repeatable', async () => {
  const bridge = new OfflineBridge();
  const body = '  正文 😀\n{"result":"text, not a wrapper"}\n';
  const job = await finishedTask(bridge, body);
  assert.equal(await bridge.status(job.id, { detail: 'result' }), body);
  assert.ok(job.resultCollectedAt);
  const collectedAt = job.resultCollectedAt;
  assert.equal(await bridge.status(job.id, { detail: 'result' }), body);
  assert.equal((await bridge.status(job.id, { detail: 'full' })).result, body);
  assert.equal(job.resultCollectedAt, collectedAt);
});

test('result-only rejects missing, running and unavailable tasks without recording receipt', async () => {
  const bridge = new OfflineBridge();
  await assert.rejects(bridge.status('', { detail: 'result' }), /RESULT_TASK_REQUIRED/);
  await assert.rejects(bridge.status('missing', { detail: 'result' }), /RESULT_TASK_NOT_FOUND/);
  const receipt = await bridge.doTask('pending', { readOnly: true });
  const job = bridge.tasks.get(receipt.taskId);
  job.result = 'partial text';
  await assert.rejects(bridge.status(job.id, { detail: 'result' }), /RESULT_NOT_AVAILABLE/);
  assert.equal(job.resultCollectedAt ?? null, null);
  job.status = 'completed';
  job.result = null;
  await assert.rejects(bridge.status(job.id, { detail: 'result' }), /RESULT_NOT_AVAILABLE/);
  assert.equal(job.resultCollectedAt ?? null, null);
});

test('asynchronous idempotent retry stays metadata-only while synchronous retry collects the body', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-compact-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bridge = new OfflineBridge({ sessionFile: join(directory, 'sessions.json') });
  const created = await bridge.doTask('first', { sessionMode: 'create', readOnly: true });
  const first = bridge.tasks.get(created.taskId);
  first.agentId = 'persistent-exact-agent';
  bridge._bindSessionAgent(first);
  bridge._finishJob(first, 'first reply');
  await bridge.status(first.id, { detail: 'full' });
  const options = { sessionMode: 'continue', sessionId: created.sessionId,
    readOnly: true, readOnlySpecified: true, requestId: 'same-request' };
  const second = await bridge.doTask('second', options);
  const job = bridge.tasks.get(second.taskId);
  bridge._finishJob(job, 'second reply');
  const count = bridge.tasks.size;
  const duplicate = await bridge.doTask('retry', options);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.taskId, job.id);
  assert.equal(Object.hasOwn(duplicate, 'result'), false);
  assert.equal(job.resultCollectedAt ?? null, null);
  assert.equal(bridge.tasks.size, count);
  const delivered = await bridge.doTask('retry and collect', { ...options, background: false });
  assert.equal(delivered.result, 'second reply');
  assert.ok(job.resultCollectedAt);
  assert.equal(bridge.tasks.size, count);
});

test('synchronous submission still delivers its complete reply', async () => {
  const bridge = new OfflineBridge();
  bridge._drain = () => {
    const job = bridge.queue.shift();
    if (job) bridge._finishJob(job, 'synchronous complete reply');
  };
  const completed = await bridge.doTask('sync', { readOnly: true, background: false });
  assert.equal(completed.result, 'synchronous complete reply');
  assert.ok(bridge.tasks.get(completed.taskId).resultCollectedAt);
});

test('global compact lists active tasks once and never expands recent task bodies or healthy diagnostics', async () => {
  const bridge = new OfflineBridge();
  for (let index = 0; index < 10; index++) {
    const job = await finishedTask(bridge, 'private body '.repeat(10000));
    job.workspaceBindingChecks = { trace: 'healthy diagnostic '.repeat(10000) };
  }
  const receipt = await bridge.doTask('active', { readOnly: true });
  const active = bridge.tasks.get(receipt.taskId);
  active.reservationScope = 'global';
  bridge.activeParallel.set(active.id, active);
  const compact = await bridge.status();
  assert.equal(compact.activeParallel.length, 1);
  assert.equal(compact.recentTasks.length, 10);
  assert.equal(compact.recentTasks.some(job => job.taskId === active.id), false);
  assert.equal(compact.globallyBlocked, true);
  assert.ok(compact.blockingTaskIds.includes(active.id));
  assert.equal(compact.unreadResultTaskIds.length, 10);
  const serialized = JSON.stringify(compact);
  assert.doesNotMatch(serialized, /private body|healthy diagnostic/);
  assert.ok(serialized.length < 10000, 'global output must remain task summaries');
  await bridge.status('', { detail: 'full' });
  for (const job of bridge.tasks.values()) assert.equal(job.resultCollectedAt ?? null, null);
});

test('compact orphan status keeps safety, model application and recovery evidence', async () => {
  const bridge = new OfflineBridge();
  const receipt = await bridge.doTask('review', { readOnly: true });
  const job = bridge.tasks.get(receipt.taskId);
  Object.assign(job, { status: 'needs_attention', phase: 'orphaned', agentId: 'bound-agent',
    reservationScope: 'global', sendState: 'sent', recoveryState: 'terminal_result_uncollected',
    resultUnavailable: true, underlyingStopConfirmed: false, terminalEvidence: 'stable_completed_history_icon',
    error: 'reply hydration failed', modelSelection: { applied: true, requestedModel: 'Pinned',
      effectiveModel: 'Pinned High', requestedEffort: 'high', effectiveEffort: 'high' } });
  bridge.activeParallel.set(job.id, job);
  const status = await bridge.status(job.id);
  for (const key of ['agentId', 'sendState', 'reservationScope', 'recoveryState', 'resultUnavailable',
    'underlyingStopConfirmed', 'terminalEvidence', 'error']) assert.equal(status[key], job[key], key);
  assert.equal(status.reservationHeld, true);
  assert.equal(status.blocksAll, true);
  assert.equal(status.blocksFifo, true);
  assert.match(status.attention, /Retry with reap/);
  assert.equal(status.modelSelection.applied, true);
  assert.equal(status.modelSelection.effectiveModel, 'Pinned High');
});

test('bundled MCP exposes compact/full and preserves disconnected/error semantics', async () => {
  const client = new Client({ name: 'compact-contract-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url))],
    env: { ...process.env, CURSOR_BRIDGE_NO_AUTOLAUNCH: '1', CURSOR_BRIDGE_CDP_PORT: '1' } });
  const call = (args) => client.callTool({ name: 'cursor_status', arguments: args });
  try {
    await client.connect(transport);
    const definitions = await client.listTools();
    assert.deepEqual(definitions.tools.find(t => t.name === 'cursor_status').inputSchema.properties.detail.enum,
      ['compact', 'full', 'result']);
    const compact = JSON.parse((await call({})).content[0].text);
    const full = JSON.parse((await call({ detail: 'full' })).content[0].text);
    assert.equal(compact.connected, false);
    assert.ok(compact.error);
    assert.equal(full.connected, false);
    assert.ok(full.runtimeFile);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length);
    for (const detail of ['typo', null, 3]) assert.equal((await call({ detail })).isError, true);
    for (const args of [{ detail: 'result' }, { detail: 'result', session_id: 'session' },
      { detail: 'result', task_id: 'missing' }]) assert.equal((await call(args)).isError, true);
    assert.equal((await call({ task_id: 'missing', session_id: 'also-missing' })).isError, true);
    const missing = JSON.parse((await call({ task_id: 'missing' })).content[0].text);
    assert.equal(missing.found, false);
    assert.equal(missing.taskId, 'missing');
  } finally {
    await client.close();
  }
});
