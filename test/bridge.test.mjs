import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CursorBridge,
  normalizeAllowedPath,
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
