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
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_policy'), true);
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

test('uncertain parallel terminal state remains reserved as needs_attention', async () => {
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
    /重叠/,
  );
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
