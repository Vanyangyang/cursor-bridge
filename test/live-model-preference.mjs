#!/usr/bin/env node
import { resolve } from 'node:path';
import { CursorBridge } from '../server.mjs';

const projectPath = resolve(process.argv[2] || process.cwd());
const model = String(process.argv[3] || '').trim();
const effort = String(process.argv[4] || '').trim() || null;
if (!model) {
  throw new Error('Usage: node test/live-model-preference.mjs <project-path> <model> [effort]');
}

const bridge = new CursorBridge({
  runtimeFile: null,
  workspaceFile: null,
  modelPreferencesFile: null,
  runtimeMode: 'normal',
  projectPath,
});
bridge.modelPreferences.targets.cce = { model, effort };
bridge.modelPreferences.targets.cursor_do = { model, effort };

const cceResult = await bridge.contextEngine(
  'Locate the source function that defines the cursor_model MCP tool and the function that applies its selection before prompt submission. Return only verified path:line evidence.',
);
const cceJob = [...bridge.tasks.values()].find((job) => job.kind === 'context_engine');
const cceStatus = await bridge.status(cceJob.id);
if (!cceStatus.modelSelection?.applied) {
  throw new Error(`CCE model selection was not applied: ${JSON.stringify(cceStatus.modelSelection)}`);
}
if (!String(cceResult).includes('server.mjs')) {
  throw new Error(`CCE result did not contain server.mjs evidence: ${cceResult}`);
}

const marker = `CURSOR_MODEL_LIVE_${Date.now().toString(36).toUpperCase()}`;
const delegated = await bridge.doTask(
  `Read only server.mjs. Confirm that cursor_model is defined as an MCP tool and reply with ${marker}. Do not modify any file or run state-changing commands.`,
  {
    background: false,
    execution: 'fifo',
    readOnly: true,
    timeoutMs: 180000,
    completionContract: `Reply with ${marker}, the source file path, and a one-sentence verification result.`,
  },
);
if (!delegated.modelSelection?.applied) {
  throw new Error(`cursor_do model selection was not applied: ${JSON.stringify(delegated.modelSelection)}`);
}
if (!String(delegated.result || '').includes(marker)) {
  throw new Error(`cursor_do result did not contain ${marker}: ${delegated.result}`);
}

console.log(JSON.stringify({
  event: 'passed',
  projectPath,
  requested: { model, effort },
  cce: {
    taskId: cceStatus.taskId,
    agentId: cceStatus.agentId,
    uiFlavor: cceStatus.targetUiFlavor,
    modelSelection: cceStatus.modelSelection,
  },
  cursorDo: {
    taskId: delegated.taskId,
    agentId: delegated.agentId,
    uiFlavor: delegated.targetUiFlavor,
    modelSelection: delegated.modelSelection,
  },
}, null, 2));
