import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectPath = resolve(process.env.CURSOR_BRIDGE_LIVE_PROJECT || process.cwd());
const model = String(process.env.CURSOR_BRIDGE_LIVE_MODEL || '').trim();
const effort = String(process.env.CURSOR_BRIDGE_LIVE_EFFORT || '').trim();
if (!model) throw new Error('Set CURSOR_BRIDGE_LIVE_MODEL explicitly; the live session smoke never uses Auto');

const temporary = mkdtempSync(join(tmpdir(), 'cursor-bridge-live-session-'));
const sessionFile = join(temporary, 'sessions-v1.json');
const workspaceFile = join(temporary, 'workspaces.json');
const modelFile = join(temporary, 'model-preferences.json');
const serverPath = resolve('dist/cursor-bridge.mjs');
const baselineStatus = execFileSync('git', ['status', '--porcelain'], { cwd: projectPath, encoding: 'utf8' });
const longRequest = { timeout: 660000, maxTotalTimeout: 660000 };

writeFileSync(modelFile, `${JSON.stringify({
  version: 1,
  targets: { cce: null, cursor_do: { model, effort: effort || null } },
  updatedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');

const env = {
  ...process.env,
  CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
  CURSOR_BRIDGE_SESSION_FILE: sessionFile,
  CURSOR_BRIDGE_WORKSPACE_FILE: workspaceFile,
  CURSOR_BRIDGE_MODEL_PREFERENCES_FILE: modelFile,
  CURSOR_BRIDGE_HOST_ID: 'live-session-continuity',
  CODEX_THREAD_ID: '',
  CLAUDE_PROJECT_DIR: '',
  CLAUDE_CODE_PROJECT_DIR: '',
  CLAUDE_CODE_SESSION_ID: '',
  CLAUDE_SESSION_ID: '',
};

async function openClient(name) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function parseTool(result, name) {
  const text = result.content && result.content.find((item) => item.type === 'text')?.text || '';
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

let first;
let second;
try {
  first = await openClient('cursor-session-live-first-adapter');
  const initialized = parseTool(await first.callTool({
    name: 'cursor_init',
    arguments: { path: projectPath },
  }), 'cursor_init');
  assert.equal(initialized.ready, true);

  const turnOne = parseTool(await first.callTool({
    name: 'cursor_do',
    arguments: {
      prompt: '只读实时测试：读取根目录 package.json，只报告 name 与 version，禁止修改、创建或删除文件，结尾写 SESSION_TURN_ONE_OK。',
      background: false,
      session_mode: 'create',
      read_only: true,
      request_id: 'live-turn-1',
      timeout_ms: 600000,
    },
  }, undefined, longRequest), 'cursor_do create');
  assert.equal(turnOne.status, 'completed');
  assert.equal(turnOne.sessionMode, 'create');
  assert.equal(turnOne.sessionTurn, 1);
  assert.match(turnOne.sessionId, /^cursor-session-/);
  assert.ok(turnOne.agentId);
  assert.equal(turnOne.modelSelection?.applied, true);
  assert.match(String(turnOne.result || ''), /SESSION_TURN_ONE_OK/);
  await first.close();
  first = null;

  second = await openClient('cursor-session-live-second-adapter');
  const sessionStatus = parseTool(await second.callTool({
    name: 'cursor_status',
    arguments: { session_id: turnOne.sessionId },
  }), 'cursor_status session');
  assert.equal(sessionStatus.sessionState, 'ready');
  assert.equal(sessionStatus.agentId, turnOne.agentId);

  const turnTwo = parseTool(await second.callTool({
    name: 'cursor_do',
    arguments: {
      prompt: '继续刚才同一个会话：只报告 scripts.test 的精确值，仍然只读，结尾写 SESSION_TURN_TWO_OK。',
      background: false,
      session_mode: 'continue',
      session_id: turnOne.sessionId,
      read_only: true,
      request_id: 'live-turn-2',
      timeout_ms: 600000,
    },
  }, undefined, longRequest), 'cursor_do continue');
  assert.equal(turnTwo.status, 'completed');
  assert.equal(turnTwo.sessionId, turnOne.sessionId);
  assert.equal(turnTwo.agentId, turnOne.agentId);
  assert.equal(turnTwo.sessionTurn, 2);
  assert.equal(turnTwo.modelSelection?.applied, true);
  assert.match(String(turnTwo.result || ''), /SESSION_TURN_TWO_OK/);

  parseTool(await second.callTool({
    name: 'cursor_session_control',
    arguments: { session_id: turnOne.sessionId, action: 'close' },
  }), 'cursor_session_control close');
  parseTool(await second.callTool({
    name: 'cursor_session_control',
    arguments: { session_id: turnOne.sessionId, action: 'forget', confirm: true },
  }), 'cursor_session_control forget');

  const finalStatus = execFileSync('git', ['status', '--porcelain'], { cwd: projectPath, encoding: 'utf8' });
  assert.equal(finalStatus, baselineStatus, 'live read-only turns changed the workspace');
  console.log(JSON.stringify({
    ok: true,
    model,
    effort: effort || null,
    sessionId: turnOne.sessionId,
    agentId: turnOne.agentId,
    turns: [turnOne.sessionTurn, turnTwo.sessionTurn],
    modelApplied: [turnOne.modelSelection?.applied, turnTwo.modelSelection?.applied],
    markers: ['SESSION_TURN_ONE_OK', 'SESSION_TURN_TWO_OK'],
    workspaceUnchanged: true,
  }, null, 2));
} finally {
  if (first) await first.close().catch(() => {});
  if (second) await second.close().catch(() => {});
  rmSync(temporary, { recursive: true, force: true });
}
