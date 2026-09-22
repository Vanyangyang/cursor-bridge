#!/usr/bin/env node
// Opt-in, real Cursor integration via the built MCP stdio adapter. This is not
// native Codex plugin acceptance. It never changes persistent model defaults.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [projectArg, pluginCwdArg] = process.argv.slice(2);
if (!projectArg || !pluginCwdArg) throw new Error('Usage: node test/live-workspace-binding-smoke.mjs <absolute project> <existing plugin-cache directory>');
const project = resolve(projectArg);
const scratch = mkdtempSync(join(tmpdir(), 'cursor-workspace-live-'));
const other = join(scratch, 'other-project');
mkdirSync(other);
const env = { ...process.env, CURSOR_BRIDGE_WORKSPACE_FILE: join(scratch, 'workspaces.json') };
for (const name of ['CODEX_THREAD_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_PROJECT_DIR', 'CURSOR_BRIDGE_HOST_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CURSOR_PROJECT_PATH']) delete env[name];
const bundle = fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url));
let client;
async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], cwd: resolve(pluginCwdArg), env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'workspace-binding-live-verification', version: '1.0.0' });
  await client.connect(transport);
}
async function call(name, args = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
}
function payload(result) {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}
function failClosed(result, code) {
  assert.equal(result.isError, true);
  const data = payload(result);
  assert.equal(data.error.code, code);
  assert.equal(data.workspaceRecovery.submissionStarted, false);
}
function idle(status) {
  assert.equal(status.busy, false);
  assert.equal(status.queued, 0);
  assert.deepEqual(status.blockingTaskIds, []);
}
try {
  await connect();
  const definitions = await client.listTools();
  assert.ok(definitions.tools.find(tool => tool.name === 'cursor_context_engine').inputSchema.properties.workspace_path);
  const before = payload(await call('cursor_status'));
  assert.equal(before.workspaceKey, 'default');
  assert.equal(before.workspaceConfirmationRequired, true);
  failClosed(await call('cursor_context_engine', { query: 'Do not send this initialization probe.', workspace_path: project }), 'WORKSPACE_CONFIRMATION_REQUIRED');
  // Startup prewarm is serialized ahead of initialization; it cannot overwrite it later.
  const init = payload(await call('cursor_init', { path: project }));
  assert.equal(init.ready, true);
  assert.equal(init.workspaceConfirmationRequired, false);
  assert.equal(init.projectPath, project);
  assert.equal(init.workspaceBinding.ok, true);
  assert.equal(init.workspaceBinding.identitySource, 'registered_workspace_file_uri');
  assert.ok(init.workspaceBinding.workspaceId);
  console.log(JSON.stringify({ stage: 'initialized', version: before.pluginVersion, path: init.projectPath, workspaceId: init.workspaceBinding.workspaceId, action: init.lifecycle.workspaceAction }));
  const ready = payload(await call('cursor_status'));
  idle(ready);
  failClosed(await call('cursor_context_engine', { query: 'Do not send this mismatched CCE probe.', workspace_path: other }), 'WORKSPACE_MISMATCH');
  failClosed(await call('cursor_do', { prompt: 'Do not send this mismatched delegation probe.', workspace_path: other, read_only: true }), 'WORKSPACE_MISMATCH');
  const rejected = payload(await call('cursor_status'));
  assert.deepEqual(rejected.recentTasks, ready.recentTasks);
  idle(rejected);
  const result = await call('cursor_context_engine', {
    query: '只读定位 Canvas 工具栏「从画布移除」按钮到 HTTP API 的调用关系，返回三条可核验的文件行号。不要修改文件。',
    workspace_path: project,
    request_context: { sender: 'model', source: 'model' },
  });
  assert.notEqual(result.isError, true);
  const reply = result.content.find(item => item.type === 'text').text;
  assert.match(reply, /^CCE_SEARCH_RESULT/);
  const after = payload(await call('cursor_status'));
  idle(after);
  assert.deepEqual(after.modelPreferences, before.modelPreferences);
  console.log(JSON.stringify({ stage: 'real_cce_completed', modelPreferences: after.modelPreferences, reply }));
  await client.close();
  client = null;
  await connect();
  const restarted = payload(await call('cursor_status'));
  assert.equal(restarted.workspaceKey, 'default');
  assert.equal(restarted.projectPath, project);
  assert.equal(restarted.workspaceConfirmationRequired, true);
  failClosed(await call('cursor_context_engine', { query: 'Do not send this restart probe.', workspace_path: project }), 'WORKSPACE_CONFIRMATION_REQUIRED');
  const again = payload(await call('cursor_init', { path: project }));
  assert.equal(again.ready, true);
  assert.equal(again.workspaceBinding.workspaceId, init.workspaceBinding.workspaceId);
  assert.deepEqual(payload(await call('cursor_status')).modelPreferences, before.modelPreferences);
  console.log(JSON.stringify({ stage: 'restart_verified', workspaceId: again.workspaceBinding.workspaceId, result: 'PASS' }));
} finally {
  await client?.close();
  rmSync(scratch, { recursive: true, force: true });
}
