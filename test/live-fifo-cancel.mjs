#!/usr/bin/env node
import { CursorBridge } from '../server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = Date.now().toString(36).toUpperCase();
const marker = `CURSOR_BRIDGE_FIFO_CANCEL_${stamp}`;
const bridge = new CursorBridge();

const submitted = await bridge.doTask(
  `这是只读 FIFO 取消测试。不要读取或修改任何文件。在终端执行 PowerShell Start-Sleep -Seconds 90，随后最终只回复 ${marker}。在任务被停止前不要结束。`,
  {
    execution: 'fifo',
    readOnly: true,
    background: true,
    timeoutMs: 180000,
    completionContract: '不得读写文件。若任务未被取消，最终回复只包含指定标记。',
  },
);

console.log(JSON.stringify({ event: 'submitted', taskId: submitted.taskId }));

let ready = null;
const bindDeadline = Date.now() + 30000;
while (Date.now() < bindDeadline) {
  const snapshot = await bridge.status(submitted.taskId);
  console.log(JSON.stringify({
    event: 'poll',
    status: snapshot.status,
    phase: snapshot.phase,
    agentId: snapshot.agentId,
    targetUiFlavor: snapshot.targetUiFlavor,
    sendState: snapshot.sendState,
    recoveryState: snapshot.recoveryState,
  }));
  if (['failed', 'cancelled', 'abandoned', 'completed'].includes(snapshot.status)) {
    throw new Error(`task ended before cancel: ${snapshot.status} ${snapshot.error || ''}`);
  }
  if (snapshot.agentId && snapshot.sendState === 'sent' && snapshot.status === 'running') {
    ready = snapshot;
    break;
  }
  await sleep(800);
}

if (!ready || !ready.agentId) {
  const leftover = await bridge.status(submitted.taskId);
  try {
    await bridge.taskControl(submitted.taskId, {
      action: leftover.phase === 'orphaned' || leftover.status === 'needs_attention' ? 'abandon' : 'cancel',
      confirm: true,
      reason: '5.3.5 live test cleanup: FIFO did not publish agentId',
      acknowledgeMayStillWrite: leftover.phase === 'orphaned' || leftover.status === 'needs_attention',
      expectedAgentId: leftover.agentId || undefined,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'cleanup_failed', error: error.message }));
  }
  throw new Error('FIFO did not publish agentId on Agents Window');
}

await sleep(2000);
const cancelled = await bridge.taskControl(submitted.taskId, {
  action: 'cancel',
  confirm: true,
  expectedAgentId: ready.agentId,
  reason: '5.3.5 live test: targeted FIFO cancel',
});

console.log(JSON.stringify({
  event: 'cancel',
  state: cancelled.state,
  status: cancelled.task && cancelled.task.status,
  agentId: cancelled.task && cancelled.task.agentId,
  stopConfirmed: cancelled.task && cancelled.task.underlyingStopConfirmed,
  recoveryState: cancelled.task && cancelled.task.recoveryState,
  next: cancelled.next || null,
}));

if (cancelled.state !== 'cancelled' || !cancelled.task || cancelled.task.status !== 'cancelled') {
  throw new Error(`expected cancelled, got ${cancelled.state} / ${cancelled.task && cancelled.task.status} stop=${JSON.stringify(cancelled.stop || null)}`);
}
if (cancelled.task.underlyingStopConfirmed !== true) {
  throw new Error('targeted Stop was not confirmed');
}

console.log(JSON.stringify({
  event: 'passed',
  taskId: submitted.taskId,
  agentId: ready.agentId,
  targetUiFlavor: ready.targetUiFlavor,
}));
