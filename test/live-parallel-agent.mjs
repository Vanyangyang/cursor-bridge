#!/usr/bin/env node
import { CursorBridge } from '../server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = Date.now().toString(36).toUpperCase();
const markerA = `CURSOR_BRIDGE_PARALLEL_A_${stamp}`;
const markerB = `CURSOR_BRIDGE_PARALLEL_B_${stamp}`;
const bridge = new CursorBridge();

const common = {
  execution: 'parallel_agent',
  readOnly: true,
  background: true,
  timeoutMs: 180000,
  completionContract: '只允许读取点名的 JSON 文件，不得修改任何文件。最终回复必须包含指定标记和核对到的版本，不添加其他项目背景。',
};

const a = await bridge.doTask(
  `这是只读并行桥接测试 A。只读取根 package.json 和 .codex-plugin/plugin.json，核对两处 Cursor Bridge 基础版本一致；不得修改文件。最终用中文回复 ${markerA} 和版本。`,
  common,
);
const b = await bridge.doTask(
  `这是只读并行桥接测试 B。只读取 plugins/grok-build-supervisor/package.json 与它的两个 plugin.json，核对三处 Grok Build Supervisor 基础版本一致；不得修改文件。最终用中文回复 ${markerB} 和版本。`,
  common,
);

console.log(JSON.stringify({ event: 'submitted', a: a.taskId, b: b.taskId }));
let sawTwoAgents = false;
let finalA;
let finalB;
let fatalRecovery = null;
const deadline = Date.now() + 210000;
const reapAttempts = new Set();
async function reapIfNeeded(label, taskId, snapshot) {
  if (snapshot.status !== 'needs_attention' || !snapshot.agentId) return snapshot;
  if (reapAttempts.has(label)) return snapshot;
  reapAttempts.add(label);
  const recovered = await bridge.taskControl(taskId, { action: 'reap' });
  console.log(JSON.stringify({
    event: 'reap',
    label,
    state: recovered.state,
    error: recovered.error || recovered.task?.error || null,
  }));
  if (recovered.state === 'agent_missing' || recovered.state === 'unbound_agent') {
    fatalRecovery = `${label}:${recovered.state}:${recovered.error || recovered.task?.error || ''}`;
  }
  return recovered.task || snapshot;
}
while (Date.now() < deadline) {
  let [sa, sb, all] = await Promise.all([
    bridge.status(a.taskId),
    bridge.status(b.taskId),
    bridge.status(),
  ]);
  sa = await reapIfNeeded('a', a.taskId, sa);
  sb = await reapIfNeeded('b', b.taskId, sb);
  const ids = [sa.agentId, sb.agentId].filter(Boolean);
  if (new Set(ids).size === 2 && all.activeParallel.length >= 2) sawTwoAgents = true;
  console.log(JSON.stringify({
    event: 'poll',
    a: { status: sa.status, phase: sa.phase, agentId: sa.agentId, error: sa.error || null },
    b: { status: sb.status, phase: sb.phase, agentId: sb.agentId, error: sb.error || null },
    activeParallel: all.activeParallel.length,
  }));
  if (sa.status === 'failed' || sb.status === 'failed') {
    throw new Error(`parallel task failed: A=${sa.error || '-'} B=${sb.error || '-'}`);
  }
  if (fatalRecovery) break;
  if (sa.status === 'completed' && sb.status === 'completed') {
    finalA = sa;
    finalB = sb;
    break;
  }
  await sleep(1200);
}

if (!finalA || !finalB) {
  for (const taskId of [a.taskId, b.taskId]) {
    const snapshot = await bridge.status(taskId);
    if (!['completed', 'failed', 'cancelled', 'abandoned'].includes(snapshot.status) && snapshot.agentId) {
      try {
        await bridge.taskControl(taskId, {
          action: 'cancel',
          confirm: true,
          expectedAgentId: snapshot.agentId,
          reason: 'parallel live acceptance cleanup',
        });
      } catch {}
    }
  }
  throw new Error(`parallel tasks did not both reach completed${fatalRecovery ? `: ${fatalRecovery}` : ''}`);
}
if (!sawTwoAgents) throw new Error('did not observe two distinct active top-level agents');
if (!String(finalA.result || '').includes(markerA)) throw new Error(`A result mismatch: ${finalA.result}`);
if (!String(finalB.result || '').includes(markerB)) throw new Error(`B result mismatch: ${finalB.result}`);
if (finalA.agentId === finalB.agentId) throw new Error('parallel tasks share the same agentId');

await sleep(1200);
console.log(JSON.stringify({
  event: 'passed',
  sawTwoAgents,
  a: { taskId: finalA.taskId, agentId: finalA.agentId, result: finalA.result },
  b: { taskId: finalB.taskId, agentId: finalB.agentId, result: finalB.result },
}));
