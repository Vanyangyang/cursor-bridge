import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { CursorBridge, buildContextEnginePrompt, normalizeRequestContext, buildToolDefinitions, toolErrorResult } from '../server.mjs';
import { writeCcePreferences } from '../cursor-cce-preferences.mjs';

const preference = { model: 'grok-4.7', effort: 'high' };
const answer = 'CCE_SEARCH_RESULT\nintent: 查询\ncoverage: focused | source\nevidence:\n- server.mjs:1 | symbol | evidence | source-read\ngaps: none\nconfidence: high';
const verified = { configured: true, applied: true, requestedModel: 'grok-4.7', requestedEffort: 'high', effectiveModel: 'grok-4.7', effectiveEffort: 'high', verificationSource: 'cursor_cli_init', cliModel: 'grok-4.7-high' };

function harness(t, source = 'cli') {
  const root = mkdtempSync(join(tmpdir(), 'cce-source-routing-'));
  const project = join(root, 'project'); mkdirSync(project);
  const cceSourceFile = join(root, 'source.json'); writeCcePreferences(cceSourceFile, { source });
  const calls = [];
  const bridge = new CursorBridge({ projectPath: project, cceSourceFile, runtimeFile: null, modelPreferencesFile: null, sessionFile: null,
    workspaceFile: join(root, 'workspaces.json'),
    cliInspector: async () => { calls.push('inspect'); return { brand: 'Cursor' }; },
    cliRunner: async options => {
      calls.push(['cli', options]); options.onDispatch(); options.onInit({ sessionId: 'cli-session', modelSelection: verified });
      return { result: answer, sessionId: 'cli-session', modelSelection: verified };
    },
  });
  bridge.modelPreferences = { version: 1, targets: { cce: preference, cursor_do: preference }, updatedAt: null };
  bridge._ensureCursor = async () => { calls.push('ensure-ide'); };
  bridge._run = async (prompt, job) => { calls.push(['ide', { prompt, job }]); return answer; };
  t.after(async () => { await bridge.shutdownCli(); rmSync(root, { recursive: true, force: true }); });
  return { bridge, project, calls, cceSourceFile };
}

async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await setImmediate(); }
  assert.fail('Expected asynchronous task state was not reached');
}

test('CLI and IDE use the identical CCE prompt, admission and normalized result contracts', async t => {
  const context = { sender: 'model', source: 'model' }, query = '查询调用链及证据';
  for (const source of ['cli', 'ide']) {
    const { bridge, project, calls } = harness(t, source);
    const result = await bridge.contextEngine(query, { workspacePath: project, requestContext: context });
    assert.equal(result, answer);
    const dispatch = calls.find(call => Array.isArray(call) && call[0] === source);
    assert.equal(dispatch[1].prompt, buildContextEnginePrompt(query, normalizeRequestContext(context)));
    const job = [...bridge.tasks.values()][0];
    assert.equal(job.cceSource, source);
    assert.equal(job.readOnly, true);
    assert.deepEqual(job.allowedPaths, []);
    assert.deepEqual(job.modelPreference, preference);
    assert.equal(job.resultCollectedAt != null, true);
    assert.equal(calls.includes('ensure-ide'), source === 'ide');
    assert.equal(calls.includes('inspect'), source === 'cli');
    if (source === 'cli') {
      assert.equal(job.agentId, null);
      assert.equal(job.cliSessionId, 'cli-session');
      assert.equal(job.modelSelection.applied, true);
    }
  }
});

test('fresh installs default to CLI without persisting cce-source.json; explicit IDE skips CLI', async t => {
  const { bridge, project, calls, cceSourceFile } = harness(t, 'cli');
  rmSync(cceSourceFile);
  bridge._ensureCursor = async () => assert.fail('Default CLI must not touch Cursor IDE');
  assert.equal(bridge.ccePreferencesView().cceSource, 'cli');
  assert.equal(bridge.ccePreferencesView().cceCliProvider, null);
  assert.equal(bridge.shouldPrewarmIde(), false);
  assert.equal((await bridge.initializeWorkspace(project)).ready, true);
  assert.equal(await bridge.contextEngine('question', { workspacePath: project }), answer);
  assert.equal([...bridge.tasks.values()][0].cceSource, 'cli');
  assert.equal(calls.includes('ensure-ide'), false);
  assert.equal(calls.includes('inspect'), true);
  assert.deepEqual(calls.filter(call => Array.isArray(call)).map(call => call[0]), ['cli']);
  assert.equal(existsSync(cceSourceFile), false, 'Default CLI must not write cce-source.json');

  const ideHarness = harness(t, 'ide');
  ideHarness.bridge.cliInspector = async () => assert.fail('Explicit IDE must not inspect CLI');
  ideHarness.bridge.cliRunner = async () => assert.fail('Explicit IDE must not execute CLI');
  assert.equal(ideHarness.bridge.ccePreferencesView().cceSource, 'ide');
  assert.equal(ideHarness.bridge.shouldPrewarmIde(), true);
  assert.equal((await ideHarness.bridge.initializeWorkspace(ideHarness.project)).ready, true);
  assert.equal(await ideHarness.bridge.contextEngine('question', { workspacePath: ideHarness.project }), answer);
  assert.deepEqual(ideHarness.calls.map(call => Array.isArray(call) ? call[0] : call), ['ensure-ide', 'ensure-ide', 'ide']);
});

test('IDE remains usable when a saved optional CLI runtime and credential file are absent', async t => {
  const { bridge, project, calls, cceSourceFile } = harness(t, 'ide');
  const provider = { kind: 'openai-responses', nodePath: join(project, 'missing-cli', 'node.exe'),
    entrypoint: join(project, 'missing-cli', 'index.js'), baseUrl: 'https://provider.example/v1',
    apiKeyFile: join(project, 'missing-key.txt') };
  writeCcePreferences(cceSourceFile, { source: 'ide', cliProvider: provider });
  for (const path of [provider.nodePath, provider.entrypoint, provider.apiKeyFile]) assert.equal(existsSync(path), false);
  bridge.cliInspector = async () => assert.fail('IDE must not inspect an optional CLI provider');
  bridge.cliRunner = async () => assert.fail('IDE must not run an optional CLI provider');
  assert.equal((await bridge.initializeWorkspace(project)).ready, true);
  assert.equal(await bridge.contextEngine('question', { workspacePath: project }), answer);
  assert.deepEqual(calls.map(call => Array.isArray(call) ? call[0] : call), ['ensure-ide', 'ensure-ide', 'ide']);
});

test('an explicitly selected missing CLI reports its cause and permits an explicit return to IDE', async t => {
  const { bridge, project, calls } = harness(t);
  const unavailable = Object.assign(new Error('CLI is not installed'), { code: 'CURSOR_CLI_UNAVAILABLE', confirmedNotSent: true });
  bridge.cliInspector = async () => { throw unavailable; };
  await assert.rejects(bridge.contextEngine('question', { workspacePath: project }), error => error === unavailable);
  assert.equal(bridge.ccePreferencesView().cceSource, 'cli');
  assert.equal(bridge.tasks.size, 0);
  assert.deepEqual(calls, []);
  bridge.configureCcePreferences({ action: 'set', source: 'ide' });
  assert.equal(await bridge.contextEngine('question', { workspacePath: project }), answer);
  assert.equal([...bridge.tasks.values()][0].cceSource, 'ide');
});

test('CLI initializes a bound workspace without launching or registering an IDE', async t => {
  const { bridge, project, calls } = harness(t);
  bridge._ensureCursor = async () => assert.fail('CLI initialization must not launch Cursor IDE');
  const ready = await bridge.initializeWorkspace(project);
  assert.equal(ready.ready, true);
  assert.equal(ready.cceSource, 'cli');
  assert.equal(ready.workspaceBinding.ok, true);
  assert.equal(ready.workspaceBinding.identitySource, 'cursor_cli_workspace');
  assert.deepEqual(calls, ['inspect']);
  assert.equal(bridge.shouldPrewarmIde(), false);
});

test('source and model snapshots survive a source switch while a request is queued', async t => {
  const { bridge, project, calls } = harness(t);
  bridge.busy = true;
  const pending = bridge.contextEngine('queued question', { workspacePath: project });
  await until(() => bridge.queue.length === 1);
  bridge.configureCcePreferences({ action: 'set', source: 'ide' });
  bridge.modelPreferences.targets.cce = { model: 'another-fixture', effort: 'low' };
  bridge.busy = false; void bridge._drain();
  assert.equal(await pending, answer);
  const cli = calls.find(call => Array.isArray(call) && call[0] === 'cli')[1];
  assert.deepEqual(cli.modelPreference, preference);
  await bridge.contextEngine('later question', { workspacePath: project });
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'ide'));
});

test('workspace mismatch and cancelled inspection cannot dispatch a CLI query', async t => {
  const { bridge, project, calls } = harness(t);
  await assert.rejects(bridge.contextEngine('question', { workspacePath: join(project, 'wrong') }), error => error.code === 'WORKSPACE_MISMATCH');
  assert.deepEqual(calls, []);
  const controller = new AbortController();
  bridge.cliInspector = async () => { controller.abort(); return { brand: 'Cursor' }; };
  await assert.rejects(bridge.contextEngine('question', { workspacePath: project, signal: controller.signal }), error => error.code === 'CURSOR_CLI_CANCELLED' && error.confirmedNotSent);
  assert.equal(bridge.tasks.size, 0);
});

test('CLI failures retain their task identity without an IDE fallback or resubmission', async t => {
  const { bridge, project, calls } = harness(t);
  const failure = Object.assign(new Error('CLI unavailable fixture'), { code: 'CURSOR_CLI_PROTOCOL_ERROR', confirmedTerminal: true });
  bridge.cliRunner = async () => { throw failure; };
  await assert.rejects(bridge.contextEngine('question', { workspacePath: project }), error => error === failure);
  assert.equal(bridge.tasks.get(failure.taskId).status, 'failed');
  assert.equal(calls.includes('ensure-ide'), false);
  const payload = toolErrorResult(failure).structuredContent;
  assert.equal(payload.error.code, failure.code);
  assert.equal(payload.taskId, failure.taskId);
});

test('CLI cancellation and host disconnect stop the owned execution without a UI Stop', async t => {
  for (const action of ['cancel', 'disconnect']) {
    const { bridge, project } = harness(t);
    bridge.cliRunner = options => new Promise((resolve, reject) => {
      options.onDispatch(); options.onInit({ sessionId: 'owned-cli-session', modelSelection: verified });
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled fixture'), { cancelled: true, stopConfirmed: true, confirmedTerminal: true })), { once: true });
    });
    bridge._stopParallelAgent = async () => assert.fail('A CLI session must never use Agent History Stop');
    const pending = bridge.contextEngine('question', { workspacePath: project });
    const rejected = assert.rejects(pending, error => error.cancelled);
    await until(() => bridge.currentJob?.cliAbortController);
    const job = bridge.currentJob;
    if (action === 'cancel') await bridge.taskControl(job.id, { action: 'cancel', confirm: true });
    else await bridge.shutdownCli();
    await rejected;
    assert.equal(job.status, 'cancelled');
    assert.equal(job.underlyingStopConfirmed, true);
  }
});

test('the source tool is explicit and invalid source input cannot change preferences', t => {
  const { bridge } = harness(t);
  const tool = buildToolDefinitions(bridge).find(tool => tool.name === 'cursor_cce');
  assert.deepEqual(tool.inputSchema.properties.source.enum, ['ide', 'cli']);
  assert.ok(tool.inputSchema.properties.cli_provider);
  assert.throws(() => bridge.configureCcePreferences({ action: 'set', source: 'auto' }));
  assert.equal(bridge.ccePreferencesView().cceSource, 'cli');
});

test('initialization and queued retrieval freeze the explicit provider instead of consulting account CLI', async t => {
  const { bridge, project, cceSourceFile } = harness(t);
  const provider = { kind: 'openai-responses', nodePath: process.execPath, entrypoint: resolve('local-cli.js'), baseUrl: 'https://provider.example/v1', apiKeyFile: resolve('local-key.txt') };
  writeCcePreferences(cceSourceFile, { source: 'cli', cliProvider: provider });
  const inspections = [];
  bridge.cliInspector = async options => { inspections.push(options); return { brand: 'Cursor', provider: structuredClone(options.provider) }; };
  await bridge.initializeWorkspace(project);
  assert.deepEqual(inspections[0].provider, provider);
  assert.deepEqual(inspections[0].modelPreference, preference);
  bridge.busy = true;
  let owned;
  bridge.cliRunner = async options => { owned = options.cli.provider; return { result: answer, sessionId: 'provider-session', modelSelection: verified }; };
  const pending = bridge.contextEngine('question', { workspacePath: project });
  await until(() => bridge.queue.length === 1);
  writeCcePreferences(cceSourceFile, { source: 'cli', cliProvider: { ...provider, baseUrl: 'https://changed.example/v1' } });
  bridge.busy = false; void bridge._drain();
  assert.equal(await pending, answer);
  assert.deepEqual(owned, provider);
  assert.equal(bridge.ccePreferencesView().cceCliProvider.baseUrl, 'https://changed.example/v1');
});

test('a cancelled queued CLI request settles even when the preceding queue cannot advance', async t => {
  const { bridge, project } = harness(t);
  bridge.busy = true;
  const controller = new AbortController();
  const pending = bridge.contextEngine('queued question', { workspacePath: project, signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.code === 'CURSOR_CLI_CANCELLED' && error.confirmedNotSent);
  await until(() => bridge.queue.length === 1);
  const job = bridge.queue[0]; controller.abort();
  await rejected;
  assert.equal(job.status, 'cancelled'); assert.equal(bridge.queue.length, 0);
});

test('unconfirmed CLI cancellation keeps the task identity and global reservation in its error', async t => {
  const { bridge, project } = harness(t);
  const failure = Object.assign(new Error('CLI stop unconfirmed fixture'), {
    code: 'CURSOR_CLI_CANCELLED', cancelled: true, stopConfirmed: false,
    confirmedTerminal: false, sent: true, cliProcessId: 12345,
  });
  bridge.cliRunner = options => new Promise((resolve, reject) => {
    options.onDispatch(); options.onInit({ sessionId: 'owned-cli-session', modelSelection: verified });
    options.signal.addEventListener('abort', () => reject(failure), { once: true });
  });
  const pending = bridge.contextEngine('question', { workspacePath: project });
  const rejected = assert.rejects(pending, error => error === failure);
  await until(() => bridge.currentJob?.cliAbortController);
  const job = bridge.currentJob;
  await bridge.taskControl(job.id, { action: 'cancel', confirm: true }); await rejected;
  const payload = toolErrorResult(failure).structuredContent;
  assert.equal(payload.taskId, job.id); assert.equal(payload.cliProcessId, 12345);
  assert.equal(payload.confirmedTerminal, false); assert.equal(payload.error.code, 'CURSOR_CLI_CANCELLED');
  assert.equal(bridge.activeParallel.has(job.id), true);
  assert.equal(job.reservationScope, 'global');
});

test('shutdown aborts and waits for CLI inspections before either initialization or query enqueue', async t => {
  for (const operation of ['query', 'initialize']) {
    const { bridge, project } = harness(t);
    let signal, finish;
    bridge.cliInspector = options => {
      signal = options.signal;
      return new Promise((resolve, reject) => { finish = () => reject(Object.assign(new Error('inspection cancelled fixture'), { code: 'CURSOR_CLI_CANCELLED', confirmedNotSent: true })); });
    };
    const pending = operation === 'query' ? bridge.contextEngine('question', { workspacePath: project }) : bridge.initializeWorkspace(project);
    const rejected = assert.rejects(pending, error => error.code === 'CURSOR_CLI_CANCELLED');
    await until(() => !!signal);
    let settled = false;
    const shutdown = bridge.shutdownCli().then(() => { settled = true; });
    await setImmediate(); assert.equal(signal.aborted, true); assert.equal(settled, false);
    finish(); await shutdown; await rejected;
    assert.equal(bridge.cliInspections.size, 0); assert.equal(bridge.tasks.size, 0);
  }
});

test('an inspection resolving after shutdown cannot enqueue or dispatch a CLI query', async t => {
  const { bridge, project, calls } = harness(t);
  let shutdown;
  bridge.cliInspector = async () => { shutdown = bridge.shutdownCli(); return { brand: 'Cursor' }; };
  await assert.rejects(bridge.contextEngine('question', { workspacePath: project }), error => error.code === 'CURSOR_CLI_CANCELLED' && error.confirmedNotSent);
  await shutdown;
  assert.equal(bridge.tasks.size, 0);
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'cli'), false);
});

test('CLI status uses cached metadata without depending on a live IDE connection', async t => {
  const { bridge, project } = harness(t);
  let finish;
  bridge.cliRunner = options => new Promise(resolve => {
    options.onDispatch(); options.onInit({ sessionId: 'status-cli-session', modelSelection: verified });
    finish = () => resolve({ result: answer, sessionId: 'status-cli-session', modelSelection: verified });
  });
  const pending = bridge.contextEngine('question', { workspacePath: project });
  await until(() => !!finish);
  const status = await bridge.status();
  assert.equal(status.statusPath, 'cli-metadata'); assert.equal(status.connected, true);
  assert.equal(status.cli.available, true); assert.ok(status.cli.checkedAt);
  assert.equal(status.busy, true); assert.equal(status.uiBusy, false); assert.equal(status.idle, false);
  finish(); await pending;
});

test('official CLI preflight cache reuses metadata within TTL, dedups concurrent inspections, and invalidates cleanly', async t => {
  const { bridge, project, calls } = harness(t);
  let identityKey = 'v1';
  bridge.cliIdentityReader = async () => ({ available: true, key: identityKey });

  await bridge.contextEngine('q1', { workspacePath: project });
  await bridge.contextEngine('q2', { workspacePath: project });
  assert.equal(calls.filter(c => c === 'inspect').length, 1);
  assert.equal((await bridge.status()).cli.inspectCache.hits, 1);
  assert.equal((await bridge.status()).cli.inspectCache.misses, 1);

  identityKey = 'v2';
  await bridge.contextEngine('q3', { workspacePath: project });
  assert.equal(calls.filter(c => c === 'inspect').length, 2);

  await bridge.initializeWorkspace(project);
  assert.equal(calls.filter(c => c === 'inspect').length, 3);

  bridge.cliRunner = async () => {
    throw Object.assign(new Error('model gone'), { code: 'CURSOR_CLI_MODEL_UNAVAILABLE', confirmedTerminal: true });
  };
  await assert.rejects(bridge.contextEngine('q4', { workspacePath: project }), { code: 'CURSOR_CLI_MODEL_UNAVAILABLE' });
  bridge.cliRunner = async options => {
    calls.push(['cli', options]); options.onDispatch(); options.onInit({ sessionId: 'cli-s2', modelSelection: verified });
    return { result: answer, sessionId: 'cli-s2', modelSelection: verified };
  };
  await bridge.contextEngine('q5', { workspacePath: project });
  assert.equal(calls.filter(c => c === 'inspect').length, 4);

  const prevTtl = process.env.CURSOR_BRIDGE_CLI_INSPECT_TTL_MS;
  process.env.CURSOR_BRIDGE_CLI_INSPECT_TTL_MS = '0';
  try {
    await bridge.contextEngine('q6', { workspacePath: project });
    await bridge.contextEngine('q7', { workspacePath: project });
    assert.equal(calls.filter(c => c === 'inspect').length, 6);
  } finally {
    if (prevTtl === undefined) delete process.env.CURSOR_BRIDGE_CLI_INSPECT_TTL_MS;
    else process.env.CURSOR_BRIDGE_CLI_INSPECT_TTL_MS = prevTtl;
  }
});

test('concurrent _inspectCli dedups inspection and isolates per-caller aborts until last caller cancels', async t => {
  const { bridge } = harness(t);
  let inspectCount = 0;
  let resolveInspect;
  let seenSignal;
  bridge.cliIdentityReader = async () => ({ available: true, key: 'v-dedup' });
  bridge.cliInspector = opts => {
    inspectCount++;
    seenSignal = opts.signal;
    return new Promise((res, rej) => {
      resolveInspect = () => res({ brand: 'Cursor' });
      opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { code: 'CURSOR_CLI_CANCELLED' })), { once: true });
    });
  };

  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const p1 = bridge._inspectCli(ac1.signal, {});
  const p2 = bridge._inspectCli(ac2.signal, {});
  await until(() => inspectCount === 1);
  ac1.abort();
  await assert.rejects(p1, { code: 'CURSOR_CLI_CANCELLED' });
  assert.equal(seenSignal.aborted, false);
  resolveInspect();
  const meta = await p2;
  assert.equal(meta.brand, 'Cursor');
  assert.equal(inspectCount, 1);

  bridge.cliInspectCache = null;
  let inspectCount2 = 0;
  let seenSignal2;
  bridge.cliInspector = opts => {
    inspectCount2++;
    seenSignal2 = opts.signal;
    return new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { code: 'CURSOR_CLI_CANCELLED' })), { once: true });
    });
  };
  const ac3 = new AbortController();
  const p3 = bridge._inspectCli(ac3.signal, {});
  await until(() => inspectCount2 === 1);
  ac3.abort();
  await assert.rejects(p3, { code: 'CURSOR_CLI_CANCELLED' });
  assert.equal(seenSignal2.aborted, true);
});

test('local cliProvider always bypasses official CLI preflight cache', async t => {
  const { bridge, project, cceSourceFile } = harness(t);
  const provider = { kind: 'openai-responses', nodePath: process.execPath, entrypoint: resolve('local-cli.js'), baseUrl: 'https://provider.example/v1', apiKeyFile: resolve('local-key.txt') };
  writeCcePreferences(cceSourceFile, { source: 'cli', cliProvider: provider });
  let inspectCount = 0;
  bridge.cliInspector = async options => { inspectCount++; return { brand: 'Cursor', provider: structuredClone(options.provider) }; };
  await bridge.contextEngine('p1', { workspacePath: project });
  await bridge.contextEngine('p2', { workspacePath: project });
  assert.equal(inspectCount, 2);
});

test('CLI CCE defaults to 3 concurrent slots, leaves IDE UI free, and respects CURSOR_BRIDGE_CCE_CLI_CONCURRENCY=1', async t => {
  const prevConcurrency = process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY;
  delete process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY;
  t.after(() => {
    if (prevConcurrency === undefined) delete process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY;
    else process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY = prevConcurrency;
  });

  // 1. Default concurrency = 3 with 5 simultaneous queries (3 running + 2 queued)
  const { bridge, project } = harness(t);
  let inFlight = 0;
  let maxInFlight = 0;
  const releasers = [];
  bridge.cliRunner = options => new Promise((resolveRun, rejectRun) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    options.onDispatch();
    options.onInit({ sessionId: `cli-s-${inFlight}`, modelSelection: verified });
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      inFlight -= 1;
      rejectRun(Object.assign(new Error('test aborted'), {
        code: 'CURSOR_CLI_CANCELLED',
        cancelled: true,
        stopConfirmed: true,
        confirmedTerminal: true,
      }));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    releasers.push(() => {
      if (done) return;
      done = true;
      inFlight -= 1;
      options.signal.removeEventListener('abort', onAbort);
      resolveRun({ result: answer, sessionId: `cli-s-${maxInFlight}`, modelSelection: verified });
    });
  });

  const batch = [1, 2, 3, 4, 5].map(i => bridge.contextEngine(`q-${i}`, { workspacePath: project }));
  await until(() => releasers.length === 3);
  assert.equal(maxInFlight, 3);
  assert.equal(bridge.queue.length, 2);
  assert.equal(bridge.busy, false);

  const midStatus = await bridge.status();
  assert.equal(midStatus.cliRunning, 3);
  assert.equal(midStatus.cliConcurrency, 3);
  assert.equal(midStatus.activeCli.length, 3);
  assert.equal(midStatus.queued, 2);
  assert.equal(midStatus.busy, true);
  assert.equal(midStatus.idle, false);
  assert.equal(midStatus.uiBusy, false);
  assert.equal(midStatus.cli.running, 3);
  assert.equal(midStatus.cli.concurrency, 3);

  // Active CLI work must still block cursor_init workspace mutation.
  await assert.rejects(
    bridge.initializeWorkspace(project),
    /queued or running/,
  );

  const firstWave = releasers.splice(0, 3);
  for (const release of firstWave) release();
  await until(() => releasers.length === 2);
  for (const release of releasers.splice(0)) release();
  const results = await Promise.all(batch);
  assert.equal(results.length, 5);
  assert.equal(maxInFlight, 3);
  const endStatus = await bridge.status();
  assert.equal(endStatus.cliRunning, 0);
  assert.equal(endStatus.busy, false);
  assert.equal(endStatus.idle, true);

  // 2. CLI CCE dispatches even while an IDE job holds the FIFO busy lock (currentJob !== null).
  const { bridge: bridge2, project: project2 } = harness(t);
  bridge2.busy = true;
  bridge2.currentJob = { id: 'ide-active-1', kind: 'execute', cceSource: null };
  const cliWhileIdeBusy = await bridge2.contextEngine('concurrent with ide', { workspacePath: project2 });
  assert.equal(cliWhileIdeBusy, answer);
  bridge2.busy = false;
  bridge2.currentJob = null;

  // 3. CURSOR_BRIDGE_CCE_CLI_CONCURRENCY=1 restores strictly serial CLI execution.
  process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY = '1';
  const { bridge: serialBridge, project: serialProject } = harness(t);
  let serialInFlight = 0;
  let serialMax = 0;
  const serialReleasers = [];
  serialBridge.cliRunner = options => new Promise((resolveRun, rejectRun) => {
    serialInFlight += 1;
    serialMax = Math.max(serialMax, serialInFlight);
    options.onDispatch();
    options.onInit({ sessionId: 'serial-s', modelSelection: verified });
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      serialInFlight -= 1;
      rejectRun(Object.assign(new Error('serial aborted'), {
        code: 'CURSOR_CLI_CANCELLED',
        cancelled: true,
        stopConfirmed: true,
        confirmedTerminal: true,
      }));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    serialReleasers.push(() => {
      if (done) return;
      done = true;
      serialInFlight -= 1;
      options.signal.removeEventListener('abort', onAbort);
      resolveRun({ result: answer, sessionId: 'serial-s', modelSelection: verified });
    });
  });
  const s1 = serialBridge.contextEngine('s1', { workspacePath: serialProject });
  const s2 = serialBridge.contextEngine('s2', { workspacePath: serialProject });
  await until(() => serialReleasers.length === 1);
  assert.equal(serialBridge.queue.length, 1);
  assert.equal((await serialBridge.status()).cliConcurrency, 1);
  serialReleasers.shift()();
  await until(() => serialReleasers.length === 1);
  serialReleasers.shift()();
  await Promise.all([s1, s2]);
  assert.equal(serialMax, 1);
});

test('uncertain CLI termination globally blocks queued tasks until abandon, and shutdownCli aborts running+queued CLI tasks', async t => {
  const prevConcurrency = process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY;
  t.after(() => {
    if (prevConcurrency === undefined) delete process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY;
    else process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY = prevConcurrency;
  });

  // 1. Uncertain post-send termination blocks queued tasks via global reservation until abandon.
  process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY = '1';
  const { bridge, project } = harness(t);
  let failFirst;
  let releaseSecond;
  let runCount = 0;
  bridge.cliRunner = options => {
    runCount += 1;
    if (runCount === 1) {
      return new Promise((_resolveRun, rejectRun) => {
        options.onDispatch();
        options.onInit({ sessionId: 'cli-uncertain-1', modelSelection: verified });
        let done = false;
        const onAbort = () => {
          if (done) return;
          done = true;
          rejectRun(Object.assign(new Error('aborted first'), {
            code: 'CURSOR_CLI_CANCELLED',
            cancelled: true,
            stopConfirmed: true,
            confirmedTerminal: true,
          }));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        failFirst = () => {
          if (done) return;
          done = true;
          options.signal.removeEventListener('abort', onAbort);
          rejectRun(Object.assign(new Error('uncertain CLI exit'), {
            code: 'CURSOR_CLI_EXIT_ERROR',
            sent: true,
            confirmedNotSent: false,
            confirmedTerminal: false,
            cliProcessId: 9901,
          }));
        };
      });
    }
    return new Promise((resolveRun, rejectRun) => {
      options.onDispatch();
      options.onInit({ sessionId: 'cli-after-abandon', modelSelection: verified });
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        rejectRun(Object.assign(new Error('aborted after abandon'), {
          code: 'CURSOR_CLI_CANCELLED',
          cancelled: true,
          stopConfirmed: true,
          confirmedTerminal: true,
        }));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      releaseSecond = () => {
        if (done) return;
        done = true;
        options.signal.removeEventListener('abort', onAbort);
        resolveRun({ result: answer, sessionId: 'cli-after-abandon', modelSelection: verified });
      };
    });
  };

  const p1 = bridge.contextEngine('q-uncertain', { workspacePath: project });
  const p2 = bridge.contextEngine('q-blocked-queued', { workspacePath: project });
  await until(() => typeof failFirst === 'function' && bridge.queue.length === 1);
  failFirst();
  await assert.rejects(p1, { code: 'CURSOR_CLI_EXIT_ERROR' });

  const blockedStatus = await bridge.status();
  assert.equal(blockedStatus.globallyBlocked, true);
  assert.equal(blockedStatus.blockedQueuedCount, 1);
  assert.equal(blockedStatus.queued, 1);
  assert.equal(runCount, 1);
  await assert.rejects(
    bridge.contextEngine('q-rejected-while-blocked', { workspacePath: project }),
    /global Cursor reservation/,
  );
  const orphanId = blockedStatus.blockingTaskIds[0];

  await bridge.taskControl(orphanId, {
    action: 'abandon',
    confirm: true,
    acknowledgeMayStillWrite: true,
    reason: 'confirmed stopped manually',
  });
  await until(() => typeof releaseSecond === 'function');
  releaseSecond();
  assert.equal(await p2, answer);

  // 2. shutdownCli() aborts both running and queued CLI tasks (default concurrency=3) and clears activeCli/queue.
  if (prevConcurrency === undefined) delete process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY;
  else process.env.CURSOR_BRIDGE_CCE_CLI_CONCURRENCY = prevConcurrency;
  const { bridge: shutBridge, project: shutProject } = harness(t);
  let abortedRunning = 0;
  shutBridge.cliRunner = options => new Promise((_resolveRun, rejectRun) => {
    options.onDispatch();
    options.onInit({ sessionId: 'cli-shut', modelSelection: verified });
    options.signal.addEventListener('abort', () => {
      abortedRunning += 1;
      rejectRun(Object.assign(new Error('shutdown abort'), {
        code: 'CURSOR_CLI_CANCELLED',
        cancelled: true,
        stopConfirmed: true,
        confirmedTerminal: true,
      }));
    }, { once: true });
  });
  const jobs = [1, 2, 3, 4].map(i => assert.rejects(
    shutBridge.contextEngine(`shut-${i}`, { workspacePath: shutProject }),
    err => err.code === 'CURSOR_CLI_CANCELLED',
  ));
  await until(() => shutBridge.activeCli.size === 3 && shutBridge.queue.length === 1);
  await shutBridge.shutdownCli();
  await Promise.all(jobs);
  assert.equal(abortedRunning, 3);
  assert.equal(shutBridge.activeCli.size, 0);
  assert.equal(shutBridge.queue.length, 0);
});

test('initializeWorkspace maps recoverable CLI failures and rethrows cancellations', async t => {
  const unavailable = Object.assign(new Error('missing cursor-agent'), { code: 'CURSOR_CLI_UNAVAILABLE' });
  const auth = Object.assign(new Error('not logged in'), { code: 'CURSOR_CLI_EXIT_ERROR', diagnosticCategory: 'auth' });
  const cancelled = Object.assign(new Error('aborted'), { code: 'CURSOR_CLI_CANCELLED' });

  for (const [err, expectedStatus] of [[unavailable, 'cli-unavailable'], [auth, 'cli-auth-required']]) {
    const { bridge, project } = harness(t, 'cli');
    bridge.cliInspector = async () => { throw err; };
    const init = await bridge.initializeWorkspace(project);
    assert.equal(init.ready, false);
    assert.equal(init.bindingPersisted, true);
    assert.equal(init.status, expectedStatus);
    assert.equal(init.errorCode, err.code);
    assert.ok(typeof init.nextStep === 'string' && init.nextStep.length > 0);
  }

  const modelRequired = harness(t, 'cli');
  modelRequired.bridge.modelPreferences = { version: 1, targets: { cce: { model: 'auto', effort: null }, cursor_do: preference }, updatedAt: null };
  modelRequired.bridge.cliInspector = async () => ({
    brand: 'Cursor',
    models: [{ id: 'grok-4.6-medium-fast', name: 'Grok 4.6 Medium Fast' }, { id: 'other-5-low', name: 'Other 5 Low' }],
  });
  const missingModelInit = await modelRequired.bridge.initializeWorkspace(modelRequired.project);
  assert.equal(missingModelInit.ready, false);
  assert.equal(missingModelInit.status, 'cli-model-required');
  assert.equal(missingModelInit.errorCode, 'CURSOR_CLI_MODEL_REQUIRED');
  assert.equal(missingModelInit.availableModelsSample.length, 2);

  const modelUnavailable = harness(t, 'cli');
  modelUnavailable.bridge.cliInspector = async () => ({
    brand: 'Cursor',
    models: [{ id: 'other-5-low', name: 'Other 5 Low' }],
  });
  const badModelInit = await modelUnavailable.bridge.initializeWorkspace(modelUnavailable.project);
  assert.equal(badModelInit.ready, false);
  assert.equal(badModelInit.status, 'cli-model-unavailable');
  assert.equal(badModelInit.errorCode, 'CURSOR_CLI_MODEL_UNAVAILABLE');
  assert.deepEqual(badModelInit.availableModelsSample, [{ id: 'other-5-low', name: 'Other 5 Low' }]);

  const abortCase = harness(t, 'cli');
  abortCase.bridge.cliInspector = async () => { throw cancelled; };
  await assert.rejects(abortCase.bridge.initializeWorkspace(abortCase.project), { code: 'CURSOR_CLI_CANCELLED' });
});

test('diagnoseCce reports unconfigured, ready, error, and ide states without mutating files', async t => {
  const unconfiguredDir = mkdtempSync(join(tmpdir(), 'cce-doctor-unconfigured-'));
  const unconfiguredCceSourceFile = join(unconfiguredDir, 'source.json');
  const unconfigured = new CursorBridge({
    cceSourceFile: unconfiguredCceSourceFile,
    runtimeFile: null,
    modelPreferencesFile: null,
    sessionFile: null,
    workspaceFile: join(unconfiguredDir, 'workspaces.json'),
    cliIdentityReader: async () => ({ available: true, key: 'id-1', launcher: { command: 'cursor-agent.exe', wrapper: null } }),
    cliInspector: async () => ({
      brand: 'Cursor',
      launcher: { command: 'cursor-agent.exe', wrapper: null },
      models: [{ id: 'grok-4.7-high', name: 'Grok 4.7 High' }],
    }),
  });
  unconfigured.modelPreferences = { version: 1, targets: { cce: preference, cursor_do: preference }, updatedAt: null };

  const ideUnconfiguredCceSource = join(unconfiguredDir, 'ide-source.json');
  writeCcePreferences(ideUnconfiguredCceSource, { source: 'ide' });
  const ideUnconfigured = new CursorBridge({
    cceSourceFile: ideUnconfiguredCceSource,
    runtimeFile: null,
    modelPreferencesFile: null,
    sessionFile: null,
    workspaceFile: join(unconfiguredDir, 'ide-workspaces.json'),
  });
  t.after(async () => {
    await unconfigured.shutdownCli();
    await ideUnconfigured.shutdownCli();
    rmSync(unconfiguredDir, { recursive: true, force: true });
  });

  const beforeInit = await unconfigured.diagnoseCce();
  assert.equal(beforeInit.action, 'doctor');
  assert.equal(beforeInit.ok, true);
  assert.equal(beforeInit.ready, false);
  assert.equal(beforeInit.status, 'workspace-initialization-required');
  assert.equal(beforeInit.cceSource, 'cli');
  assert.equal(beforeInit.modelSelection.cliModel, 'grok-4.7-high');
  assert.equal(beforeInit.providerPreloadPresent, true);
  assert.equal(existsSync(unconfiguredCceSourceFile), false);

  const { bridge, project } = harness(t, 'cli');
  bridge.cliIdentityReader = async () => ({ available: true, key: 'id-1', launcher: { command: 'cursor-agent.exe', wrapper: null } });
  bridge.cliInspector = async () => ({
    brand: 'Cursor',
    launcher: { command: 'cursor-agent.exe', wrapper: null },
    models: [{ id: 'grok-4.7-high', name: 'Grok 4.7 High' }],
  });

  const init = await bridge.initializeWorkspace(project);
  assert.equal(init.ready, true);
  const whenReady = await bridge.diagnoseCce();
  assert.equal(whenReady.ok, true);
  assert.equal(whenReady.ready, true);
  assert.equal(whenReady.status, 'ready');
  assert.equal(whenReady.workspace.valid, true);
  assert.equal(whenReady.workspace.projectPath, resolve(project));

  bridge.cliInspector = async () => { throw Object.assign(new Error('not signed in'), { code: 'CURSOR_CLI_EXIT_ERROR', diagnosticCategory: 'auth' }); };
  const onError = await bridge.diagnoseCce({ forceRefresh: true });
  assert.equal(onError.ok, false);
  assert.equal(onError.ready, false);
  assert.equal(onError.status, 'cli-auth-required');
  assert.equal(onError.errorCode, 'CURSOR_CLI_EXIT_ERROR');
  assert.equal(onError.diagnosticCategory, 'auth');

  const ideBefore = await ideUnconfigured.diagnoseCce();
  assert.equal(ideBefore.ok, true);
  assert.equal(ideBefore.cceSource, 'ide');
  assert.equal(ideBefore.cli, null);
  assert.equal(ideBefore.status, 'workspace-initialization-required');
});
