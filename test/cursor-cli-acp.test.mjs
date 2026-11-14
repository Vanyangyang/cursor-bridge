import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { CursorBridge } from '../server.mjs';
import { writeCcePreferences } from '../cursor-cce-preferences.mjs';
import {
  CursorCliAcpManager,
  buildPermissionDenialResult,
  parseAcpModelPreference,
  resolveAcpModelDependentOptions,
  resolveAcpModelOption,
  verifyAcpConfigReadback,
} from '../cursor-cli-acp.mjs';

const answer = 'CCE_SEARCH_RESULT\nintent: verify acp\ncoverage: focused | test\nevidence:\n- cursor-cli-acp.mjs:1 | CursorCliAcpManager | acp test | source-read\ngaps: none\nconfidence: high';

async function until(condition, limit = 200) {
  for (let i = 0; i < limit; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected asynchronous condition was not reached');
}

function createFakeAcpSpawn(handler) {
  const processes = [];
  const stopped = [];
  let nextPid = 40000;

  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, {
      pid: ++nextPid,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    });
    const sentMessages = [];
    const procState = {
      command,
      args,
      options,
      child,
      sentMessages,
      emitJson(obj) {
        child.stdout.write(JSON.stringify(obj) + '\n');
      },
      finish(code = 0, signal = null) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.exitCode = code;
        child.signalCode = signal;
        setImmediate(() => child.emit('close', code, signal));
      },
    };
    let lineBuffer = '';
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        lineBuffer += chunk.toString('utf8');
        let idx;
        while ((idx = lineBuffer.indexOf('\n')) >= 0) {
          const raw = lineBuffer.slice(0, idx).trim();
          lineBuffer = lineBuffer.slice(idx + 1);
          if (!raw) continue;
          const msg = JSON.parse(raw);
          sentMessages.push(msg);
          Promise.resolve(handler(msg, procState)).catch(() => {});
        }
        callback();
      },
    });
    processes.push(procState);
    setImmediate(() => child.emit('spawn'));
    return child;
  };

  const killTree = async child => {
    stopped.push(child.pid);
    const procState = processes.find(item => item.child === child);
    procState?.finish(1, 'SIGKILL');
    return true;
  };

  return { spawn, killTree, processes, stopped };
}

function makeTempEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'cce-acp-test-'));
  const project = join(root, 'project');
  const configDir = join(root, 'native-config');
  mkdirSync(project, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'cli-config.json'), JSON.stringify({ model: { modelId: 'auto' } }) + '\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, env: { ...process.env, CURSOR_CONFIG_DIR: configDir } };
}

function makeStandardAcpResponder({
  initialModel = 'grok-4.6',
  initialEffort = 'medium',
  initialFast = 'true',
  initialMode = 'agent',
  skipSetResponses = false,
  tamperReadback = null,
} = {}) {
  let sessionSeq = 0;
  let processModel = initialModel;
  const sessionState = new Map();

  const buildConfigOptions = (sid) => {
    const sess = sessionState.get(sid);
    if (processModel === 'grok-4.7') {
      return [
        { id: 'mode', currentValue: sess.mode, options: [{ value: 'agent' }, { value: 'plan' }, { value: 'ask' }] },
        { id: 'model', currentValue: processModel, options: [{ value: 'grok-4.6', name: 'Grok 4.6' }, { value: 'grok-4.7', name: 'Grok 4.7' }] },
        { id: 'reasoning_effort', currentValue: sess.thinking, options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] },
        { id: 'fast', currentValue: sess.fast, options: [{ value: 'false' }, { value: 'true' }] },
      ];
    }
    return [
      { id: 'mode', currentValue: sess.mode, options: [{ value: 'agent' }, { value: 'plan' }, { value: 'ask' }] },
      { id: 'model', currentValue: processModel, options: [{ value: 'grok-4.6', name: 'Grok 4.6' }, { value: 'grok-4.7', name: 'Grok 4.7' }] },
      { id: 'effort', currentValue: sess.thinking, options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
      { id: 'fast', currentValue: sess.fast, options: [{ value: 'false' }, { value: 'true' }] },
    ];
  };

  return (msg, proc) => {
    if (msg.method === 'initialize') {
      proc.emitJson({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, capabilities: {} } });
      return;
    }
    if (msg.method === 'session/new') {
      const sid = `acp-sess-${++sessionSeq}`;
      sessionState.set(sid, { mode: initialMode, thinking: initialEffort, fast: initialFast });
      proc.emitJson({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid, configOptions: buildConfigOptions(sid) } });
      return;
    }
    if (msg.method === 'session/set_config_option') {
      if (skipSetResponses) return;
      const { sessionId, configId, value } = msg.params;
      const sess = sessionState.get(sessionId);
      if (configId === 'model') processModel = value;
      else if (configId === 'mode') sess.mode = value;
      else if (configId === 'effort' || configId === 'reasoning_effort') sess.thinking = value;
      else if (configId === 'fast') sess.fast = value;
      let options = buildConfigOptions(sessionId);
      if (typeof tamperReadback === 'function') options = tamperReadback(options, msg.params);
      proc.emitJson({ jsonrpc: '2.0', id: msg.id, result: { configOptions: options } });
      return;
    }
    if (msg.method === 'session/prompt') {
      const sid = msg.params.sessionId;
      proc.emitJson({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { text: answer } } },
      });
      proc.emitJson({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
  };
}

test('pure ACP config mappers reject Auto, pick unique model/thinking/fast/mode, and fail closed on mismatch', () => {
  assert.throws(() => parseAcpModelPreference({ model: 'Auto', effort: 'high' }), { code: 'CURSOR_CLI_MODEL_REQUIRED' });
  const parsedFast = parseAcpModelPreference({ model: 'grok-4.6-fast', effort: 'medium' });
  assert.equal(parsedFast.requestedFast, true);
  assert.equal(parsedFast.bareStem, 'grok-4.6');

  const modelRes = resolveAcpModelOption([
    {
      id: 'model',
      currentValue: 'grok-4.6',
      options: [
        { value: 'grok-4.6[effort=high]', name: 'Variant' },
        { value: 'grok-4.6', name: 'Grok 4.6' },
      ],
    },
  ], parsedFast);
  assert.equal(modelRes.ok, true);
  assert.equal(modelRes.desiredValue, 'grok-4.6');

  const dep = resolveAcpModelDependentOptions([
    { id: 'mode', currentValue: 'agent', options: [{ value: 'agent' }, { value: 'ask' }] },
    { id: 'reasoning_effort', currentValue: 'high', options: [{ value: 'medium' }, { value: 'high' }] },
    { id: 'fast', currentValue: 'false', options: [{ value: 'false' }, { value: 'true' }] },
  ], parsedFast);
  assert.equal(dep.ok, true);
  assert.equal(dep.thinking.configId, 'reasoning_effort');
  assert.equal(dep.fast.desiredValue, 'true');

  const badReadback = verifyAcpConfigReadback([
    { id: 'mode', currentValue: 'ask' },
    { id: 'model', currentValue: 'grok-4.6' },
    { id: 'effort', currentValue: 'high' },
    { id: 'fast', currentValue: 'true' },
  ], { modeValue: 'ask', modelValue: 'grok-4.6', thinkingConfigId: 'effort', thinkingValue: 'medium', fastValue: 'true' });
  assert.equal(badReadback.ok, false);
  assert.equal(badReadback.reason, 'thinking_readback_mismatch');

  assert.deepEqual(
    buildPermissionDenialResult({ options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny-1', kind: 'reject_once' }] }),
    { outcome: { outcome: 'selected', optionId: 'deny-1' } },
  );
  assert.deepEqual(buildPermissionDenialResult({ options: [{ optionId: 'allow', kind: 'allow_once' }] }), {
    outcome: { outcome: 'cancelled' },
  });
});

test('ACP initialize, two-step model-dependent options, readback mismatch, and pre-prompt fallback never send session/prompt', async t => {
  const { project, env } = makeTempEnv(t);
  const cli = { brand: 'Cursor', launcher: { command: process.execPath, args: ['mock-cli.js'] }, models: [] };

  // Dynamic two-step config change: switching grok-4.6 -> grok-4.7 changes thinking configId from effort to reasoning_effort.
  const mock1 = createFakeAcpSpawn(makeStandardAcpResponder({ initialModel: 'grok-4.6', initialEffort: 'low', initialFast: 'true' }));
  const mgr1 = new CursorCliAcpManager({
    env,
    spawn: mock1.spawn,
    killTree: mock1.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-1', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: ['x'], partialErrorCategory: null }),
  });
  const warm = await mgr1.prewarm({ projectPath: project, modelPreference: { model: 'grok-4.7', effort: 'xhigh' }, cli });
  assert.equal(warm.warmed, true);
  assert.equal(mock1.processes[0].sentMessages[0].params.clientCapabilities._meta.parameterizedModelPicker, true);
  const setCalls = mock1.processes[0].sentMessages.filter(m => m.method === 'session/set_config_option').map(m => m.params);
  assert.equal(setCalls[0].configId, 'model');
  assert.equal(setCalls[0].value, 'grok-4.7');
  assert.ok(setCalls.some(c => c.configId === 'reasoning_effort' && c.value === 'xhigh'));
  assert.ok(setCalls.some(c => c.configId === 'fast' && c.value === 'false'));
  assert.ok(setCalls.some(c => c.configId === 'mode' && c.value === 'ask'));
  await mgr1.shutdown();

  // Readback mismatch on mode must abort before sending any session/prompt and return confirmedNotSent fallback.
  const mock2 = createFakeAcpSpawn(makeStandardAcpResponder({
    tamperReadback: (options) => options.map(o => (o.id === 'mode' ? { ...o, currentValue: 'agent' } : o)),
  }));
  const mgr2 = new CursorCliAcpManager({
    env,
    spawn: mock2.spawn,
    killTree: mock2.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-mismatch', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  const res2 = await mgr2.runOrFallback({
    projectPath: project,
    prompt: 'never send prompt',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
    cli,
    allowColdStart: true,
  });
  assert.equal(res2.usedAcp, false);
  assert.equal(res2.confirmedNotSent, true);
  assert.equal(res2.fallbackReason, 'mode_readback_mismatch');
  assert.equal(mock2.processes[0].sentMessages.some(m => m.method === 'session/prompt'), false);
  await mgr2.shutdown();
});

test('ACP already-matching settings skip set_config_option, pool serves prebuilt sessions and replenishes, cold path falls back once', async t => {
  const { project, env } = makeTempEnv(t);
  const cli = { brand: 'Cursor', launcher: { command: process.execPath, args: ['mock-cli.js'] }, models: [] };

  const mock = createFakeAcpSpawn(makeStandardAcpResponder({
    initialModel: 'grok-4.6',
    initialEffort: 'medium',
    initialFast: 'true',
    initialMode: 'ask',
  }));
  const mgr = new CursorCliAcpManager({
    env,
    spawn: mock.spawn,
    killTree: mock.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-pool', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: ['srv'], partialErrorCategory: null }),
  });

  // Cold start returns confirmedNotSent fallback immediately while prewarming in background.
  const cold = await mgr.runOrFallback({
    projectPath: project,
    prompt: 'first cold query',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
    cli,
  });
  assert.equal(cold.usedAcp, false);
  assert.equal(cold.confirmedNotSent, true);
  assert.equal(cold.fallbackReason, 'acp_cold_start');

  await until(() => mgr.statusView().readySessions === 1);
  // Already matching config skips session/set_config_option completely!
  assert.equal(mock.processes[0].sentMessages.some(m => m.method === 'session/set_config_option'), false);

  const warm1 = await mgr.runOrFallback({
    projectPath: project,
    prompt: 'second warm query',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
    cli,
  });
  assert.equal(warm1.usedAcp, true);
  assert.equal(warm1.cliTransport, 'acp');
  assert.equal(warm1.modelSelection.verificationSource, 'cursor_cli_acp_config');
  assert.equal(warm1.result, answer);

  // Immediately run another query while or after pool replenishes; single warm process creates/uses another session.
  const warm2 = await mgr.runOrFallback({
    projectPath: project,
    prompt: 'third warm query',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
    cli,
  });
  assert.equal(warm2.usedAcp, true);
  assert.equal(mock.processes.length, 1);
  await until(() => mgr.statusView().readySessions === 1);
  assert.equal(mgr.statusView().promptsServed, 2);
  await mgr.shutdown();
});

test('ACP denies session/request_permission and rejects fs, terminal, and cursor RPCs cleanly', async t => {
  const { project, env } = makeTempEnv(t);
  const cli = { brand: 'Cursor', launcher: { command: process.execPath, args: ['mock-cli.js'] }, models: [] };
  const agentRequestReplies = [];
  const baseResponder = makeStandardAcpResponder({ initialMode: 'ask' });

  const mock = createFakeAcpSpawn(async (msg, proc) => {
    if (msg.id !== undefined && msg.method === undefined) {
      agentRequestReplies.push(msg);
      return;
    }
    if (msg.method === 'session/prompt') {
      proc.emitJson({
        jsonrpc: '2.0',
        id: 501,
        method: 'session/request_permission',
        params: { sessionId: msg.params.sessionId, options: [{ optionId: 'allow-1', kind: 'allow_always' }, { optionId: 'rej-1', kind: 'reject_once' }] },
      });
      proc.emitJson({ jsonrpc: '2.0', id: 502, method: 'fs/read_text_file', params: { path: 'x' } });
      proc.emitJson({ jsonrpc: '2.0', id: 503, method: 'terminal/create', params: { command: 'echo' } });
      proc.emitJson({ jsonrpc: '2.0', id: 504, method: 'cursor/ask_question', params: {} });
      await until(() => agentRequestReplies.length === 4);
      proc.emitJson({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: answer } } },
      });
      proc.emitJson({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }
    return baseResponder(msg, proc);
  });

  const mgr = new CursorCliAcpManager({
    env,
    spawn: mock.spawn,
    killTree: mock.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-perm', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  await mgr.prewarm({ projectPath: project, modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli });
  const out = await mgr.runOrFallback({
    projectPath: project,
    prompt: 'check permissions',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
    cli,
  });
  assert.equal(out.usedAcp, true);
  assert.deepEqual(agentRequestReplies.find(r => r.id === 501).result, { outcome: { outcome: 'selected', optionId: 'rej-1' } });
  for (const id of [502, 503, 504]) {
    assert.equal(agentRequestReplies.find(r => r.id === id).error.code, -32601);
  }
  await mgr.shutdown();
});

test('ACP cancel proves end via cancelled stopReason, kills tree on timeout, and preserves dirs when termination unconfirmed', async t => {
  const { project, env } = makeTempEnv(t);
  const cli = { brand: 'Cursor', launcher: { command: process.execPath, args: ['mock-cli.js'] }, models: [] };

  // Case 1: cooperative cancel preserves warm process.
  const base1 = makeStandardAcpResponder({ initialMode: 'ask' });
  let pendingPromptId = null;
  const mock1 = createFakeAcpSpawn((msg, proc) => {
    if (msg.method === 'session/prompt') {
      pendingPromptId = msg.id;
      return;
    }
    if (msg.method === 'session/cancel' && pendingPromptId) {
      proc.emitJson({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } });
      pendingPromptId = null;
      return;
    }
    return base1(msg, proc);
  });
  const mgr1 = new CursorCliAcpManager({
    env,
    spawn: mock1.spawn,
    killTree: mock1.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-cancel', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  await mgr1.prewarm({ projectPath: project, modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli });
  const ac1 = new AbortController();
  const p1 = mgr1.runOrFallback({ projectPath: project, prompt: 'abort me', modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli, signal: ac1.signal });
  await until(() => pendingPromptId !== null);
  ac1.abort();
  await assert.rejects(p1, err => err.code === 'CURSOR_CLI_CANCELLED' && err.stopConfirmed === true && err.confirmedTerminal === true && err.confirmedNotSent === false);
  assert.equal(mgr1.statusView().warmProcesses, 1);
  assert.equal(mock1.stopped.length, 0);
  await mgr1.shutdown();

  // Case 2: unresponsive cancel + unconfirmed killTree retains scope directories & PID.
  const base2 = makeStandardAcpResponder({ initialMode: 'ask' });
  let prompt2Sent = false;
  const mock2 = createFakeAcpSpawn((msg, proc) => {
    if (msg.method === 'session/prompt') { prompt2Sent = true; return; }
    return base2(msg, proc);
  });
  const mgr2 = new CursorCliAcpManager({
    env,
    spawn: mock2.spawn,
    killTree: async () => false,
    cancelGraceMs: 25,
    closeTimeoutMs: 25,
    inspectIdentity: async () => ({ available: true, key: 'id-orphan', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  await mgr2.prewarm({ projectPath: project, modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli });
  const scopeDir = mock2.processes[0].options.env.CURSOR_CONFIG_DIR;
  const dataDir = mock2.processes[0].options.env.CURSOR_DATA_DIR;
  const ac2 = new AbortController();
  const p2 = mgr2.runOrFallback({ projectPath: project, prompt: 'hang', modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli, signal: ac2.signal });
  await until(() => prompt2Sent);
  ac2.abort();
  let orphanErr;
  try {
    await p2;
    assert.fail('expected cancel failure');
  } catch (err) {
    orphanErr = err;
  }
  assert.equal(orphanErr.code, 'CURSOR_CLI_CANCELLED');
  assert.equal(orphanErr.stopConfirmed, false);
  assert.equal(orphanErr.confirmedTerminal, false);
  assert.equal(orphanErr.cliConfigDirectory, scopeDir);
  assert.equal(orphanErr.cliDataDirectory, dataDir);
  assert.ok(orphanErr.cliProcessId > 0);
  await access(scopeDir);
  await access(dataDir);
  // Cleanup orphan dirs manually after verifying retention
  await Promise.all([rmSync(scopeDir, { recursive: true, force: true }), rmSync(dataDir, { recursive: true, force: true })]);
  await mgr2.shutdown();
});

test('CursorBridge never falls back to print after ACP prompt crash, bypasses ACP for multi-root/local-provider/off, and prewarms on cursor_init', async t => {
  const { root, project, env } = makeTempEnv(t);
  const cceSourceFile = join(root, 'source.json');
  writeCcePreferences(cceSourceFile, { source: 'cli' });

  // Post-dispatch crash on ACP must fail without ever calling print cliRunner.
  const baseCrash = makeStandardAcpResponder({ initialMode: 'ask' });
  const mockCrash = createFakeAcpSpawn((msg, proc) => {
    if (msg.method === 'session/prompt') {
      proc.finish(1);
      return;
    }
    return baseCrash(msg, proc);
  });
  const cli = { brand: 'Cursor', launcher: { command: process.execPath, args: ['mock-cli.js'] }, models: [{ id: 'grok-4.6-medium-fast', name: 'Grok 4.6 Medium Fast' }] };
  const acpMgr = new CursorCliAcpManager({
    env,
    spawn: mockCrash.spawn,
    killTree: mockCrash.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-crash', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  let printRunnerCalls = 0;
  const bridge = new CursorBridge({
    projectPath: project,
    cceSourceFile,
    runtimeFile: null,
    modelPreferencesFile: null,
    sessionFile: null,
    workspaceFile: join(root, 'workspaces.json'),
    cliInspector: async () => cli,
    cliRunner: async () => { printRunnerCalls += 1; return { result: answer, sessionId: 'print-s1', modelSelection: { applied: true } }; },
    acpManager: acpMgr,
  });
  bridge.modelPreferences = { version: 1, targets: { cce: { model: 'grok-4.6-fast', effort: 'medium' }, cursor_do: null }, updatedAt: null };
  t.after(async () => { await bridge.shutdownCli(); });

  const initRes = await bridge.initializeWorkspace(project);
  assert.equal(initRes.ready, true);
  // Background prewarm finishes without blocking initializeWorkspace.
  await until(() => acpMgr.statusView().readySessions === 1);
  assert.equal((await bridge.status()).cli.acp.state, 'ready');

  let crashErr;
  await assert.rejects(
    bridge.contextEngine('crash after dispatch', { workspacePath: project }),
    err => {
      crashErr = err;
      return err.code === 'CURSOR_CLI_EXIT_ERROR' && err.confirmedNotSent === false && err.confirmedTerminal === false;
    },
  );
  if (crashErr?.cliConfigDirectory) rmSync(crashErr.cliConfigDirectory, { recursive: true, force: true });
  if (crashErr?.cliDataDirectory) rmSync(crashErr.cliDataDirectory, { recursive: true, force: true });
  assert.equal(printRunnerCalls, 0, 'Must never resubmit via one-shot print after ACP dispatched prompt');

  // Capability failure caching & off switch & multi-root skip & idle timer recycle
  const offMgr = new CursorCliAcpManager({
    env: { ...env, CURSOR_BRIDGE_CCE_CLI_ACP: 'off' },
    spawn: () => assert.fail('disabled ACP must not spawn'),
  });
  assert.equal(offMgr.statusView().state, 'disabled');
  const offRes = await offMgr.runOrFallback({
    projectPath: project,
    prompt: 'x',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
  });
  assert.deepEqual(offRes, { usedAcp: false, confirmedNotSent: true, fallbackReason: 'env_disabled' });

  const childGuardMgr = new CursorCliAcpManager({
    env: { ...env, CURSOR_BRIDGE_CCE_CLI_CHILD: '1' },
    spawn: () => assert.fail('child guard ACP must not spawn'),
  });
  assert.equal(childGuardMgr.statusView().reason, 'child_process_guard');

  const rootA = join(root, 'rA');
  const rootB = join(root, 'rB');
  mkdirSync(rootA);
  mkdirSync(rootB);
  const wsFile = join(root, 'multi.code-workspace');
  writeFileSync(wsFile, JSON.stringify({ folders: [{ path: rootA }, { path: rootB }] }));
  const multiRes = await new CursorCliAcpManager({ env, spawn: () => assert.fail('multi-root must not spawn') }).runOrFallback({
    projectPath: wsFile,
    prompt: 'x',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
  });
  assert.equal(multiRes.fallbackReason, 'multi_root_workspace');

  // Idle timeout recycles process automatically.
  const mockIdle = createFakeAcpSpawn(makeStandardAcpResponder({ initialMode: 'ask' }));
  const idleMgr = new CursorCliAcpManager({
    env,
    spawn: mockIdle.spawn,
    killTree: mockIdle.killTree,
    idleMs: 35,
    inspectIdentity: async () => ({ available: true, key: 'id-idle', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  await idleMgr.prewarm({ projectPath: project, modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli });
  assert.equal(idleMgr.statusView().warmProcesses, 1);
  await until(() => idleMgr.statusView().warmProcesses === 0);
  await idleMgr.shutdown();

  // Capability failure TTL caches per identity and clears when identity changes.
  let probeCalls = 0;
  let idKey = 'bad-cli-v1';
  const badMock = createFakeAcpSpawn((msg, proc) => {
    if (msg.method === 'initialize') {
      probeCalls += 1;
      proc.emitJson({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method acp' } });
    }
  });
  const capMgr = new CursorCliAcpManager({
    env,
    spawn: badMock.spawn,
    killTree: badMock.killTree,
    inspectIdentity: async () => ({ available: true, key: idKey, launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  await capMgr.runOrFallback({ projectPath: project, prompt: 'x', modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli, allowColdStart: true });
  await capMgr.runOrFallback({ projectPath: project, prompt: 'y', modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli, allowColdStart: true });
  assert.equal(probeCalls, 1, 'Capability failure should be cached per identity');
  assert.equal(capMgr.statusView().state, 'unavailable');
  idKey = 'good-cli-v2';
  await capMgr.runOrFallback({ projectPath: project, prompt: 'z', modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli, allowColdStart: true });
  assert.equal(probeCalls, 2, 'New CLI identity must reprobe');
  await capMgr.shutdown();

  // Local provider skips ACP cleanly.
  const localProviderRes = await new CursorCliAcpManager({
    env,
    spawn: () => assert.fail('local provider must not spawn ACP'),
  }).runOrFallback({
    projectPath: project,
    prompt: 'x',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
    cli: { ...cli, provider: { baseUrl: 'https://local.example/v1' } },
  });
  assert.equal(localProviderRes.fallbackReason, 'local_provider');

  // Prompt timeout kills unresponsive tree and proves confirmedTerminal.
  const baseTimeout = makeStandardAcpResponder({ initialMode: 'ask' });
  const mockTimeout = createFakeAcpSpawn((msg, proc) => {
    if (msg.method === 'session/prompt') return;
    return baseTimeout(msg, proc);
  });
  const timeoutMgr = new CursorCliAcpManager({
    env,
    spawn: mockTimeout.spawn,
    killTree: mockTimeout.killTree,
    cancelGraceMs: 25,
    closeTimeoutMs: 25,
    inspectIdentity: async () => ({ available: true, key: 'id-timeout', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  await timeoutMgr.prewarm({ projectPath: project, modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli });
  await assert.rejects(
    timeoutMgr.runOrFallback({
      projectPath: project,
      prompt: 'slow prompt',
      modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
      cli,
      timeoutMs: 30,
    }),
    err => err.code === 'CURSOR_CLI_TIMEOUT' && err.confirmedTerminal === true && err.confirmedNotSent === false,
  );
  assert.equal(mockTimeout.stopped.length, 1);
  await timeoutMgr.shutdown();

  // Full CursorBridge ACP task sets cliTransport='acp' and shutdownCli() closes warm process.
  const mockSuccess = createFakeAcpSpawn(makeStandardAcpResponder({ initialMode: 'ask' }));
  const okMgr = new CursorCliAcpManager({
    env,
    spawn: mockSuccess.spawn,
    killTree: mockSuccess.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-ok-bridge', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  const okBridge = new CursorBridge({
    projectPath: project,
    cceSourceFile,
    runtimeFile: null,
    modelPreferencesFile: null,
    sessionFile: null,
    workspaceFile: join(root, 'workspaces-ok.json'),
    cliInspector: async () => cli,
    cliRunner: async () => assert.fail('warm ACP should handle query without print runner'),
    acpManager: okMgr,
  });
  okBridge.modelPreferences = { version: 1, targets: { cce: { model: 'grok-4.6-fast', effort: 'medium' }, cursor_do: null }, updatedAt: null };
  await okBridge.initializeWorkspace(project);
  await until(() => okMgr.statusView().readySessions === 1);
  const queryOut = await okBridge.contextEngine('find owners', { workspacePath: project });
  assert.equal(queryOut, answer);
  const task = [...okBridge.tasks.values()][0];
  assert.equal(task.cliTransport, 'acp');
  await okBridge.shutdownCli();
  assert.equal(mockSuccess.stopped.length, 1);
});

test('ACP prebuilt session sends session/prompt before replenish and concurrent queries fall back to print with acp_busy', async t => {
  const { root, project, env } = makeTempEnv(t);
  const cceSourceFile = join(root, 'source.json');
  writeCcePreferences(cceSourceFile, { source: 'cli' });

  const cli = { brand: 'Cursor', launcher: { command: process.execPath, args: ['mock-cli.js'] }, models: [{ id: 'grok-4.6-medium-fast', name: 'Grok 4.6 Medium Fast' }] };

  // Part A: prebuilt session sends session/prompt before any replenish session/new.
  const baseA = makeStandardAcpResponder({ initialMode: 'ask' });
  let sessionNewBeforeFirstPrompt = null;
  let promptSeen = false;
  const mockA = createFakeAcpSpawn((msg, proc) => {
    if (msg.method === 'session/prompt' && !promptSeen) {
      promptSeen = true;
      sessionNewBeforeFirstPrompt = proc.sentMessages.filter(item => item.method === 'session/new').length;
    }
    return baseA(msg, proc);
  });
  const mgrA = new CursorCliAcpManager({
    env,
    spawn: mockA.spawn,
    killTree: mockA.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-order', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  t.after(async () => { await mgrA.shutdown(); });

  await mgrA.prewarm({ projectPath: project, modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli });
  await until(() => mgrA.statusView().readySessions === 1);

  const resA = await mgrA.runOrFallback({
    projectPath: project,
    prompt: 'first query',
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
    cli,
  });
  assert.equal(resA.usedAcp, true);
  assert.equal(sessionNewBeforeFirstPrompt, 1, 'Must not queue replenish session/new ahead of session/prompt');

  await until(() => mgrA.statusView().readySessions === 1);
  const sentMethodsA = mockA.processes[0].sentMessages.map(item => item.method);
  const firstPromptIdx = sentMethodsA.indexOf('session/prompt');
  const secondNewIdx = sentMethodsA.indexOf('session/new', sentMethodsA.indexOf('session/new') + 1);
  assert.ok(firstPromptIdx >= 0 && secondNewIdx > firstPromptIdx, 'Replenish session/new runs only after session/prompt finishes');

  // Part B: while ACP has an active prompt, concurrent query falls back immediately with acp_busy to print.
  const baseB = makeStandardAcpResponder({ initialMode: 'ask' });
  let heldPrompt = null;
  const mockB = createFakeAcpSpawn((msg, proc) => {
    if (msg.method === 'session/prompt') {
      heldPrompt = { msg, proc };
      return;
    }
    return baseB(msg, proc);
  });
  const mgrB = new CursorCliAcpManager({
    env,
    spawn: mockB.spawn,
    killTree: mockB.killTree,
    inspectIdentity: async () => ({ available: true, key: 'id-busy', launcher: cli.launcher }),
    enumerateMcpImpl: async () => ({ ids: [], partialErrorCategory: null }),
  });
  let printCalls = 0;
  const bridge = new CursorBridge({
    projectPath: project,
    cceSourceFile,
    runtimeFile: null,
    modelPreferencesFile: null,
    sessionFile: null,
    workspaceFile: join(root, 'workspaces.json'),
    cliInspector: async () => cli,
    cliRunner: async () => {
      printCalls += 1;
      return { result: answer, sessionId: `print-busy-${printCalls}`, modelSelection: { applied: true } };
    },
    acpManager: mgrB,
  });
  bridge.modelPreferences = { version: 1, targets: { cce: { model: 'grok-4.6-fast', effort: 'medium' }, cursor_do: null }, updatedAt: null };
  t.after(async () => { await bridge.shutdownCli(); });

  await mgrB.prewarm({ projectPath: project, modelPreference: { model: 'grok-4.6-fast', effort: 'medium' }, cli });
  await until(() => mgrB.statusView().readySessions === 1);

  const p1 = bridge.contextEngine('active acp query', { workspacePath: project });
  await until(() => heldPrompt !== null);

  const out2 = await bridge.contextEngine('concurrent fallback query', { workspacePath: project });
  assert.equal(out2, answer);
  assert.equal(printCalls, 1);
  assert.equal(mgrB.stats.lastFallbackReason, 'acp_busy');

  heldPrompt.proc.emitJson({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: heldPrompt.msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: answer } } },
  });
  heldPrompt.proc.emitJson({ jsonrpc: '2.0', id: heldPrompt.msg.id, result: { stopReason: 'end_turn' } });
  const out1 = await p1;
  assert.equal(out1, answer);

  const transports = [...bridge.tasks.values()].map(item => item.cliTransport).sort();
  assert.deepEqual(transports, ['acp', 'print']);
});
