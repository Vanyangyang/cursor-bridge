#!/usr/bin/env node
// Opt-in check of a real already-running Cursor with no Bridge connection.
// Does not close Cursor, submit a prompt, or change persistent settings.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [projectArg] = process.argv.slice(2);
if (!projectArg) throw new Error('Usage: node test/live-init-recovery-smoke.mjs <absolute project>');
const project = resolve(projectArg);
const scratch = mkdtempSync(join(tmpdir(), 'cursor-init-recovery-live-'));
const adapterCwd = join(scratch, '.claude', 'plugins', 'cache', 'cursor-bridge');
mkdirSync(adapterCwd, { recursive: true });
const env = {
  ...process.env,
  CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
  CURSOR_BRIDGE_WORKSPACE_FILE: join(scratch, 'workspaces.json'),
  CURSOR_BRIDGE_RUNTIME_FILE: join(scratch, 'runtime.json'),
  CURSOR_BRIDGE_MODEL_PREFERENCES_FILE: join(scratch, 'models.json'),
  CURSOR_BRIDGE_SESSION_FILE: join(scratch, 'sessions.json'),
};
for (const name of ['CODEX_THREAD_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CURSOR_BRIDGE_HOST_ID', 'CURSOR_PROJECT_PATH']) delete env[name];
const bundle = fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], cwd: adapterCwd, env, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'cursor-init-recovery-live', version: '1.0.0' });
function payload(result) {
  assert.notEqual(result.isError, true);
  return result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);
}
async function call(name, arguments_ = {}) {
  return payload(await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 60000 }));
}
try {
  await client.connect(transport);
  const before = await call('cursor_status');
  assert.equal(before.connected, false, 'Requires Cursor to be running without a Bridge connection');
  assert.equal(before.busy, false);
  assert.deepEqual(before.recentTasks, []);
  const initialized = await call('cursor_init', { path: project });
  assert.equal(initialized.ready, false);
  assert.equal(initialized.status, 'running-no-debug');
  assert.equal(initialized.bindingPersisted, true);
  assert.equal(initialized.workspaceConfirmationRequired, false);
  assert.equal(initialized.projectPath, project);
  assert.equal(initialized.retryable, true);
  assert.equal(initialized.lifecycle.needsAction, 'close_cursor_and_retry');
  assert.equal(initialized.lifecycle.retryable, true);
  assert.equal(initialized.nextStep, initialized.lifecycle.nextStep);
  assert.match(initialized.nextStep, /Save your work, exit Cursor normally once/);
  assert.ok(initialized.lifecycle.cursorExecutable);
  assert.ok(initialized.lifecycle.cursorExecutableSource);
  const after = await call('cursor_status');
  assert.equal(after.busy, false);
  assert.equal(after.workspaceBusy, false);
  assert.equal(after.queued, 0);
  assert.deepEqual(after.blockingTaskIds, []);
  assert.deepEqual(after.recentTasks, before.recentTasks);
  assert.deepEqual(after.modelPreferences, before.modelPreferences);
  console.log(JSON.stringify({
    result: 'PASS', version: before.pluginVersion, status: initialized.status,
    retryable: initialized.retryable, needsAction: initialized.lifecycle.needsAction,
    nextStep: initialized.nextStep, cursorExecutable: initialized.lifecycle.cursorExecutable,
    cursorExecutableSource: initialized.lifecycle.cursorExecutableSource,
    modelPreferencesUnchanged: true, tasksCreated: 0,
  }));
} finally {
  await client.close();
  rmSync(scratch, { recursive: true, force: true });
}
