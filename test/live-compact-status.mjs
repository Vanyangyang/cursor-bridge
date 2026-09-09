// Runs the local built MCP against real Cursor; this is not native host injection acceptance.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = mkdtempSync(join(tmpdir(), 'cursor-live-compact-'));
const client = new Client({ name: 'cursor-compact-live', version: '1' });
const project = resolve(process.env.CURSOR_BRIDGE_LIVE_PROJECT || process.cwd());
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve(process.env.CURSOR_BRIDGE_LIVE_SERVER || 'dist/cursor-bridge.mjs')],
  env: { ...process.env, CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
    CURSOR_BRIDGE_HOST_ID: 'live-compact-status',
    CURSOR_BRIDGE_WORKSPACE_FILE: join(directory, 'workspaces.json'),
    CURSOR_BRIDGE_SESSION_FILE: join(directory, 'sessions.json') } });
let taskId;
let terminal = false;
const measurements = [];
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.find(c => c.type === 'text')?.text || '';
  assert.notEqual(response.isError, true, `${name}: ${text}`);
  measurements.push({ name, detail: args.detail || 'default', chars: text.length });
  return args.detail === 'result' ? text : JSON.parse(text);
}
try {
  await client.connect(transport);
  const definitions = await client.listTools();
  assert.ok(definitions.tools.find(t => t.name === 'cursor_status').inputSchema.properties.detail);
  assert.equal((await call('cursor_init', { path: project })).ready, true);
  const submitted = await call('cursor_do', { prompt: '只读桥接验证：读取根目录 package.json，仅报告 name 和 version。不要修改、创建或删除任何文件，不需要解释。',
    background: true, read_only: true, execution: 'fifo', timeout_ms: 600000,
    request_context: { sender: 'model', source: 'model' } });
  taskId = submitted.taskId;
  assert.ok(taskId);
  assert.equal(Object.hasOwn(submitted, 'result'), false);
  const deadline = Date.now() + 620000;
  while (Date.now() < deadline) {
    const state = await call('cursor_status', { task_id: taskId });
    assert.equal(Object.hasOwn(state, 'result'), false);
    assert.equal(state.resultCollectedAt, null);
    console.log(JSON.stringify({ event: 'poll', taskId, status: state.status, phase: state.phase,
      chars: measurements.at(-1).chars }));
    if (state.status === 'completed') { terminal = true; break; }
    if (['failed', 'cancelled', 'abandoned', 'needs_attention'].includes(state.status)) {
      try {
        const diagnostic = await call('cursor_status', { task_id: taskId, detail: 'full' });
        console.error(JSON.stringify({ event: 'failure-diagnostic', taskId, agentId: diagnostic.agentId,
          targetId: diagnostic.targetId, sendState: diagnostic.sendState, modelSelection: diagnostic.modelSelection,
          uiDiagnostic: diagnostic.uiDiagnostic, workspaceBindingChecks: diagnostic.workspaceBindingChecks,
          error: diagnostic.error }));
      } catch (error) { console.error(`Diagnostic collection failed: ${error.message}`); }
      throw new Error(`unexpected state ${state.status}: ${state.error || state.attention}`);
    }
    await new Promise(done => setTimeout(done, 30000));
  }
  assert.equal(terminal, true, 'task did not complete');
  const controlled = await call('cursor_task_control', { task_id: taskId, action: 'reap' });
  assert.equal(Object.hasOwn(controlled.task, 'result'), false);
  const beforeRead = await call('cursor_status');
  assert.ok(beforeRead.unreadResultTaskIds.includes(taskId));
  const body = await call('cursor_status', { task_id: taskId, detail: 'result' });
  assert.match(body, /cursor-bridge-workspace/);
  assert.equal(await call('cursor_status', { task_id: taskId, detail: 'result' }), body);
  const full = await call('cursor_status', { task_id: taskId, detail: 'full' });
  assert.equal(full.result, body);
  assert.equal(full.status, 'completed');
  assert.ok(full.resultCollectedAt);
  assert.match(full.result, /cursor-bridge-workspace/);
  assert.equal(full.modelSelection?.applied, true);
  const repeated = await call('cursor_status', { task_id: taskId, detail: 'full' });
  assert.equal(repeated.result, full.result);
  assert.equal(repeated.resultCollectedAt, full.resultCollectedAt);
  const afterRead = await call('cursor_status');
  assert.equal(afterRead.unreadResultTaskIds.includes(taskId), false);
  console.log(JSON.stringify({ event: 'passed', evidence: 'local-built MCP with real Cursor',
    taskId, agentId: full.agentId, modelSelection: full.modelSelection, measurements }));
} finally {
  if (taskId && !terminal) {
    try {
      const state = await call('cursor_status', { task_id: taskId });
      if (!['completed', 'failed', 'cancelled', 'abandoned'].includes(state.status) && state.agentId) {
        await call('cursor_task_control', { task_id: taskId, action: 'cancel', confirm: true,
          expected_agent_id: state.agentId, reason: 'live test cleanup after failure' });
      }
    } catch (error) { console.error(`Cleanup requires attention: ${error.message}`); }
  }
  await client.close();
  rmSync(directory, { recursive: true, force: true });
}
