import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// This lets the same behavioral suite prove the old cached implementation is
// red without overwriting it.  Normal repository runs use the local server.
const serverUrl = process.env.CURSOR_BRIDGE_TEST_SERVER
  ? new URL(process.env.CURSOR_BRIDGE_TEST_SERVER).href
  : new URL('../server.mjs', import.meta.url).href;
const { CursorBridge, toolErrorResult } = await import(serverUrl);
const { readWorkspaceBinding, writeWorkspaceBinding } = await import(
  new URL('../workspace-binding.mjs', import.meta.url).href,
);

class AdmissionBridge extends CursorBridge {
  constructor(fixture, options = {}) {
    super({
      runtimeFile: join(fixture.state, 'runtime.json'),
      workspaceFile: fixture.workspaceFile,
      modelPreferencesFile: join(fixture.state, 'model-preferences.json'),
      sessionFile: join(fixture.state, 'sessions.json'),
      runtimeMode: 'normal',
      workspaceKey: 'default',
      delegationMode: 'on',
      ...options,
    });
    this.ensureCalls = [];
    this.enqueueCalls = [];
    this.ensureHook = async () => {};
    this.deferContextEngineResult = false;
  }

  async _ensureCursor(options = {}) {
    const call = { options: { ...options }, projectPath: this.projectPath };
    this.ensureCalls.push(call);
    return this.ensureHook(call);
  }

  _enqueue(kind, prompt, options) {
    this.enqueueCalls.push({ kind, prompt, options: { ...options } });
    if (kind === 'context_engine' && !this.deferContextEngineResult) {
      return {
        status: 'completed',
        result: 'CCE_SEARCH_RESULT intent: admission test\nevidence:\n- server.mjs:1-1 | test | source-read\ngaps: none\nconfidence: high',
        promise: Promise.resolve('CCE_SEARCH_RESULT intent: admission test\nevidence:\n- server.mjs:1-1 | test | source-read\ngaps: none\nconfidence: high'),
      };
    }
    return super._enqueue(kind, prompt, options);
  }

  _drain() {}
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-workspace-admission-'));
  const state = join(root, 'state');
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  const projectC = join(root, 'project-c');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  mkdirSync(projectC, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    state,
    projectA,
    projectB,
    projectC,
    workspaceFile: join(state, 'workspaces.json'),
  };
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function rejectionOf(promise) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected the operation to reject');
  return caught;
}

async function flushMicrotasks(turns = 12) {
  for (let index = 0; index < turns; index++) await Promise.resolve();
}

function assertRecovery(error, code, expectedProjectPath, currentProjectPath) {
  assert.equal(error.code, code, error.message);
  assert.ok(error.workspaceRecovery, `${code} must carry workspaceRecovery`);
  assert.equal(error.workspaceRecovery.expectedProjectPath, expectedProjectPath);
  assert.equal(error.workspaceRecovery.currentProjectPath, currentProjectPath);
  assert.equal(error.workspaceRecovery.requiresIdle, true);
  assert.equal(error.workspaceRecovery.retrySafe, true);
  assert.equal(error.workspaceRecovery.submissionStarted, false);
  assert.equal(error.workspaceRecovery.tool, 'cursor_init');

  const toolError = toolErrorResult(error);
  assert.equal(toolError.isError, true);
  assert.equal(toolError.structuredContent.error.code, code);
  assert.deepEqual(toolError.structuredContent.workspaceRecovery, error.workspaceRecovery);
}

function assertNoSend(bridge) {
  assert.equal(bridge.ensureCalls.length, 0, 'must not initialize Cursor');
  assert.equal(bridge.enqueueCalls.length, 0, 'must not enqueue a Cursor task');
}

test('unbound, invalid, and mismatched requested workspaces fail before Cursor preparation', async (t) => {
  const f = fixture(t);

  // An anonymous default adapter cannot turn empty configuration into authority
  // to use whichever workspace was last saved on the machine.
  for (const invoke of [
    (bridge) => bridge.contextEngine('locate owner'),
    (bridge) => bridge.doTask('review only', { readOnly: true }),
  ]) {
    const anonymous = new AdmissionBridge(f);
    const error = await rejectionOf(invoke(anonymous));
    assertRecovery(error, 'WORKSPACE_CONFIRMATION_REQUIRED', null, null);
    assertNoSend(anonymous);
  }

  for (const invoke of [
    (bridge) => bridge.contextEngine('locate owner', { workspacePath: f.projectA }),
    (bridge) => bridge.doTask('review only', { workspacePath: f.projectA, readOnly: true }),
  ]) {
    const bridge = new AdmissionBridge(f, { workspaceKey: 'host:unbound' });
    const error = await rejectionOf(invoke(bridge));
    assertRecovery(error, 'WORKSPACE_INITIALIZATION_REQUIRED', f.projectA, null);
    assertNoSend(bridge);
  }

  const invalidValues = [42, {}, '', 'relative/project'];
  for (const workspacePath of invalidValues) {
    for (const invoke of [
      (bridge) => bridge.contextEngine('locate owner', { workspacePath }),
      (bridge) => bridge.doTask('review only', { workspacePath, readOnly: true }),
    ]) {
      const bridge = new AdmissionBridge(f);
      const error = await rejectionOf(invoke(bridge));
      assert.equal(error.code, 'WORKSPACE_PATH_INVALID', error.message);
      assertNoSend(bridge);
    }
  }

  for (const invoke of [
    (bridge) => bridge.contextEngine('locate owner', { workspacePath: f.projectB }),
    (bridge) => bridge.doTask('review only', { workspacePath: f.projectB, readOnly: true }),
  ]) {
    const bridge = new AdmissionBridge(f);
    await bridge.initializeWorkspace(f.projectA);
    bridge.ensureCalls.length = 0;
    bridge.enqueueCalls.length = 0;
    // A live execution target is more authoritative than the saved binding.
    bridge._lastLifecycle = { projectPath: f.projectC };
    const mismatch = await rejectionOf(invoke(bridge));
    assertRecovery(mismatch, 'WORKSPACE_MISMATCH', f.projectB, f.projectC);
    assertNoSend(bridge);
  }
});

test('canonical equal workspace assertions and omitted workspacePath keep compatible calls working', async (t) => {
  const f = fixture(t);
  const bridge = new AdmissionBridge(f);
  await bridge.initializeWorkspace(f.projectA);
  bridge.ensureCalls.length = 0;
  bridge.enqueueCalls.length = 0;

  const canonicalEquivalent = join(f.projectA, '.');
  const cce = await bridge.contextEngine('trace this symbol', { workspacePath: canonicalEquivalent });
  assert.match(cce, /^CCE_SEARCH_RESULT/);
  assert.equal(bridge.ensureCalls.length, 1);
  assert.equal(bridge.enqueueCalls[0].options.projectPath, resolve(f.projectA));

  const compatibleCce = await bridge.contextEngine('trace without an assertion');
  assert.match(compatibleCce, /^CCE_SEARCH_RESULT/);
  assert.equal(bridge.enqueueCalls.at(-1).options.projectPath, resolve(f.projectA));

  const delegated = await bridge.doTask('review this file', { workspacePath: canonicalEquivalent, readOnly: true });
  assert.ok(delegated.taskId);
  assert.equal(bridge.enqueueCalls.at(-1).options.projectPath, resolve(f.projectA));

  const compatibleDo = await bridge.doTask('review without an assertion', { readOnly: true });
  assert.ok(compatibleDo.taskId);
  assert.equal(bridge.enqueueCalls.at(-1).options.projectPath, resolve(f.projectA));
});

test('default saved bindings require a new explicit init and do not cross-contaminate live adapters', async (t) => {
  const f = fixture(t);
  const first = new AdmissionBridge(f);
  await first.initializeWorkspace(f.projectA);

  const second = new AdmissionBridge(f);
  assert.equal(second.workspaceView().workspaceConfirmationRequired, true);
  await second.initializeWorkspace(f.projectB);

  assert.equal(first.workspaceView().projectPath, resolve(f.projectA));
  assert.equal(second.workspaceView().projectPath, resolve(f.projectB));
  assert.equal(readWorkspaceBinding(f.workspaceFile, 'default').projectPath, resolve(f.projectB));

  const restarted = new AdmissionBridge(f);
  assert.equal(restarted.workspaceView().workspaceConfirmationRequired, true);
  const error = await rejectionOf(restarted.doTask('review after restart', { readOnly: true }));
  assertRecovery(error, 'WORKSPACE_CONFIRMATION_REQUIRED', null, resolve(f.projectB));
  assertNoSend(restarted);
});

test('concurrent cursor_init calls serialize preparation and expose workspaceBusy while waiting', async (t) => {
  const f = fixture(t);
  const bridge = new AdmissionBridge(f);
  const firstEnsureStarted = deferred();
  const releaseFirstEnsure = deferred();
  let concurrentEnsures = 0;
  let maximumConcurrentEnsures = 0;

  bridge.ensureHook = async () => {
    concurrentEnsures++;
    maximumConcurrentEnsures = Math.max(maximumConcurrentEnsures, concurrentEnsures);
    if (bridge.ensureCalls.length === 1) {
      firstEnsureStarted.resolve();
      await releaseFirstEnsure.promise;
    }
    concurrentEnsures--;
  };

  const first = bridge.initializeWorkspace(f.projectA);
  await firstEnsureStarted.promise;
  const second = bridge.initializeWorkspace(f.projectB);
  await Promise.resolve();
  await Promise.resolve();
  const callsBeforeRelease = bridge.ensureCalls.length;
  const busyDuringPreparation = (await bridge.status()).workspaceBusy;
  releaseFirstEnsure.resolve();
  const [, secondResult] = await Promise.all([first, second]);

  assert.equal(callsBeforeRelease, 1);
  assert.equal(maximumConcurrentEnsures, 1);
  assert.equal(busyDuringPreparation, true);
  assert.equal(secondResult.workspaceBusy, false);
  assert.equal((await bridge.status()).workspaceBusy, false);
  assert.equal(bridge.workspaceView().projectPath, resolve(f.projectB));
});

test('two cursor_init calls already waiting for healing keep their own result targets and serialize registration', async (t) => {
  const f = fixture(t);
  const bridge = new AdmissionBridge(f);
  const healing = deferred();
  const firstRegistrationStarted = deferred();
  const releaseFirstRegistration = deferred();
  bridge._healing = healing.promise;
  let concurrentRegistrations = 0;
  let maximumConcurrentRegistrations = 0;

  bridge.ensureHook = async () => {
    concurrentRegistrations++;
    maximumConcurrentRegistrations = Math.max(maximumConcurrentRegistrations, concurrentRegistrations);
    if (bridge.ensureCalls.length === 1) {
      firstRegistrationStarted.resolve();
      await releaseFirstRegistration.promise;
    }
    concurrentRegistrations--;
  };

  const initA = bridge.initializeWorkspace(f.projectA);
  const initB = bridge.initializeWorkspace(f.projectB);
  await flushMicrotasks();
  assert.equal(bridge.ensureCalls.length, 0);
  assert.equal(bridge.workspaceView().workspaceBusy, true);

  healing.resolve();
  await firstRegistrationStarted.promise;
  await flushMicrotasks();
  assert.equal(bridge.ensureCalls.length, 1);
  assert.equal(maximumConcurrentRegistrations, 1);
  assert.equal(bridge.ensureCalls[0].projectPath, resolve(f.projectA));

  releaseFirstRegistration.resolve();
  const [resultA, resultB] = await Promise.all([initA, initB]);
  assert.equal(resultA.projectPath, resolve(f.projectA));
  assert.equal(resultB.projectPath, resolve(f.projectB));
  assert.deepEqual(bridge.ensureCalls.map((call) => call.projectPath), [resolve(f.projectA), resolve(f.projectB)]);
  assert.equal(maximumConcurrentRegistrations, 1);
  assert.equal(bridge.workspaceView().workspaceBusy, false);
});

test('submission holds admission only through enqueue, preserving its workspace and rejecting a queued init', async (t) => {
  const f = fixture(t);
  const bridge = new AdmissionBridge(f);
  await bridge.initializeWorkspace(f.projectA);
  bridge.ensureCalls.length = 0;
  bridge.enqueueCalls.length = 0;

  const submitEnsureStarted = deferred();
  const releaseSubmitEnsure = deferred();
  bridge.ensureHook = async () => {
    if (bridge.ensureCalls.length === 1) {
      submitEnsureStarted.resolve();
      await releaseSubmitEnsure.promise;
    }
  };

  const submit = bridge.doTask('keep A as the target', { workspacePath: f.projectA, readOnly: true });
  await submitEnsureStarted.promise;
  const competingInit = bridge.initializeWorkspace(f.projectB);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bridge.workspaceView().projectPath, resolve(f.projectA));
  assert.equal((await bridge.status()).workspaceBusy, true);

  releaseSubmitEnsure.resolve();
  const task = await submit;
  assert.ok(task.taskId);
  assert.equal(bridge.enqueueCalls[0].options.projectPath, resolve(f.projectA));
  await assert.rejects(competingInit, /queued or running/);
  assert.equal(bridge.workspaceView().projectPath, resolve(f.projectA));

  // The task remains queued, but admission was released after enqueue: another
  // submission to the same bound workspace can prepare and enqueue immediately.
  assert.equal((await bridge.status()).workspaceBusy, false);
  await bridge.contextEngine('a second read-only lookup', { workspacePath: f.projectA });
  assert.equal(bridge.enqueueCalls.at(-1).kind, 'context_engine');
});

test('an init that owns admission makes queued old-workspace CCE and do reject without enqueueing', async (t) => {
  const f = fixture(t);
  const bridge = new AdmissionBridge(f);
  await bridge.initializeWorkspace(f.projectA);
  bridge.ensureCalls.length = 0;
  bridge.enqueueCalls.length = 0;

  const initPreparationStarted = deferred();
  const releaseInitPreparation = deferred();
  bridge.ensureHook = async () => {
    if (bridge.ensureCalls.length === 1) {
      initPreparationStarted.resolve();
      await releaseInitPreparation.promise;
    }
  };

  const initB = bridge.initializeWorkspace(f.projectB);
  await initPreparationStarted.promise;
  const cceForA = bridge.contextEngine('lookup must not use old A', { workspacePath: f.projectA });
  const doForA = bridge.doTask('review must not use old A', { workspacePath: f.projectA, readOnly: true });
  await flushMicrotasks();
  assert.equal(bridge.ensureCalls.length, 1);
  assert.equal(bridge.enqueueCalls.length, 0);
  assert.equal(bridge.workspaceView().workspaceBusy, true);

  releaseInitPreparation.resolve();
  const initResult = await initB;
  assert.equal(initResult.projectPath, resolve(f.projectB));
  const cceError = await rejectionOf(cceForA);
  const doError = await rejectionOf(doForA);
  assertRecovery(cceError, 'WORKSPACE_MISMATCH', resolve(f.projectA), resolve(f.projectB));
  assertRecovery(doError, 'WORKSPACE_MISMATCH', resolve(f.projectA), resolve(f.projectB));
  assert.equal(bridge.ensureCalls.length, 1);
  assert.equal(bridge.enqueueCalls.length, 0);
  assert.equal(bridge.workspaceView().workspaceBusy, false);
});

test('waiting for doTask or CCE results never retains workspace admission', async (t) => {
  const f = fixture(t);
  const bridge = new AdmissionBridge(f);
  await bridge.initializeWorkspace(f.projectA);
  bridge.ensureCalls.length = 0;
  bridge.enqueueCalls.length = 0;
  bridge.deferContextEngineResult = true;

  const waitingDo = bridge.doTask('wait for the delegated reply', {
    workspacePath: f.projectA,
    readOnly: true,
    background: false,
  });
  await flushMicrotasks();
  const doJob = [...bridge.tasks.values()].find((job) => job.kind === 'do');
  assert.ok(doJob, 'doTask must have enqueued its pending job');
  assert.equal(doJob.settled, false);

  let doProbeRan = false;
  const doProbe = bridge._withWorkspaceAdmission(() => { doProbeRan = true; });
  await flushMicrotasks();
  assert.equal(doProbeRan, true, 'a result-waiting doTask must not retain admission');
  await doProbe;
  assert.equal(bridge.workspaceView().workspaceBusy, false);
  bridge._finishJob(doJob, 'delegated reply');
  const doResult = await waitingDo;
  assert.equal(doResult.result, 'delegated reply');

  const waitingCce = bridge.contextEngine('wait for the CCE reply', { workspacePath: f.projectA });
  await flushMicrotasks();
  const cceJob = [...bridge.tasks.values()].find((job) => job.kind === 'context_engine');
  assert.ok(cceJob, 'CCE must have enqueued its pending job');
  assert.equal(cceJob.settled, false);

  let cceProbeRan = false;
  const cceProbe = bridge._withWorkspaceAdmission(() => { cceProbeRan = true; });
  await flushMicrotasks();
  assert.equal(cceProbeRan, true, 'a result-waiting CCE must not retain admission');
  await cceProbe;
  assert.equal(bridge.workspaceView().workspaceBusy, false);
  bridge._finishJob(cceJob, 'CCE_SEARCH_RESULT intent: wait\nevidence:\n- server.mjs:1-1 | test | source-read\ngaps: none\nconfidence: high');
  const cceResult = await waitingCce;
  assert.match(cceResult, /^CCE_SEARCH_RESULT/);
  assert.equal(bridge.workspaceView().workspaceBusy, false);
});

test('a failed preparation releases admission for a later explicit init', async (t) => {
  const f = fixture(t);
  const bridge = new AdmissionBridge(f);
  const ensureStarted = deferred();
  const releaseFailure = deferred();
  bridge.ensureHook = async () => {
    ensureStarted.resolve();
    await releaseFailure.promise;
    throw new Error('simulated preparation failure');
  };

  const failed = bridge.initializeWorkspace(f.projectA);
  await ensureStarted.promise;
  assert.equal((await bridge.status()).workspaceBusy, true);
  releaseFailure.resolve();
  await assert.rejects(failed, /simulated preparation failure/);

  bridge.ensureHook = async () => {};
  const recovered = await bridge.initializeWorkspace(f.projectB);
  assert.equal(recovered.projectPath, resolve(f.projectB));
  assert.equal(recovered.workspaceBusy, false);
  assert.equal((await bridge.status()).workspaceBusy, false);
});

test('session reconcile and collect_result require an explicit default workspace identity before dispatch', async (t) => {
  const f = fixture(t);
  writeWorkspaceBinding(f.workspaceFile, 'default', f.projectA);
  const bridge = new AdmissionBridge(f);
  let reconcileCalls = 0;
  bridge._reconcileSession = async () => {
    reconcileCalls++;
    return { found: true };
  };

  for (const action of ['reconcile', 'collect_result']) {
    const error = await rejectionOf(bridge.sessionControl('session-guarded', { action }));
    assertRecovery(error, 'WORKSPACE_CONFIRMATION_REQUIRED', null, resolve(f.projectA));
    assert.equal(reconcileCalls, 0, `${action} must not dispatch reconciliation`);
    assert.equal(bridge.ensureCalls.length, 0, `${action} must not prepare Cursor`);
  }
});

test('session reconcile and collect_result serialize with init without changing their confirmed target', async (t) => {
  const f = fixture(t);
  const bridge = new AdmissionBridge(f);
  await bridge.initializeWorkspace(f.projectA);
  bridge.ensureCalls.length = 0;

  const reconcileStarted = deferred();
  const collectStarted = deferred();
  const releaseReconcile = deferred();
  const releaseCollect = deferred();
  const calls = [];
  bridge._reconcileSession = async (sessionId, { collectResult }) => {
    calls.push({ sessionId, collectResult });
    if (collectResult) {
      collectStarted.resolve();
      await releaseCollect.promise;
      return { found: true, sessionId, action: 'collect_result', state: 'reconciled_result_collected' };
    }
    reconcileStarted.resolve();
    await releaseReconcile.promise;
    return { found: true, sessionId, action: 'reconcile', state: 'completed' };
  };

  const reconcile = bridge.sessionControl('session-serial', { action: 'reconcile' });
  await reconcileStarted.promise;
  const collect = bridge.sessionControl('session-serial', { action: 'collect_result' });
  const initB = bridge.initializeWorkspace(f.projectB);
  await flushMicrotasks();
  assert.equal(bridge.workspaceView().projectPath, resolve(f.projectA));
  assert.equal(bridge.workspaceView().workspaceBusy, true);
  assert.equal(bridge.ensureCalls.length, 0);

  releaseReconcile.resolve();
  await collectStarted.promise;
  await flushMicrotasks();
  assert.equal(bridge.workspaceView().projectPath, resolve(f.projectA));
  assert.equal(bridge.ensureCalls.length, 0);

  releaseCollect.resolve();
  const [reconciled, collected, initialized] = await Promise.all([reconcile, collect, initB]);
  assert.deepEqual(reconciled, {
    found: true,
    sessionId: 'session-serial',
    action: 'reconcile',
    state: 'completed',
  });
  assert.deepEqual(collected, {
    found: true,
    sessionId: 'session-serial',
    action: 'collect_result',
    state: 'reconciled_result_collected',
  });
  assert.deepEqual(calls, [
    { sessionId: 'session-serial', collectResult: false },
    { sessionId: 'session-serial', collectResult: true },
  ]);
  assert.equal(initialized.projectPath, resolve(f.projectB));
  assert.equal(bridge.ensureCalls.length, 1);
  assert.equal(bridge.workspaceView().projectPath, resolve(f.projectB));
  assert.equal(bridge.workspaceView().workspaceBusy, false);
});

test('a pre-existing default binding is never silently used by a fresh adapter', async (t) => {
  const f = fixture(t);
  writeWorkspaceBinding(f.workspaceFile, 'default', f.projectA);
  const bridge = new AdmissionBridge(f);
  const error = await rejectionOf(bridge.contextEngine('review saved workspace'));
  assertRecovery(error, 'WORKSPACE_CONFIRMATION_REQUIRED', null, resolve(f.projectA));
  assertNoSend(bridge);
});
