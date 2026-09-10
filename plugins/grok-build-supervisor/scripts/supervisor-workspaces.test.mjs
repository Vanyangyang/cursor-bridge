import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  daemonPaths,
  ensureDaemonAuth,
  sendDaemonRequest,
  SupervisorClient,
  SupervisorDaemon,
} from "./supervisor-transport.mjs";

const SESSION_A = "01900000-0000-7000-8000-0000000000a1";
const SESSION_B = "01900000-0000-7000-8000-0000000000b2";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error("Timed out waiting for test condition");
}

async function labeled(label, promise) {
  try {
    return await promise;
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

class WorkspaceFakeSupervisor {
  constructor({ workspaceCwd = null, blockOpen = null } = {}) {
    this.workspaceCwd = workspaceCwd ? resolve(workspaceCwd) : null;
    this.blockOpen = blockOpen;
    this.attachedSessionId = null;
    this.attachedCwd = null;
    this.activeRun = null;
    this.pendingPermissions = new Map();
    this.pendingElicitations = new Map();
    this.calls = [];
  }

  async openSession(params) {
    this.calls.push(["open", params]);
    if (this.blockOpen) await this.blockOpen.promise;
    this.attachedSessionId = params.sessionId;
    this.attachedCwd = resolve(params.cwd);
    return { opened: true, sessionId: params.sessionId, cwd: this.attachedCwd };
  }

  startPrompt(params) {
    this.calls.push(["prompt", params]);
    if (params.sessionId !== this.attachedSessionId) {
      throw Object.assign(new Error("unknown session"), { code: "GROK_SESSION_NOT_FOUND" });
    }
    this.activeRun = {
      runId: randomUUID(),
      sessionId: params.sessionId,
      status: "running",
    };
    return { started: true, ...this.activeRun };
  }

  respond(params) {
    this.calls.push(["respond", params]);
    if (!this.pendingPermissions.has(params.permissionId)) {
      throw Object.assign(new Error("unknown permission"), { code: "GROK_PERMISSION_NOT_FOUND" });
    }
    this.pendingPermissions.delete(params.permissionId);
    return { answered: true, permissionId: params.permissionId };
  }

  async control(params) {
    this.calls.push(["control", params]);
    if (params.action === "cancel" && this.activeRun) this.activeRun.status = "cancelled";
    if (params.action === "disconnect") {
      this.attachedSessionId = null;
      this.attachedCwd = null;
    }
    return { controlled: true, action: params.action };
  }

  async inspect(params = {}) {
    this.calls.push(["inspect", params]);
    if (params.view === "status") return { view: "status", status: await this.status() };
    return {
      view: "interaction",
      state: this.activeRun?.status === "running" ? "working" : this.attachedSessionId ? "ready" : "idle",
      session: {
        sessionId: this.attachedSessionId,
        cwd: this.attachedCwd,
        attached: Boolean(this.attachedSessionId),
      },
      run: this.activeRun,
    };
  }

  async status() {
    return {
      leader: { running: false },
      acpConnected: Boolean(this.attachedSessionId),
      attachedSessionId: this.attachedSessionId,
      activeRun: this.activeRun,
      pendingPermissions: [...this.pendingPermissions.values()],
      pendingElicitations: [...this.pendingElicitations.values()],
      pendingWorkspaceTrust: [],
      recordedTuis: [],
      ownedVisibleTuiPids: [],
    };
  }

  async initializeProxy() {
    this.calls.push(["initialize_proxy", {}]);
    return { initialized: true };
  }

  async disconnect() {
    this.calls.push(["disconnect", {}]);
    this.attachedSessionId = null;
    this.attachedCwd = null;
    return { disconnected: true };
  }
}

async function createHarness(t, { now = () => Date.now(), leaseMs = 60_000, blockLegacyOpen = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-workspaces-"));
  const cwdA = mkdtempSync(join(tmpdir(), "grok-workspace-a-"));
  const cwdB = mkdtempSync(join(tmpdir(), "grok-workspace-b-"));
  const legacy = new WorkspaceFakeSupervisor({ blockOpen: blockLegacyOpen });
  const created = [];
  const daemons = [];
  const daemon = new SupervisorDaemon({
    paths: daemonPaths(root),
    supervisor: legacy,
    supervisorFactory(options) {
      const fake = new WorkspaceFakeSupervisor({ workspaceCwd: options.workspaceCwd });
      created.push(fake);
      return fake;
    },
    runtimeVersion: "workspace-test",
    leaseMs,
    now,
  });
  daemons.push(daemon);
  await daemon.start();
  t.after(async () => {
    await Promise.all(daemons.map((item) => item.stop()));
    rmSync(root, { recursive: true, force: true });
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
  });
  const client = (options = {}) => new SupervisorClient({
    paths: daemon.paths,
    clientVersion: "workspace-test",
    spawnProcess() { throw new Error("unexpected daemon spawn"); },
    ...options,
  });
  return { root, cwdA, cwdB, legacy, created, daemon, daemons, client };
}

test("named-pipe clients route concurrent opens, prompts, responses, cancellation, and disconnect per workspace", async (t) => {
  const blocked = deferred();
  t.after(() => blocked.resolve());
  const harness = await createHarness(t, { blockLegacyOpen: blocked });
  const first = harness.client({ clientId: randomUUID(), hostKind: "codex" });
  const second = harness.client({ clientId: randomUUID(), hostKind: "claude_code" });
  let firstFinished = false;
  const openingA = first.openSession({
    mode: "resume", sessionId: SESSION_A, cwd: harness.cwdA,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  }).then((value) => { firstFinished = true; return value; });
  await waitFor(() => harness.legacy.calls.some(([kind]) => kind === "open"));

  const openedB = await labeled("open B", second.openSession({
    mode: "resume", sessionId: SESSION_B, cwd: harness.cwdB,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  }));
  assert.equal(openedB.sessionId, SESSION_B);
  const child = harness.daemon.registry.findCwd(harness.cwdB).supervisor;
  const startedB = await labeled("prompt B", second.startPrompt({
    cwd: harness.cwdB, sessionId: SESSION_B, prompt: "workspace B prompt",
    confirmation: "SEND_TO_GROK",
  }));
  assert.equal(startedB.started, true);
  assert.equal(firstFinished, false, "workspace B prompt must not wait for workspace A open");

  blocked.resolve();
  assert.equal((await labeled("finish open A", openingA)).sessionId, SESSION_A);
  await labeled("prompt A", first.startPrompt({
    cwd: harness.cwdA, sessionId: SESSION_A, prompt: "workspace A prompt",
    confirmation: "SEND_TO_GROK",
  }));
  assert.equal((await labeled("inspect A", first.inspect({ cwd: harness.cwdA }))).session.sessionId, SESSION_A);
  assert.equal((await labeled("inspect B", second.inspect({ cwd: harness.cwdB }))).session.sessionId, SESSION_B);

  child.pendingPermissions.set("permission-b", { permissionId: "permission-b" });
  const answered = await labeled("respond B", second.respond({
    cwd: harness.cwdB,
    sessionId: SESSION_B,
    permissionId: "permission-b",
    optionId: "allow_once",
    confirmation: "RESPOND_TO_GROK",
  }));
  assert.equal(answered.answered, true);
  assert.deepEqual(child.calls.filter(([kind]) => kind === "respond").at(-1)[1], {
    permissionId: "permission-b",
    optionId: "allow_once",
    confirmation: "RESPOND_TO_GROK",
  });
  assert.equal(harness.legacy.calls.some(([kind]) => kind === "respond"), false);

  await labeled("cancel B", second.control({
    cwd: harness.cwdB, sessionId: SESSION_B, runId: startedB.runId,
    action: "cancel", confirmation: "CONTROL_GROK_SESSION",
  }));
  assert.equal(child.activeRun.status, "cancelled");
  assert.equal(harness.legacy.activeRun.status, "running");
  await labeled("disconnect B", second.control({
    cwd: harness.cwdB, sessionId: SESSION_B,
    action: "disconnect", confirmation: "CONTROL_GROK_SESSION",
  }));
  assert.equal(child.attachedSessionId, null);
  assert.equal(harness.legacy.attachedSessionId, SESSION_A);
});

test("writer fencing is workspace-scoped and expired tokens are never revived", async (t) => {
  let clock = 1_000;
  const harness = await createHarness(t, { now: () => clock, leaseMs: 100 });
  const owner = harness.client({ clientId: randomUUID() });
  const contender = harness.client({ clientId: randomUUID() });
  await owner.openSession({
    mode: "resume", sessionId: SESSION_A, cwd: harness.cwdA,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  const firstToken = owner.leaseToken;
  assert.match(firstToken, /^[0-9a-f-]{36}$/i);
  await assert.rejects(() => contender.startPrompt({
    cwd: harness.cwdA, sessionId: SESSION_A, prompt: "must be busy", confirmation: "SEND_TO_GROK",
  }), (error) => error.code === "GROK_WRITER_BUSY");
  await assert.rejects(() => sendDaemonRequest({
    paths: harness.daemon.paths,
    authToken: ensureDaemonAuth(harness.daemon.paths),
    clientId: owner.clientId,
    clientVersion: "workspace-test",
    leaseToken: randomUUID(),
    workspaceCwd: harness.cwdA,
    method: "prompt",
    params: { cwd: harness.cwdA, sessionId: SESSION_A, prompt: "fenced", confirmation: "SEND_TO_GROK" },
    timeoutMs: 2_000,
  }), (error) => error.code === "GROK_WRITER_FENCED");

  let leaked = null;
  await sendDaemonRequest({
    paths: harness.daemon.paths,
    authToken: ensureDaemonAuth(harness.daemon.paths),
    clientId: owner.clientId,
    clientVersion: "workspace-test",
    workspaceCwd: harness.cwdA,
    method: "ping",
    params: {}, timeoutMs: 2_000,
    onLeaseToken(token) { leaked = token; },
  });
  assert.equal(leaked, null);

  clock += 101;
  await contender.startPrompt({
    cwd: harness.cwdA, sessionId: SESSION_A, prompt: "new owner", confirmation: "SEND_TO_GROK",
  });
  const secondToken = contender.leaseToken;
  assert.notEqual(secondToken, firstToken);
  clock += 101;
  await owner.startPrompt({
    cwd: harness.cwdA, sessionId: SESSION_A, prompt: "new lease, not old token revival", confirmation: "SEND_TO_GROK",
  });
  assert.notEqual(owner.leaseToken, firstToken);

  clock += 101;
  const rejected = harness.client({ clientId: randomUUID() });
  const entryA = harness.daemon.registry.findCwd(harness.cwdA);
  const leaseBeforeWrongSession = { ...entryA.writerLease };
  await assert.rejects(() => rejected.startPrompt({
    cwd: harness.cwdA,
    sessionId: "01900000-0000-7000-8000-0000000000ff",
    prompt: "wrong session",
    confirmation: "SEND_TO_GROK",
  }), (error) => error.code === "GROK_WORKSPACE_SESSION_MISMATCH");
  assert.deepEqual(entryA.writerLease, leaseBeforeWrongSession);
});

test("an opening workspace keeps its writer fenced past lease expiry", async (t) => {
  let clock = 1_000;
  const blocked = deferred();
  t.after(() => blocked.resolve());
  const harness = await createHarness(t, { now: () => clock, leaseMs: 100, blockLegacyOpen: blocked });
  const owner = harness.client({ clientId: randomUUID() });
  const contender = harness.client({ clientId: randomUUID() });
  const opening = owner.openSession({
    mode: "resume", sessionId: SESSION_A, cwd: harness.cwdA,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  await waitFor(() => harness.legacy.calls.some(([kind]) => kind === "open"));
  const entry = harness.daemon.registry.findCwd(harness.cwdA);
  const openingToken = entry.writerLease.fencingToken;
  clock += 101;
  let contenderSettled = false;
  const competingOpen = contender.openSession({
    mode: "resume", sessionId: SESSION_A, cwd: harness.cwdA,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  }).finally(() => { contenderSettled = true; });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  assert.equal(contenderSettled, false);
  assert.equal(entry.writerLease.fencingToken, openingToken);
  assert.equal(entry.writerLease.clientId, owner.clientId);

  blocked.resolve();
  await opening;
  await assert.rejects(() => competingOpen, (error) => error.code === "GROK_WRITER_BUSY");
  assert.equal(entry.writerLease.clientId, owner.clientId);
  assert.ok(entry.writerLease.expiresAt > clock);
});

test("writer rollback cannot overwrite a different owner and client token callbacks ignore older responses", async (t) => {
  let clock = 1_000;
  const harness = await createHarness(t, { now: () => clock, leaseMs: 100 });
  const entry = harness.daemon.registry.legacy;
  const replacement = {
    clientId: "replacement-client",
    sessionId: SESSION_A,
    fencingToken: randomUUID(),
    acquiredAt: 1_101,
    expiresAt: 1_201,
  };
  await assert.rejects(() => harness.daemon.runWithWriter(
    entry,
    "failing-client",
    SESSION_A,
    null,
    async () => {
      clock = 1_101;
      entry.writerLease = replacement;
      throw new Error("simulated core rejection");
    },
  ), /simulated core rejection/);
  assert.equal(entry.writerLease, replacement);

  const client = harness.client({ clientId: randomUUID() });
  const workspace = { key: "workspace-key", cwd: harness.cwdA };
  client.acceptWorkspaceResponse({ sequence: 2, method: "open", explicitCwd: harness.cwdA, workspaceCwd: harness.cwdA }, {
    workspace,
    leaseToken: "newer-token",
  });
  client.acceptWorkspaceResponse({ sequence: 1, method: "open", explicitCwd: harness.cwdA, workspaceCwd: harness.cwdA }, {
    workspace,
    leaseToken: "older-delayed-token",
  });
  assert.equal(client.workspaceLeaseTokens.get(workspace.key), "newer-token");
  assert.equal(client.leaseToken, "newer-token");
});

test("ambiguous clients fail closed and restart restores exact session routing", async (t) => {
  const harness = await createHarness(t);
  const opener = harness.client({ clientId: randomUUID() });
  await opener.openSession({
    mode: "resume", sessionId: SESSION_A, cwd: harness.cwdA,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  await opener.openSession({
    mode: "resume", sessionId: SESSION_B, cwd: harness.cwdB,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  const detached = await opener.detach();
  assert.equal(detached.releasedWriters, 2);
  assert.equal(harness.daemon.registry.findCwd(harness.cwdA).writerLease, null);
  assert.equal(harness.daemon.registry.findCwd(harness.cwdB).writerLease, null);
  assert.equal(harness.daemon.registry.findCwd(harness.cwdA).supervisor.attachedSessionId, SESSION_A);
  assert.equal(harness.daemon.registry.findCwd(harness.cwdB).supervisor.attachedSessionId, SESSION_B);

  const ambiguous = harness.client({ clientId: randomUUID() });
  await assert.rejects(() => ambiguous.inspect({}), (error) => error.code === "GROK_WORKSPACE_REQUIRED");

  await harness.daemon.stop();
  const legacy = new WorkspaceFakeSupervisor();
  const restarted = new SupervisorDaemon({
    paths: harness.daemon.paths,
    supervisor: legacy,
    supervisorFactory: (options) => new WorkspaceFakeSupervisor({ workspaceCwd: options.workspaceCwd }),
    runtimeVersion: "workspace-test",
  });
  harness.daemon = restarted;
  harness.daemons.push(restarted);
  await restarted.start();
  const fresh = harness.client({ clientId: randomUUID() });
  const exact = await fresh.inspect({ sessionId: SESSION_B });
  assert.equal(exact.session.sessionId, null);
  const routedEntryB = restarted.registry.findCwd(harness.cwdB);
  assert.equal(fresh.workspaceCwd, routedEntryB.cwd);
  assert.equal(fresh.workspaceBinding.key, routedEntryB.key);
  const routedB = routedEntryB.supervisor;
  routedB.attachedSessionId = SESSION_B;
  routedB.attachedCwd = resolve(harness.cwdB);
  const started = await fresh.startPrompt({ sessionId: SESSION_B, prompt: "restart route", confirmation: "SEND_TO_GROK" });
  assert.equal(started.sessionId, SESSION_B);
  assert.equal(legacy.calls.some(([kind]) => kind === "prompt"), false);
});

test("an in-flight open blocks proxy initialization and daemon upgrade", async (t) => {
  const blocked = deferred();
  const harness = await createHarness(t, { blockLegacyOpen: blocked });
  const client = harness.client({ clientId: randomUUID() });
  const opening = client.openSession({
    mode: "resume", sessionId: SESSION_A, cwd: harness.cwdA,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  await waitFor(() => harness.legacy.calls.some(([kind]) => kind === "open"));
  const request = (method, params) => sendDaemonRequest({
    paths: harness.daemon.paths,
    authToken: ensureDaemonAuth(harness.daemon.paths),
    clientId: randomUUID(),
    clientVersion: "workspace-test",
    method, params, timeoutMs: 2_000,
  });
  await assert.rejects(() => request("initialize_proxy", {}), (error) => error.code === "GROK_INIT_BUSY");
  const upgrade = await request("upgrade_if_idle", {
    confirmation: "RESTART_IDLE_SUPERVISOR_DAEMON",
    targetVersion: "next-version",
    targetFingerprint: null,
  });
  assert.equal(upgrade.busy, true);
  assert.equal(upgrade.workspaces.some((workspace) => workspace.inFlightWrites > 0), true);
  blocked.resolve();
  await opening;
});

test("workspace envelope conflicts fail before core open and selected cwd is canonicalized for core calls", async (t) => {
  const harness = await createHarness(t);
  await assert.rejects(() => sendDaemonRequest({
    paths: harness.daemon.paths,
    authToken: ensureDaemonAuth(harness.daemon.paths),
    clientId: randomUUID(),
    clientVersion: "workspace-test",
    workspaceCwd: harness.cwdA,
    method: "open",
    params: {
      mode: "resume", sessionId: SESSION_B, cwd: harness.cwdB,
      presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
    },
    timeoutMs: 2_000,
  }), (error) => error.code === "GROK_WORKSPACE_SESSION_MISMATCH");
  assert.equal(harness.legacy.calls.some(([kind]) => kind === "open"), false);
  assert.equal(harness.created.some((fake) => fake.calls.some(([kind]) => kind === "open")), false);

  const client = harness.client({ clientId: randomUUID() });
  await client.openSession({
    mode: "resume", sessionId: SESSION_A, cwd: harness.cwdA,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  const entry = harness.daemon.registry.findCwd(harness.cwdA);
  assert.equal(harness.legacy.calls.filter(([kind]) => kind === "open").at(-1)[1].cwd, entry.cwd);
  await client.inspect({ cwd: harness.cwdA });
  assert.equal(harness.legacy.calls.filter(([kind]) => kind === "inspect").at(-1)[1].cwd, entry.cwd);
});

test("selected inspect renews only a live matching writer lease and ping never returns or revives it", async (t) => {
  let clock = 1_000;
  const harness = await createHarness(t, { now: () => clock, leaseMs: 100 });
  const client = harness.client({ clientId: randomUUID() });
  await client.openSession({
    mode: "resume", sessionId: SESSION_A, cwd: harness.cwdA,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  const entry = harness.daemon.registry.findCwd(harness.cwdA);
  const token = entry.writerLease.fencingToken;
  assert.equal(entry.writerLease.expiresAt, 1_100);
  clock = 1_050;
  await client.inspect({ cwd: harness.cwdA });
  assert.equal(entry.writerLease.expiresAt, 1_150);

  clock = 1_149;
  let leaked = null;
  await sendDaemonRequest({
    paths: harness.daemon.paths,
    authToken: ensureDaemonAuth(harness.daemon.paths),
    clientId: client.clientId,
    clientVersion: "workspace-test",
    leaseToken: token,
    workspaceCwd: harness.cwdA,
    method: "ping", params: {}, timeoutMs: 2_000,
    onLeaseToken(value) { leaked = value; },
  });
  assert.equal(leaked, null);
  assert.equal(entry.writerLease.expiresAt, 1_150);
  clock = 1_151;
  await client.inspect({ cwd: harness.cwdA });
  assert.equal(entry.writerLease.expiresAt, 1_150);
  assert.equal(harness.daemon.leaseSnapshot(entry, client.clientId).active, false);
});

test("idle Leader permits rollover but blocks proxy reinitialization and accepted lifecycle stays fenced until stop", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-lifecycle-fence-"));
  const cwd = mkdtempSync(join(tmpdir(), "grok-workspace-lifecycle-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  const request = (method, params, clientId = randomUUID()) => ({
    clientId, clientVersion: "workspace-test", method, params,
  });
  const fake = new WorkspaceFakeSupervisor();
  fake.status = async () => ({
    leader: { running: true }, acpConnected: false, attachedSessionId: null,
    activeRun: null, pendingPermissions: [], pendingElicitations: [],
    pendingWorkspaceTrust: [], recordedTuis: [], ownedVisibleTuiPids: [],
  });
  const upgradeDaemon = new SupervisorDaemon({
    stateRoot: root,
    supervisor: fake,
    supervisorFactory: (options) => new WorkspaceFakeSupervisor({ workspaceCwd: options.workspaceCwd }),
    runtimeVersion: "old",
  });
  let upgradeStopped = false;
  upgradeDaemon.stop = async () => { upgradeStopped = true; upgradeDaemon.stopping = true; };
  const busy = await upgradeDaemon.daemonBusyState();
  assert.equal(busy.busy, false);
  assert.equal(busy.leaderRunningCount, 1);
  await assert.rejects(() => upgradeDaemon.route(request("initialize_proxy", {})), (error) => error.code === "GROK_INIT_BUSY");
  const upgrade = await upgradeDaemon.route(request("upgrade_if_idle", {
    confirmation: "RESTART_IDLE_SUPERVISOR_DAEMON",
    targetVersion: "new",
  }));
  assert.equal(upgrade.restarting, true);
  assert.equal(upgradeDaemon.lifecycleOperation, "upgrade_if_idle");
  await assert.rejects(() => upgradeDaemon.route(request("open", {
    mode: "resume", sessionId: SESSION_A, cwd,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  })), (error) => error.code === "GROK_SUPERVISOR_BUSY");
  await waitFor(() => upgradeStopped);

  const shutdownRoot = mkdtempSync(join(tmpdir(), "grok-supervisor-shutdown-fence-"));
  t.after(() => rmSync(shutdownRoot, { recursive: true, force: true }));
  const shutdownDaemon = new SupervisorDaemon({
    stateRoot: shutdownRoot,
    supervisor: new WorkspaceFakeSupervisor(),
    supervisorFactory: (options) => new WorkspaceFakeSupervisor({ workspaceCwd: options.workspaceCwd }),
    runtimeVersion: "current",
  });
  shutdownDaemon.stop = async () => { shutdownDaemon.stopping = true; };
  const shutdown = await shutdownDaemon.route(request("shutdown", {
    confirmation: "STOP_IDLE_SUPERVISOR_DAEMON",
  }));
  assert.equal(shutdown.shuttingDown, true);
  assert.equal(shutdownDaemon.lifecycleOperation, "shutdown");
  await assert.rejects(() => shutdownDaemon.route(request("open", {
    mode: "resume", sessionId: SESSION_A, cwd,
    presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  })), (error) => error.code === "GROK_SUPERVISOR_BUSY");
});
