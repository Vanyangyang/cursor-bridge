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
  timeoutMs: 120000,
  completionContract: '不得读写文件。完成后最终回复只包含指定标记，不添加解释。',
};

const a = await bridge.doTask(
  `这是只读并行桥接测试 A。不要读取或修改文件。在终端执行 PowerShell Start-Sleep -Seconds 8，随后最终只回复 ${markerA}`,
  common,
);
const b = await bridge.doTask(
  `这是只读并行桥接测试 B。不要读取或修改文件。在终端执行 PowerShell Start-Sleep -Seconds 10，随后最终只回复 ${markerB}`,
  common,
);

console.log(JSON.stringify({ event: 'submitted', a: a.taskId, b: b.taskId }));
let sawTwoAgents = false;
let finalA;
let finalB;
const deadline = Date.now() + 150000;
while (Date.now() < deadline) {
  const [sa, sb, all] = await Promise.all([
    bridge.status(a.taskId),
    bridge.status(b.taskId),
    bridge.status(),
  ]);
  const ids = [sa.agentId, sb.agentId].filter(Boolean);
  if (new Set(ids).size === 2 && all.activeParallel.length >= 2) sawTwoAgents = true;
  console.log(JSON.stringify({
    event: 'poll',
    a: { status: sa.status, phase: sa.phase, agentId: sa.agentId },
    b: { status: sb.status, phase: sb.phase, agentId: sb.agentId },
    activeParallel: all.activeParallel.length,
  }));
  if (sa.status === 'failed' || sb.status === 'failed') {
    throw new Error(`parallel task failed: A=${sa.error || '-'} B=${sb.error || '-'}`);
  }
  if (sa.status === 'completed' && sb.status === 'completed') {
    finalA = sa;
    finalB = sb;
    break;
  }
  await sleep(1200);
}

if (!finalA || !finalB) throw new Error('parallel tasks did not both reach completed');
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
