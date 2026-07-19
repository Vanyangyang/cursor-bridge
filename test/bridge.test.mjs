import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  CursorBridge,
  DELEGATION_POLICIES,
  normalizeAllowedPath,
  normalizeDelegationMode,
  normalizeDelegationPolicy,
  pathsOverlap,
  selectNewAgentEntry,
  exprClickSelectedAgentStop,
  isTargetedStopConfirmed,
  updateStableEntryObservation,
  classifyParallelTerminalIcon,
} from '../server.mjs';

class OfflineBridge extends CursorBridge {
  constructor(options = {}) {
    const defaultPolicy = Object.prototype.hasOwnProperty.call(options, 'delegationPolicy')
      ? {}
      : { delegationPolicy: 'active' };
    super({ policyFile: null, ...defaultPolicy, ...options });
  }

  async _ensureCursor() {}
  _drain() {}
}

class TaskControlBridge extends OfflineBridge {
  constructor(options = {}) {
    super(options);
    this.entrySnapshots = [];
    this.collectResult = 'recovered result';
    this.collectError = null;
    this.stopResult = { confirmed: true, clicked: true, state: 'stopped' };
    this.monitorStarts = 0;
  }

  async _readParallelEntry() {
    if (this.entrySnapshots.length === 0) return null;
    if (this.entrySnapshots.length === 1) return this.entrySnapshots[0];
    return this.entrySnapshots.shift();
  }

  async _collectParallelAgent() {
    if (this.collectError) throw this.collectError;
    return this.collectResult;
  }

  async _stopParallelAgent() {
    return this.stopResult;
  }

  _startParallelMonitor(job) {
    this.monitorStarts++;
    job.monitorAttached = true;
    return true;
  }

  _maybeRestoreParallelOrigin() {}
}

class DeferredSubmitBridge extends CursorBridge {
  constructor() {
    super({ policyFile: null, delegationPolicy: 'active' });
    this.stopCalls = 0;
    this.monitorStarts = 0;
    this.submitStarted = new Promise((resolve) => { this._markSubmitStarted = resolve; });
    this.submitGate = new Promise((resolve) => { this._resolveSubmit = resolve; });
  }

  async _ensureCursor() {}
  async _submitParallelAgent(job) {
    job.agentId = 'local:prebound-before-return';
    job.agentLabel = 'prebound';
    this._markSubmitStarted();
    return this.submitGate;
  }
  async _stopParallelAgent() {
    this.stopCalls++;
    return { confirmed: true, clicked: true, state: 'stopped' };
  }
  _startParallelMonitor() {
    this.monitorStarts++;
    return true;
  }
  _maybeRestoreParallelOrigin() {}
}

class MonitorGenerationBridge extends OfflineBridge {
  constructor() {
    super();
    this.gates = new Map();
  }

  _monitorParallelAgent(job, generation) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    this.gates.set(generation, { promise, resolve });
    return promise;
  }
}

class SentFifoFailureBridge extends CursorBridge {
  constructor() {
    super({ policyFile: null, delegationPolicy: 'active' });
  }

  async _ensureCursor() {}
  async _run() {
    const error = new Error('post-send response unavailable');
    error.sent = true;
    throw error;
  }
  _maybeRestoreParallelOrigin() {}
}

class CancellableFifoBridge extends CursorBridge {
  constructor({ fallback = false } = {}) {
    super({ policyFile: null, delegationPolicy: 'active' });
    this.fallback = fallback;
    this.runStarted = new Promise((resolve) => { this._markRunStarted = resolve; });
  }

  async _ensureCursor() {}
  async _submitParallelAgent() {
    return { fallbackReason: this.fallback ? 'parallel capability unavailable' : null };
  }
  async _run(prompt, job) {
    this._markRunStarted();
    while (!job.cancelRequested) await new Promise((resolve) => setTimeout(resolve, 1));
    const error = new Error(job.cancelReason || 'cancelled');
    error.cancelled = true;
    error.stopConfirmed = false;
    error.sent = true;
    throw error;
  }
  _maybeRestoreParallelOrigin() {}
}

function makeOrphan(bridge, view, options = {}) {
  const job = bridge.tasks.get(view.taskId);
  bridge.queue = bridge.queue.filter((candidate) => candidate.id !== job.id);
  job.status = 'running';
  job.phase = 'running';
  job.startedAt = new Date().toISOString();
  job.agentId = options.agentId === undefined ? 'local:test-agent' : options.agentId;
  bridge._orphanParallelJob(job, new Error(options.error || 'history unavailable'));
  return job;
}

function createTempPolicyFile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'policy.json');
}

async function openBundledClient(serverPath, env, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('allowed path normalization and prefix overlap are deterministic', () => {
  assert.equal(normalizeAllowedPath('Assets\\Scripts\\'), 'assets/scripts');
  assert.equal(normalizeAllowedPath('./Assets//Scripts/../Scripts/Battle'), 'assets/scripts/battle');
  assert.equal(pathsOverlap('Assets/Scripts', 'assets/scripts/Battle'), true);
  assert.equal(pathsOverlap('Assets/Foo', './Assets/Bar/../Foo'), true);
  assert.equal(pathsOverlap('Assets/Scripts/A', 'Assets/Scripts/B'), false);
  assert.equal(pathsOverlap('.', 'Assets/Scripts'), true);
});

test('delegation mode recognizes only explicit off and otherwise stays enabled', () => {
  assert.equal(normalizeDelegationMode('off'), 'off');
  assert.equal(normalizeDelegationMode(' OFF '), 'off');
  assert.equal(normalizeDelegationMode('on'), 'on');
  assert.equal(normalizeDelegationMode('false'), 'on');
  assert.equal(normalizeDelegationMode(''), 'on');
});

test('delegation policy exposes four human-facing collaboration levels and maps legacy on to active', () => {
  assert.deepEqual(DELEGATION_POLICIES, ['manual', 'auto', 'active', 'eager']);
  assert.equal(normalizeDelegationPolicy('off'), 'active');
  assert.equal(normalizeDelegationPolicy('off', ''), '');
  assert.equal(normalizeDelegationPolicy(' MANUAL '), 'manual');
  assert.equal(normalizeDelegationPolicy('auto'), 'auto');
  assert.equal(normalizeDelegationPolicy('active'), 'active');
  assert.equal(normalizeDelegationPolicy('eager'), 'eager');
  assert.equal(normalizeDelegationPolicy('on'), 'active');
  assert.equal(normalizeDelegationPolicy('unknown'), 'active');
});

test('session policy changes how readily Cursor should help without becoming an on-off switch', () => {
  const bridge = new OfflineBridge({ delegationPolicy: 'active' });
  assert.equal(bridge.delegationPolicyView().policy, 'active');
  assert.equal(bridge.delegationEnabled, true);

  const selective = bridge.setDelegationPolicy('manual', 'session');
  assert.equal(selective.scope, 'session');
  assert.equal(selective.previousPolicy, 'active');
  assert.equal(selective.policySource, 'runtime');
  assert.equal(selective.runningTasksUnchanged, true);
  assert.equal(selective.delegationEnabled, true);
  assert.match(selective.guidance, /waits until the user asks/);

  const enabled = bridge.setDelegationPolicy('eager', 'session');
  assert.equal(enabled.policy, 'eager');
  assert.equal(enabled.delegationEnabled, true);
  assert.match(enabled.guidance, /in parallel/);
  assert.throws(() => bridge.setDelegationPolicy('frequency=3'), /unsupported delegation policy/);
  assert.throws(() => bridge.setDelegationPolicy('active', 'workspace'), /scope=persistent or scope=session/);
});

test('persistent policy survives bridge reconstruction while session overrides remain temporary', (t) => {
  const policyFile = createTempPolicyFile(t);
  const first = new OfflineBridge({ delegationPolicy: undefined, policyFile });
  const saved = first.setDelegationPolicy('manual');
  assert.equal(saved.scope, 'persistent');
  assert.equal(saved.policySource, 'persistent');
  assert.equal(saved.policyStored, true);
  assert.equal(saved.persistsAcrossRestart, true);
  assert.equal(saved.restartPolicy, 'manual');
  assert.equal(JSON.parse(readFileSync(policyFile, 'utf8')).policy, 'manual');

  const restarted = new OfflineBridge({ delegationPolicy: undefined, policyFile });
  assert.equal(restarted.delegationPolicy, 'manual');
  assert.equal(restarted.delegationPolicyView().policySource, 'persistent');

  const replaced = restarted.setDelegationPolicy('auto');
  assert.equal(replaced.policy, 'auto');
  assert.equal(JSON.parse(readFileSync(policyFile, 'utf8')).policy, 'auto');

  const temporary = restarted.setDelegationPolicy('eager', 'session');
  assert.equal(temporary.policy, 'eager');
  assert.equal(temporary.scope, 'session');
  assert.equal(temporary.policyStored, false);
  assert.equal(temporary.persistsAcrossRestart, false);
  assert.equal(temporary.restartPolicy, 'auto');

  const restartedAgain = new OfflineBridge({ delegationPolicy: undefined, policyFile });
  assert.equal(restartedAgain.delegationPolicy, 'auto');
});

test('invalid persisted policy falls back to the bootstrap policy', (t) => {
  const policyFile = createTempPolicyFile(t);
  writeFileSync(policyFile, JSON.stringify({ version: 1, policy: 'off' }));
  const bridge = new OfflineBridge({ delegationPolicy: undefined, policyFile });
  assert.equal(bridge.delegationPolicy, 'active');
  assert.notEqual(bridge.delegationPolicyView().policySource, 'persistent');
});

test('disabled delegation rejects cursor_do before Cursor access', async () => {
  const bridge = new OfflineBridge({ delegationMode: 'off' });
  assert.equal(bridge.delegationEnabled, false);
  assert.equal(bridge.delegationPolicy, 'active');
  await assert.rejects(bridge.doTask('must not delegate'), /CURSOR_BRIDGE_DELEGATION=off/);
  assert.throws(() => bridge.setDelegationPolicy('active'), /locks delegation off/);
  const missing = await bridge.status('cursor-missing');
  assert.equal(missing.delegationMode, 'off');
  assert.equal(missing.delegationEnabled, false);
  assert.equal(missing.policy, 'active');
});

test('bundled MCP hides cursor_do in off mode and rejects direct calls', async (t) => {
  const serverPath = fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url));
  const policyFile = createTempPolicyFile(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      CURSOR_BRIDGE_DELEGATION: 'off',
      CURSOR_BRIDGE_POLICY: 'active',
      CURSOR_BRIDGE_POLICY_FILE: policyFile,
      CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
    },
  });
  const client = new Client({ name: 'cursor-bridge-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_do'), false);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_search'), true);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_task_control'), true);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_policy'), true);
    const taskControl = listed.tools.find((tool) => tool.name === 'cursor_task_control');
    assert.deepEqual(taskControl.inputSchema.properties.action.enum, ['reap', 'cancel', 'abandon']);
    const missingTask = await client.callTool({
      name: 'cursor_task_control',
      arguments: { task_id: 'cursor-missing', action: 'reap' },
    });
    assert.equal(JSON.parse(missingTask.content[0].text).found, false);
    const policy = await client.callTool({ name: 'cursor_policy', arguments: {} });
    assert.equal(JSON.parse(policy.content[0].text).environmentLockedOff, true);
    const blockedPolicy = await client.callTool({ name: 'cursor_policy', arguments: { mode: 'active' } });
    assert.equal(blockedPolicy.isError, true);
    const blocked = await client.callTool({ name: 'cursor_do', arguments: { prompt: 'must not run' } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /CURSOR_BRIDGE_DELEGATION=off/);
  } finally {
    await client.close();
  }
});

test('bundled MCP persists policy across restart and exposes it in current tool guidance', async (t) => {
  const serverPath = fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url));
  const policyFile = createTempPolicyFile(t);
  const env = {
    ...process.env,
    CURSOR_BRIDGE_DELEGATION: 'on',
    CURSOR_BRIDGE_POLICY: 'active',
    CURSOR_BRIDGE_POLICY_FILE: policyFile,
    CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
  };

  const first = await openBundledClient(serverPath, env, 'cursor-bridge-policy-first');
  try {
    let listed = await first.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_do'), true);
    const initialDo = listed.tools.find((tool) => tool.name === 'cursor_do');
    assert.match(initialDo.description, /Current effective Cursor participation policy: active/);
    const policyTool = listed.tools.find((tool) => tool.name === 'cursor_policy');
    assert.deepEqual(policyTool.inputSchema.properties.scope.enum, ['persistent', 'session']);
    assert.equal(policyTool.inputSchema.properties.scope.default, 'persistent');

    const selective = await first.callTool({ name: 'cursor_policy', arguments: { mode: 'manual' } });
    const saved = JSON.parse(selective.content[0].text);
    assert.equal(saved.policy, 'manual');
    assert.equal(saved.scope, 'persistent');
    assert.equal(saved.policyStored, true);
    assert.equal(saved.persistsAcrossRestart, true);
    listed = await first.listTools();
    assert.match(listed.tools.find((tool) => tool.name === 'cursor_do').description, /Current effective Cursor participation policy: manual/);

    const removedOff = await first.callTool({ name: 'cursor_policy', arguments: { mode: 'off' } });
    assert.equal(removedOff.isError, true);
  } finally {
    await first.close();
  }

  assert.equal(existsSync(policyFile), true);
  assert.equal(JSON.parse(readFileSync(policyFile, 'utf8')).policy, 'manual');

  const second = await openBundledClient(serverPath, env, 'cursor-bridge-policy-second');
  try {
    const current = await second.callTool({ name: 'cursor_policy', arguments: {} });
    const restored = JSON.parse(current.content[0].text);
    assert.equal(restored.policy, 'manual');
    assert.equal(restored.policySource, 'persistent');
    assert.equal(restored.persistsAcrossRestart, true);
    const listed = await second.listTools();
    assert.match(listed.tools.find((tool) => tool.name === 'cursor_do').description, /Current effective Cursor participation policy: manual/);

    const temporary = await second.callTool({
      name: 'cursor_policy',
      arguments: { mode: 'eager', scope: 'session' },
    });
    const sessionView = JSON.parse(temporary.content[0].text);
    assert.equal(sessionView.policy, 'eager');
    assert.equal(sessionView.scope, 'session');
    assert.equal(sessionView.restartPolicy, 'manual');
  } finally {
    await second.close();
  }

  const third = await openBundledClient(serverPath, env, 'cursor-bridge-policy-third');
  try {
    const current = await third.callTool({ name: 'cursor_policy', arguments: {} });
    assert.equal(JSON.parse(current.content[0].text).policy, 'manual');
  } finally {
    await third.close();
  }
});

test('new agent selection uses ID diff, selected entry, then newest timestamp', () => {
  const before = [{ id: 'local:old' }];
  assert.equal(selectNewAgentEntry(before, before), null);
  assert.equal(selectNewAgentEntry(before, [
    ...before,
    { id: 'local:a', timestamp: 20, isSelected: false },
    { id: 'local:b', timestamp: 10, isSelected: true },
  ]).id, 'local:b');
  assert.equal(selectNewAgentEntry(before, [
    ...before,
    { id: 'local:a', timestamp: 20, isSelected: false },
    { id: 'local:b', timestamp: 10, isSelected: false },
  ]).id, 'local:a');
});

test('cursor_do defaults to FIFO and keeps background task identity', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('检查一个明确任务');
  assert.equal(view.status, 'queued');
  assert.equal(view.execution, 'fifo');
  assert.equal(view.effectiveExecution, 'fifo');
  assert.equal(view.submittedPolicy, 'active');
  assert.match(view.taskId, /^cursor-/);
});

test('parallel agent requires read_only or a writable path boundary', async () => {
  const bridge = new OfflineBridge();
  await assert.rejects(
    bridge.doTask('无边界写任务', { execution: 'parallel_agent' }),
    /必须提供 allowed_paths/,
  );
  const view = await bridge.doTask('只读任务', { execution: 'parallel_agent', readOnly: true });
  assert.equal(view.execution, 'parallel_agent');
  assert.equal(view.readOnly, true);
  await assert.rejects(
    bridge.doTask('矛盾边界', { execution: 'parallel_agent', readOnly: true, allowedPaths: ['Assets'] }),
    /不能同时使用/,
  );
  await assert.rejects(
    bridge.doTask('绝对路径', { execution: 'parallel_agent', allowedPaths: ['G:/repo/file.txt'] }),
    /必须使用工作区相对路径/,
  );
  await assert.rejects(
    bridge.doTask('glob 路径', { execution: 'parallel_agent', allowedPaths: ['Assets/**/*.cs'] }),
    /不接受 glob/,
  );
});

test('overlapping writable parallel tasks are rejected before submission', async () => {
  const bridge = new OfflineBridge();
  await bridge.doTask('任务 A', {
    execution: 'parallel_agent',
    allowedPaths: ['Assets/Scripts/Battle'],
  });
  await assert.rejects(
    bridge.doTask('任务 B', {
      execution: 'parallel_agent',
      allowedPaths: ['Assets/Scripts/Battle/Effects'],
    }),
    /allowed_paths 与任务 .* 重叠/,
  );
});

test('unsupported execution mode is rejected explicitly', async () => {
  const bridge = new OfflineBridge();
  await assert.rejects(bridge.doTask('任务', { execution: 'multitask' }), /只能是 fifo 或 parallel_agent/);
});

test('unbound uncertain parallel task becomes a global reservation', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('可能仍在运行的写任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Reserved'],
  });
  const job = bridge.tasks.get(view.taskId);
  bridge._orphanParallelJob(job, new Error('history unavailable'));
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.phase, 'orphaned');
  assert.equal(bridge.activeParallel.has(job.id), true);
  await assert.rejects(
    bridge.doTask('重叠写任务', {
      execution: 'parallel_agent',
      allowedPaths: ['Tools/Reserved/Sub'],
    }),
    /全局 Cursor 占用/,
  );
  assert.equal(job.reservationScope, 'global');
  assert.equal(bridge._taskView(job).blocksAll, true);
});

test('targeted Stop confirmation requires a real click and two stable terminal observations', () => {
  assert.equal(isTargetedStopConfirmed({ clicked: false }, 2), false);
  assert.equal(isTargetedStopConfirmed({ clicked: true }, 1), false);
  assert.equal(isTargetedStopConfirmed({ clicked: true }, 2), true);

  const expression = exprClickSelectedAgentStop('local:exact-agent');
  assert.match(expression, /data-state="stop"/);
  assert.match(expression, /aria-label="Stop generation"/);
  assert.match(expression, /ui-shell-tool-call__glass-stop/);
  assert.match(expression, /aria-label="Stop command"/);
  assert.match(expression, /composerStatus!==\'generating\'/);
  assert.doesNotMatch(expression, /aria-label\*=Cancel|debug-stop/);
});

test('targeted Stop expression executes against the React adapter and exact composer', () => {
  let clicks = 0;
  const label = {
    offsetParent: {},
    parentElement: null,
    '__reactProps$test': {
      entries: [{ id: 'local:exact-agent', isSelected: true }],
      onOpenEntry() {},
    },
  };
  const composer = {
    offsetParent: {},
    dataset: { composerId: 'exact-agent', composerStatus: 'generating' },
    querySelectorAll(selector) {
      return selector.includes('ui-prompt-input-submit-button') ? [button] : [];
    },
  };
  const button = {
    offsetParent: {},
    disabled: false,
    closest() { return composer; },
    click() { clicks++; },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.compact-agent-history-react-menu-label') return [label];
      if (selector === '.composer-bar[data-composer-id]') return [composer];
      return [];
    },
  };
  const expression = exprClickSelectedAgentStop('local:exact-agent');
  const result = JSON.parse(Function('document', `return ${expression};`)(document));
  assert.equal(result.clicked, true);
  assert.equal(result.selectedId, 'local:exact-agent');
  assert.equal(result.composerId, 'exact-agent');
  assert.equal(result.control, 'stop_generation');
  assert.equal(clicks, 1);
});

test('targeted Stop expression accepts the exact foreground command stop control', () => {
  let clicks = 0;
  const label = {
    offsetParent: {},
    parentElement: null,
    '__reactProps$test': {
      entries: [{ id: 'local:exact-agent', isSelected: true }],
      onOpenEntry() {},
    },
  };
  const composer = {
    offsetParent: {},
    dataset: { composerId: 'exact-agent', composerStatus: 'generating' },
    querySelectorAll(selector) {
      return selector.includes('ui-shell-tool-call__glass-stop') ? [button] : [];
    },
  };
  const button = {
    offsetParent: {},
    disabled: false,
    closest() { return composer; },
    click() { clicks++; },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.compact-agent-history-react-menu-label') return [label];
      if (selector === '.composer-bar[data-composer-id]') return [composer];
      return [];
    },
  };
  const result = JSON.parse(Function('document', `return ${exprClickSelectedAgentStop('local:exact-agent')};`)(document));
  assert.equal(result.clicked, true);
  assert.equal(result.control, 'stop_command');
  assert.equal(clicks, 1);
});

test('parallel failure icons require two identical stable observations', () => {
  const entry = { id: 'local:agent', showSpinner: false, icon: 'warning' };
  const first = updateStableEntryObservation('', 0, entry);
  assert.equal(first.count, 1);
  const second = updateStableEntryObservation(first.signature, first.count, entry);
  assert.equal(second.count, 2);
  const changed = updateStableEntryObservation(second.signature, second.count, { ...entry, icon: 'loading', showSpinner: true });
  assert.equal(changed.count, 1);
  assert.notEqual(changed.signature, second.signature);
  assert.equal(classifyParallelTerminalIcon('circle-slash'), 'cancelled');
  assert.equal(classifyParallelTerminalIcon('warning'), 'failed');
  assert.equal(classifyParallelTerminalIcon('check-circled'), 'completed');
});

test('orphaned task can be reaped to completed after its original promise was rejected', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('可恢复的只读任务', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);
  assert.equal(job.settled, true);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
  ];

  const result = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(result.state, 'completed');
  assert.equal(job.status, 'completed');
  assert.equal(job.result, 'recovered result');
  assert.equal(job.resultUnavailable, false);
  assert.equal(bridge.activeParallel.has(job.id), false);
});

test('reap reattaches monitoring when the exact orphaned Agent is still generating', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('仍在运行的只读任务', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];

  const result = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(result.state, 'running');
  assert.equal(result.monitorReattached, true);
  assert.equal(job.status, 'running');
  assert.equal(job.recoveryState, 'monitoring');
  assert.equal(bridge.monitorStarts, 1);
  assert.equal(bridge.activeParallel.has(job.id), true);
});

test('stable completion keeps reservation when final response extraction is temporarily unavailable', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('结果 DOM 丢失任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Reaped'],
  });
  const job = makeOrphan(bridge, view);
  bridge.collectError = new Error('response DOM unavailable');
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
  ];

  const result = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(result.state, 'terminal_uncollected');
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.resultUnavailable, true);
  assert.match(job.error, /response DOM unavailable/);
  assert.equal(bridge.activeParallel.has(job.id), true);
  await assert.rejects(bridge.doTask('原路径仍应保留', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Reaped/Sub'],
  }), /重叠/);

  bridge.collectError = null;
  bridge.collectResult = 'retry recovered result';
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
  ];
  const retried = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(retried.state, 'completed');
  assert.equal(retried.task.result, 'retry recovered result');
  assert.equal(retried.task.resultUnavailable, false);
  assert.equal(retried.task.reservationHeld, false);
});

test('targeted cancel requires the exact agent id and releases only after confirmed Stop', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('需要停止的写任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Cancelable'],
  });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];

  await assert.rejects(
    bridge.taskControl(view.taskId, {
      action: 'cancel',
      confirm: true,
      expectedAgentId: 'local:wrong-agent',
    }),
    /expected_agent_id 不匹配/,
  );
  assert.equal(bridge.activeParallel.has(job.id), true);

  const cancelled = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    expectedAgentId: job.agentId,
    reason: '用户终止旧任务',
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(job.status, 'cancelled');
  assert.equal(job.underlyingStopConfirmed, true);
  assert.equal(bridge.activeParallel.has(job.id), false);
  await bridge.doTask('取消后路径可以重新使用', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Cancelable/Sub'],
  });
});

test('unconfirmed cancel keeps reservation and reports the safe next action', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('停止状态不明的写任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/StillReserved'],
  });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];
  bridge.stopResult = { confirmed: false, state: 'stop_unconfirmed' };

  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    expectedAgentId: job.agentId,
  });
  assert.equal(result.state, 'cancel_unconfirmed');
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.phase, 'orphaned');
  assert.equal(bridge.activeParallel.has(job.id), true);
  await assert.rejects(
    bridge.doTask('仍应冲突', {
      execution: 'parallel_agent',
      allowedPaths: ['Tools/StillReserved/Sub'],
    }),
    /重叠/,
  );
  assert.equal(job.reservationScope, 'paths');
  assert.equal(bridge._taskView(job).blocksAll, false);
});

test('parallel cancel reports the actual terminal state when monitoring wins the race', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('取消与终态竞态', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];
  bridge._stopParallelAgent = async () => {
    bridge.activeParallel.delete(job.id);
    bridge._failJob(job, new Error('monitor reached failed first'));
    return { confirmed: true, clicked: true, state: 'stopped' };
  };

  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    expectedAgentId: job.agentId,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.task.status, 'failed');
  assert.match(result.task.error, /monitor reached failed first/);
});

test('cancel latched during parallel submission stops the bound Agent before monitoring starts', async () => {
  const bridge = new DeferredSubmitBridge();
  const view = await bridge.doTask('提交过程中取消', { execution: 'parallel_agent', readOnly: true });
  await bridge.submitStarted;

  const control = bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    reason: '提交中停止',
  });
  const job = bridge.tasks.get(view.taskId);
  assert.equal(job.cancelRequested, true);

  bridge._resolveSubmit({
    agent: { id: 'local:prebound-before-return', label: 'bound' },
    previousSelectedId: null,
  });
  const result = await control;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.task.status, 'cancelled');
  assert.equal(bridge.stopCalls, 1);
  assert.equal(bridge.monitorStarts, 0);
  assert.equal(bridge.activeParallel.size, 0);
});

test('stale monitor finally cannot clear a newer monitor generation', async () => {
  const bridge = new MonitorGenerationBridge();
  const view = await bridge.doTask('generation guard', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);

  assert.equal(bridge._startParallelMonitor(job), true);
  const firstGeneration = job.monitorGeneration;
  const firstPromise = job.monitorPromise;
  bridge._invalidateParallelMonitor(job);
  assert.equal(bridge._startParallelMonitor(job), true);
  const secondGeneration = job.monitorGeneration;
  const secondPromise = job.monitorPromise;
  assert.notEqual(firstGeneration, secondGeneration);

  bridge.gates.get(firstGeneration).resolve();
  await firstPromise;
  assert.equal(job.monitorPromise, secondPromise);
  assert.equal(job.monitorAttached, true);

  bridge.gates.get(secondGeneration).resolve();
  await secondPromise;
  assert.equal(job.monitorPromise, null);
  assert.equal(job.monitorAttached, false);
});

test('running FIFO cancel that cannot confirm Stop remains blocked with an explicit abandon path', async () => {
  const bridge = new CancellableFifoBridge();
  const view = await bridge.doTask('运行中的 FIFO');
  await bridge.runStarted;
  const job = bridge.tasks.get(view.taskId);
  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    reason: '停止 FIFO',
  });
  assert.equal(result.state, 'cancel_unconfirmed');
  assert.equal(result.task.status, 'needs_attention');
  assert.match(result.next, /abandon/);
  assert.equal(bridge._taskView(job).blocksFifo, true);
  assert.equal(bridge._taskView(job).blocksAll, true);
  await assert.rejects(bridge.doTask('全局占用期间不得提交并行任务', {
    execution: 'parallel_agent',
    readOnly: true,
  }), /全局 Cursor 占用/);

  const reaped = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(reaped.state, 'not_parallel_reservation');
  assert.match(reaped.next, /FIFO 孤儿/);
});

test('parallel to FIFO fallback cancellation reports orphaned instead of pending agent binding', async () => {
  const bridge = new CancellableFifoBridge({ fallback: true });
  const view = await bridge.doTask('降级后取消', { execution: 'parallel_agent', readOnly: true });
  await bridge.runStarted;

  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    reason: '取消降级任务',
  });
  assert.equal(result.state, 'cancel_unconfirmed');
  assert.equal(result.task.status, 'needs_attention');
  assert.equal(result.task.effectiveExecution, 'fifo');
  assert.equal(result.task.reservationScope, 'global');
  assert.doesNotMatch(result.next, /绑定 agentId/);
});

test('global orphan reservation blocks already queued work at the scheduler gate', async () => {
  const bridge = new OfflineBridge();
  const orphanView = await bridge.doTask('未知 FIFO');
  const queuedView = await bridge.doTask('已排队的并行只读', { execution: 'parallel_agent', readOnly: true });
  const orphan = bridge.tasks.get(orphanView.taskId);
  bridge.queue = bridge.queue.filter((job) => job.id !== orphan.id);
  orphan.status = 'running';
  orphan.phase = 'running';
  bridge._orphanParallelJob(orphan, new Error('stop unconfirmed'));
  let runs = 0;
  bridge._run = async () => { runs++; return 'unexpected'; };

  await CursorBridge.prototype._drain.call(bridge);
  assert.equal(runs, 0);
  assert.equal(bridge.queue.some((job) => job.id === queuedView.taskId), true);
  assert.equal(bridge._taskView(orphan).blocksAll, true);
});

test('FIFO failure after possible send becomes a global orphan instead of releasing silently', async () => {
  const bridge = new SentFifoFailureBridge();
  const view = await bridge.doTask('发送后读取失败');
  const job = bridge.tasks.get(view.taskId);
  await job.controlTail;
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.phase, 'orphaned');
  assert.equal(job.reservationScope, 'global');
  assert.equal(bridge.activeParallel.has(job.id), true);
});

test('task identity is process-local and is not claimed recoverable after bridge reconstruction', async () => {
  const first = new OfflineBridge();
  const view = await first.doTask('进程内任务', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(first, view);
  assert.equal(first.activeParallel.has(job.id), true);

  const restarted = new OfflineBridge();
  const status = await restarted.status(view.taskId);
  assert.equal(status.found, false);
  assert.equal(restarted.activeParallel.size, 0);
});

test('abandon requires explicit risk acknowledgement and releases an orphan visibly', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('无法绑定 agentId 的任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Abandonable'],
  });
  const job = makeOrphan(bridge, view, { agentId: null });

  await assert.rejects(
    bridge.taskControl(view.taskId, {
      action: 'abandon',
      confirm: true,
      reason: '已在 Cursor 手工停止',
    }),
    /acknowledge_may_still_write=true/,
  );
  assert.equal(bridge.activeParallel.has(job.id), true);

  const result = await bridge.taskControl(view.taskId, {
    action: 'abandon',
    confirm: true,
    reason: '已在 Cursor 手工停止并关闭旧任务',
    acknowledgeMayStillWrite: true,
  });
  assert.equal(result.state, 'abandoned');
  assert.match(result.warning, /仍可能继续写文件/);
  assert.equal(job.status, 'abandoned');
  assert.equal(job.underlyingStopConfirmed, false);
  assert.equal(bridge.activeParallel.has(job.id), false);
});

test('queued task cancellation is terminal and removed from the queue', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('尚未发送的任务');
  assert.equal(bridge.queue.length, 1);

  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    reason: '不再需要',
  });
  assert.equal(result.state, 'cancelled');
  assert.equal(result.task.status, 'cancelled');
  assert.equal(result.task.underlyingStopConfirmed, true);
  assert.equal(bridge.queue.length, 0);
});

test('status is a pure snapshot and explicit reap performs recovery', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('状态自动恢复任务', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];
  const overall = await bridge.status();
  assert.deepEqual(overall.blockingTaskIds, [job.id]);
  assert.equal(overall.activeParallel[0].blocksFifo, true);

  job.status = 'needs_attention';
  job.phase = 'orphaned';
  job.monitorAttached = false;
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
  ];

  const status = await bridge.status(view.taskId);
  assert.equal(status.status, 'needs_attention');
  assert.equal(status.result, null);
  assert.equal(status.reservationHeld, true);
  assert.equal(bridge.entrySnapshots.length, 2);
  assert.equal(bridge.monitorStarts, 0);

  const recovered = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.task.result, 'recovered result');
  assert.equal(recovered.task.reservationHeld, false);
});

test('UI lock serializes operations without poisoning later work after rejection', async () => {
  const bridge = new CursorBridge();
  const order = [];
  const first = bridge._withUiLock(async () => {
    order.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('a:end');
    throw new Error('expected');
  });
  const second = bridge._withUiLock(async () => {
    order.push('b');
    return 42;
  });
  await assert.rejects(first, /expected/);
  assert.equal(await second, 42);
  assert.deepEqual(order, ['a:start', 'a:end', 'b']);
});

test('per-job control lock serializes lifecycle transitions', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('job lock');
  const job = bridge.tasks.get(view.taskId);
  let active = 0;
  let maxActive = 0;
  const order = [];
  const run = (label, delay) => bridge._withJobLock(job, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`${label}:start`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    order.push(`${label}:end`);
    active--;
  });

  await Promise.all([run('a', 15), run('b', 0), run('c', 0)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});
