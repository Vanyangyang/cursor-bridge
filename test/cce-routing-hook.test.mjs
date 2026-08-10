import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import {
  MAX_CONTEXT_MODE_DENIALS,
  ROUTING_STATE_TTL_MS,
  classifyCcePrompt,
  handleHookInput,
  readRoutingState,
  routingClearPath,
  routingStatePath,
} from '../hooks/cce-routing.mjs';

const hookPath = fileURLToPath(new URL('../hooks/cce-routing.mjs', import.meta.url));
const hooksJsonPath = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));

function withStateRoot(fn) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cursor-bridge-cce-routing-test-'));
  try {
    return fn(stateRoot);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

test('classifier routes high-confidence project semantics to CCE', () => {
  const positive = [
    '这个项目里宠物灵印状态由谁持有？从存档加载、运行时使用到保存写回的完整链路是什么？',
    'Who owns this state and what is the full load to runtime to save data flow?',
    'IInventory 的实现在哪里注册，运行时如何解析？',
    'Where is final damage implemented and what is its call chain into settlement?',
  ];
  for (const prompt of positive) assert.equal(classifyCcePrompt(prompt).match, true, prompt);
});

test('classifier keeps deterministic and non-project work off CCE', () => {
  const negative = [
    '读取 server.mjs 第 42 行并改成早返回。',
    '运行测试并分析失败日志。',
    '检查 git diff 和最近提交。',
    '查询 React 19 最新官方文档。',
    '不要使用 Cursor，直接本地搜索。',
    '不要用 CCE，直接回答。',
    '别用 Cursor，走本地工具。',
    '不使用 CCE，直接回答。',
    'No Cursor: who owns this state?',
    'Avoid CCE: who owns this state?',
    'Skip Cursor and trace this locally.',
    'Avoid using CCE; who owns this state?',
    'Without using Cursor, who owns this?',
    '读取 package.json，只告诉我 version。',
    'Open Assets/Scenes/Main.unity; show how this behavior works.',
    'Where is FooService implemented? Read it.',
  ];
  for (const prompt of negative) assert.equal(classifyCcePrompt(prompt).match, false, prompt);
});

test('known symbols remain valid CCE starting points for relationship tracing', () => {
  assert.equal(classifyCcePrompt('Trace every caller of FooService and the data flow into storage.').match, true);
  assert.equal(classifyCcePrompt('IInventory 的实现在哪里注册，完整调用链是什么？').match, true);
});

test('prompt state is session-scoped, CCE clears it, and stale state fails open', () => withStateRoot((stateRoot) => {
  const now = 1_700_000_000_000;
  const prompt = '谁持有战斗状态，完整调用链是什么？';
  const first = handleHookInput({ hook_event_name: 'UserPromptSubmit', session_id: 'session-a', prompt }, { stateRoot, now });
  assert.match(first.hookSpecificOutput.additionalContext, /Call cursor_context_engine exactly once/);
  assert.ok(readRoutingState('session-a', { stateRoot, now }));
  assert.equal(readRoutingState('session-b', { stateRoot, now }), null);

  handleHookInput({
    hook_event_name: 'PreToolUse',
    session_id: 'session-a',
    tool_name: 'mcp__plugin_cursor-bridge_cursor-bridge__cursor_context_engine',
  }, { stateRoot, now: now + 1 });
  assert.equal(readRoutingState('session-a', { stateRoot, now: now + 1 }), null);

  handleHookInput({ hook_event_name: 'UserPromptSubmit', session_id: 'session-a', prompt }, { stateRoot, now });
  assert.equal(readRoutingState('session-a', { stateRoot, now: now + ROUTING_STATE_TTL_MS + 1 }), null);
}));

test('CCE waits for an in-flight session lock before clearing routing state', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cursor-bridge-cce-routing-clear-race-'));
  try {
    const now = Date.now();
    const sessionId = 'clear-race-session';
    handleHookInput({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: '谁持有这个状态，完整数据流是什么？',
    }, { stateRoot, now });
    const stateFile = routingStatePath(sessionId, { stateRoot });
    const lockFile = `${stateFile}.lock`;
    writeFileSync(lockFile, 'held\n', 'utf8');

    const releaser = spawn(process.execPath, ['-e', "setTimeout(() => { const fs = require('node:fs'); fs.writeFileSync(process.env.ROUTING_TEST_STATE, JSON.stringify({ createdAt: 1, expiresAt: Date.now() + 60_000, reason: 'race', denials: 1 }) + '\\n'); fs.rmSync(process.env.ROUTING_TEST_LOCK, { force: true }); }, 40)"], {
      env: { ...process.env, ROUTING_TEST_LOCK: lockFile, ROUTING_TEST_STATE: stateFile },
      windowsHide: true,
      stdio: 'ignore',
    });
    const released = new Promise((resolveReleased, rejectReleased) => {
      releaser.on('error', rejectReleased);
      releaser.on('close', resolveReleased);
    });

    handleHookInput({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'mcp__plugin_cursor-bridge_cursor-bridge__cursor_context_engine',
    }, { stateRoot, now: now + 1 });
    await released;
    assert.equal(existsSync(lockFile), false);
    assert.equal(readRoutingState(sessionId, { stateRoot, now: now + 1 }), null);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('a stuck foreign lock cannot resurrect state after a CCE attempt', () => withStateRoot((stateRoot) => {
  const now = Date.now();
  const sessionId = 'stuck-lock-session';
  handleHookInput({
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    prompt: '谁持有这个状态，完整数据流是什么？',
  }, { stateRoot, now });
  const stateFile = routingStatePath(sessionId, { stateRoot });
  const lockFile = `${stateFile}.lock`;
  writeFileSync(lockFile, 'foreign-owner\n', 'utf8');

  handleHookInput({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: 'mcp__plugin_cursor-bridge_cursor-bridge__cursor_context_engine',
  }, { stateRoot, now: now + 1 });

  assert.equal(existsSync(lockFile), true);
  assert.equal(existsSync(routingClearPath(sessionId, { stateRoot })), true);
  assert.equal(readRoutingState(sessionId, { stateRoot, now: now + 1 }), null);
  const fallback = handleHookInput({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: 'mcp__plugin_context-mode_context-mode__ctx_batch_execute',
  }, { stateRoot, now: now + 2 });
  assert.equal(fallback, null);
}));

test('parallel PreToolUse hooks never exceed the bounded denial count', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cursor-bridge-cce-routing-parallel-'));
  try {
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: stateRoot };
    const sessionId = 'parallel-session';
    const submit = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        prompt: '谁持有这个状态，完整调用链是什么？',
      }),
      encoding: 'utf8',
      env,
      windowsHide: true,
    });
    assert.equal(submit.status, 0);

    const outputs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolveOutput, rejectOutput) => {
      const child = spawn(process.execPath, [hookPath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', rejectOutput);
      child.on('close', (code) => resolveOutput({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        tool_name: 'mcp__plugin_context-mode_context-mode__ctx_batch_execute',
        tool_input: {},
      }));
    })));

    assert.equal(
      outputs.every((output) => output.code === 0 && output.stderr.trim() === ''),
      true,
      JSON.stringify(outputs),
    );
    const denialCount = outputs.filter((output) => {
      if (!output.stdout.trim()) return false;
      return JSON.parse(output.stdout).hookSpecificOutput?.permissionDecision === 'deny';
    }).length;
    assert.ok(denialCount >= 1);
    assert.ok(denialCount <= MAX_CONTEXT_MODE_DENIALS);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('competing context-mode collection is denied twice then fails open', () => withStateRoot((stateRoot) => {
  const now = 1_700_000_000_000;
  handleHookInput({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-a',
    prompt: 'What owns this state and what is the end-to-end data flow?',
  }, { stateRoot, now });

  for (let index = 0; index < MAX_CONTEXT_MODE_DENIALS; index += 1) {
    const denied = handleHookInput({
      hook_event_name: 'PreToolUse',
      session_id: 'session-a',
      tool_name: 'mcp__plugin_context-mode_context-mode__ctx_batch_execute',
    }, { stateRoot, now: now + index + 1 });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Call cursor_context_engine once/);
  }

  const allowed = handleHookInput({
    hook_event_name: 'PreToolUse',
    session_id: 'session-a',
    tool_name: 'mcp__plugin_context-mode_context-mode__ctx_execute',
  }, { stateRoot, now: now + 3 });
  assert.equal(allowed, null);
  assert.equal(readRoutingState('session-a', { stateRoot, now: now + 3 }), null);
}));

test('state write failures fail open instead of repeating stale denials', () => withStateRoot((stateRoot) => {
  const now = 1_700_000_000_000;
  handleHookInput({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'write-failure-session',
    prompt: '谁持有这个状态，完整数据流是什么？',
  }, { stateRoot, now });
  assert.ok(readRoutingState('write-failure-session', { stateRoot, now }));

  const decision = handleHookInput({
    hook_event_name: 'PreToolUse',
    session_id: 'write-failure-session',
    tool_name: 'mcp__plugin_context-mode_context-mode__ctx_batch_execute',
  }, { stateRoot, now: now + 1, failWrites: true });
  assert.equal(decision, null);
  assert.equal(readRoutingState('write-failure-session', { stateRoot, now: now + 1 }), null);
}));

test('a non-semantic prompt clears an earlier semantic routing state', () => withStateRoot((stateRoot) => {
  const now = 1_700_000_000_000;
  handleHookInput({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'replacement-session',
    prompt: '谁持有这个状态，完整数据流是什么？',
  }, { stateRoot, now });
  assert.ok(readRoutingState('replacement-session', { stateRoot, now }));

  handleHookInput({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'replacement-session',
    prompt: '运行测试并查看失败日志。',
  }, { stateRoot, now: now + 1 });
  assert.equal(readRoutingState('replacement-session', { stateRoot, now: now + 1 }), null);
}));

test('hook manifest uses narrow MCP matchers and exec-form plugin paths', () => {
  const manifest = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
  const preTool = manifest.hooks.PreToolUse[0];
  const handler = preTool.hooks[0];
  const matcher = new RegExp(preTool.matcher);
  assert.equal(matcher.test('mcp__plugin_context-mode_context-mode__ctx_batch_execute'), true);
  assert.equal(matcher.test('mcp__plugin_context-mode_context-mode__ctx_execute_file'), true);
  assert.equal(matcher.test('mcp__plugin_cursor-bridge_cursor-bridge__cursor_context_engine'), true);
  assert.equal(matcher.test('mcp__plugin_cursor-bridge_cursor-bridge__cursor_search_deep'), true);
  assert.equal(matcher.test('Grep'), false);
  assert.equal(matcher.test('mcp__unrelated__tool'), false);
  assert.doesNotMatch(preTool.matcher, /Grep|Glob|Bash|Read|Agent|mcp__\.\*/);
  assert.equal(handler.command, 'node');
  assert.deepEqual(handler.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/cce-routing.mjs']);
});

test('subprocess hook smoke test writes state, denies context-mode, and clears on CCE', () => withStateRoot((stateRoot) => {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: stateRoot };
  const sessionId = 'subprocess-session';
  const submit = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: '这个模块的状态由谁持有，完整数据流是什么？',
    }),
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(submit.status, 0);
  assert.match(JSON.parse(submit.stdout).hookSpecificOutput.additionalContext, /cursor_context_engine/);
  assert.ok(readFileSync(routingStatePath(sessionId, { stateRoot: join(stateRoot, 'cce-routing-state') }), 'utf8'));

  const denied = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'mcp__plugin_context-mode_context-mode__ctx_batch_execute',
      tool_input: {},
    }),
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const cce = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'mcp__plugin_cursor-bridge_cursor-bridge__cursor_context_engine',
      tool_input: { query: 'trace state ownership' },
    }),
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(cce.status, 0);
  assert.equal(cce.stdout, '');
}));
