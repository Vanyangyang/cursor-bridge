import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  CursorBridge,
  normalizeAllowedPath,
  normalizeDelegationMode,
  pathsOverlap,
  selectNewAgentEntry,
} from '../server.mjs';

class OfflineBridge extends CursorBridge {
  async _ensureCursor() {}
  _drain() {}
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

test('disabled delegation rejects cursor_do before Cursor access', async () => {
  const bridge = new OfflineBridge({ delegationMode: 'off' });
  assert.equal(bridge.delegationEnabled, false);
  await assert.rejects(bridge.doTask('不应派发'), /CURSOR_BRIDGE_DELEGATION=off/);
  const missing = await bridge.status('cursor-missing');
  assert.equal(missing.delegationMode, 'off');
  assert.equal(missing.delegationEnabled, false);
});

test('bundled MCP hides cursor_do in off mode and rejects direct calls', async () => {
  const serverPath = fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      CURSOR_BRIDGE_DELEGATION: 'off',
      CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
    },
  });
  const client = new Client({ name: 'cursor-bridge-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_do'), false);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_search'), true);
    const blocked = await client.callTool({ name: 'cursor_do', arguments: { prompt: '不应执行' } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /CURSOR_BRIDGE_DELEGATION=off/);
  } finally {
    await client.close();
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
