#!/usr/bin/env node
// Exercise only stdio protocol and admission gates; never initialize or submit Cursor work.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const requiredTools = [
  'cursor_init', 'cursor_context_engine', 'cursor_do', 'cursor_task_control',
  'cursor_session_control', 'cursor_runtime', 'cursor_model', 'cursor_status',
];

function payload(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'MCP result must contain JSON text');
  return JSON.parse(text);
}

function idle(status) {
  assert.equal(status.busy, false, 'No task may become busy');
  assert.equal(status.workspaceBusy, false, 'Workspace admission must finish');
  assert.equal(status.queued, 0, 'No task may be queued');
  assert.equal(status.globallyBlocked, false, 'No reservation may be created');
  assert.deepEqual(status.blockingTaskIds, []);
  assert.deepEqual(status.activeParallel, []);
}

async function smoke() {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 2, 'Usage: node test/smoke-mcp.mjs [bundle-path] [expected-version]');
  const bundle = resolve(args[0] || 'dist/cursor-bridge.mjs');
  assert.ok(existsSync(bundle), `Bundle does not exist: ${bundle}`);
  const expectedVersion = args[1] || JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const workspace = process.cwd();
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-bridge-mcp-smoke-'));
  // A cache-shaped cwd deliberately has no trustworthy host workspace identity.
  const adapterCwd = join(scratch, '.claude', 'plugins', 'cache', 'cursor-bridge');
  const files = {
    CURSOR_BRIDGE_WORKSPACE_FILE: join(scratch, 'workspaces.json'),
    CURSOR_BRIDGE_RUNTIME_FILE: join(scratch, 'runtime.json'),
    CURSOR_BRIDGE_MODEL_PREFERENCES_FILE: join(scratch, 'models.json'),
    CURSOR_BRIDGE_SESSION_FILE: join(scratch, 'sessions.json'),
  };
  let client;
  // Reserve a private port and reject its probes, so status never contacts a real Cursor.
  const isolatedPort = createServer((socket) => socket.destroy());
  try {
    mkdirSync(adapterCwd, { recursive: true });
    const configs = [
      { version: 1, bindings: {} },
      { version: 1, mode: 'normal' },
      { version: 1, targets: { cce: null, cursor_do: null }, updatedAt: null },
      { version: 1, sessions: {}, updatedAt: null },
    ];
    const snapshots = Object.values(files).map((file, index) => {
      const text = `${JSON.stringify(configs[index])}\n`;
      writeFileSync(file, text);
      return { file, text };
    });
    await new Promise((accept, reject) => {
      isolatedPort.once('error', reject);
      isolatedPort.listen(0, '127.0.0.1', accept);
    });
    const hostIdentity = new Set([
      'CODEX_THREAD_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_PROJECT_DIR',
      'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CURSOR_PROJECT_PATH', 'CURSOR_EXE',
    ]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
      typeof value === 'string' && !name.toUpperCase().startsWith('CURSOR_BRIDGE_')
      && !hostIdentity.has(name.toUpperCase())));
    Object.assign(env, files, {
      CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
      CURSOR_BRIDGE_CDP_PORT: String(isolatedPort.address().port),
      CURSOR_BRIDGE_LIFECYCLE_DIR: join(scratch, 'lifecycle'),
      CURSOR_BRIDGE_WINDOW_STATE_FILE: join(scratch, 'windows.json'),
    });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [bundle], cwd: adapterCwd, env, stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    client = new Client({ name: 'cursor-bridge-mcp-smoke', version: '1.0.0' });
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, expectedVersion, 'MCP server version must match the expected bundle');
    const { tools } = await client.listTools();
    const definitions = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of requiredTools) assert.ok(definitions.has(name), `Missing required tool: ${name}`);
    for (const name of ['cursor_context_engine', 'cursor_do']) {
      assert.ok(definitions.get(name).inputSchema.properties?.workspace_path, `${name} requires workspace_path in its schema`);
    }
    for (const name of ['session_mode', 'request_context']) {
      assert.ok(definitions.get('cursor_do').inputSchema.properties?.[name], `cursor_do requires ${name} in its schema`);
    }
    async function call(name, arguments_ = {}) {
      return client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 15000 });
    }
    async function status() {
      const result = await call('cursor_status', { detail: 'full' });
      assert.notEqual(result.isError, true, 'Read-only status must succeed');
      const data = payload(result);
      assert.equal(data.pluginVersion, expectedVersion);
      assert.equal(data.workspaceKey, 'default');
      assert.equal(data.workspaceConfirmationRequired, true);
      assert.equal(data.startupBehavior, 'manual_launch_only');
      assert.equal(data.connected, false, 'Status must use the isolated port');
      idle(data);
      return data;
    }
    const before = await status();
    assert.deepEqual(before.recentTasks, []);
    const probes = [
      ['cursor_context_engine', { query: 'Admission smoke probe; must never reach Cursor.', workspace_path: workspace }],
      ['cursor_do', { prompt: 'Admission smoke probe; must never reach Cursor.', workspace_path: workspace, read_only: true }],
    ];
    for (const [name, arguments_] of probes) {
      const result = await call(name, arguments_);
      assert.equal(result.isError, true, `${name} must reject an unconfirmed workspace`);
      const data = payload(result);
      assert.equal(data.error?.code, 'WORKSPACE_CONFIRMATION_REQUIRED');
      assert.equal(data.workspaceRecovery?.submissionStarted, false);
      assert.deepEqual((await status()).recentTasks, before.recentTasks);
    }
    const model = await call('cursor_model', { action: 'show' });
    assert.notEqual(model.isError, true, 'Read-only model inspection must succeed');
    assert.deepEqual(payload(model).modelPreferences, before.modelPreferences);
    // Empty arguments are the read-only runtime view; action=show can alter presentation.
    const runtimeSchema = definitions.get('cursor_runtime').inputSchema;
    let runtimeShow = 'skipped-schema-requires-arguments';
    if (!(runtimeSchema.required || []).length) {
      const runtime = await call('cursor_runtime');
      assert.notEqual(runtime.isError, true, 'Read-only runtime inspection must succeed');
      assert.equal(payload(runtime).startupBehavior, 'manual_launch_only');
      runtimeShow = 'passed';
    }
    const after = await status();
    assert.deepEqual(after.recentTasks, before.recentTasks);
    assert.deepEqual(after.modelPreferences, before.modelPreferences);
    for (const { file, text } of snapshots) assert.equal(readFileSync(file, 'utf8'), text, 'Read-only probes must preserve temporary configuration');
    return { result: 'PASS', bundle, version: expectedVersion, toolCount: tools.length, workspaceRejections: 2, submissionStarted: false, modelPreferencesUnchanged: true, runtimeShow };
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        if (isolatedPort.listening) await new Promise((accept, reject) => isolatedPort.close((error) => error ? reject(error) : accept()));
      } finally {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
}

try {
  process.stdout.write(`${JSON.stringify(await smoke())}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ result: 'FAIL', error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
