import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  coalesceInteractionResult,
  daemonPaths,
  ensureDaemonAuth,
  resolveHostKind,
  sendDaemonRequest,
  SupervisorClient,
  SupervisorDaemon,
} from "./supervisor-transport.mjs";
import { persistResultArtifact } from "./result-artifact.mjs";

const SESSION_ID = "01a010fc-7377-7330-b20f-9089aa5d93b6";

class FakeSupervisor {
  constructor() {
    this.attachedSessionId = null;
    this.attachedCwd = null;
    this.activeRun = null;
    this.calls = [];
  }

  async inspect(params = {}) {
    this.calls.push(["inspect", params]);
    if (params.view === "status") {
      return {
        view: "status",
        status: {
          activeRun: this.activeRun,
          pendingPermissions: [],
          pendingElicitations: [],
          recordedTuis: [],
        },
      };
    }
    return {
      view: "interaction",
      state: this.activeRun?.status === "running" ? "working" : this.attachedSessionId ? "ready" : "idle",
      session: { sessionId: this.attachedSessionId, cwd: this.attachedCwd, attached: Boolean(this.attachedSessionId) },
      run: this.activeRun,
    };
  }

  async initializeProxy(params = {}) {
    this.calls.push(["initialize_proxy", params]);
    return {
      initialized: true,
      status: "ready",
      proxy: { protocol: "http", host: "127.0.0.1", port: 43123 },
    };
  }

  async openSession(params) {
    this.calls.push(["open", params]);
    this.attachedSessionId = params.sessionId || SESSION_ID;
    this.attachedCwd = params.cwd;
    return { opened: true, sessionId: this.attachedSessionId, cwd: params.cwd };
  }

  startPrompt(params) {
    this.calls.push(["prompt", params]);
    this.activeRun = { runId: randomUUID(), sessionId: params.sessionId, status: "running" };
    return { started: true, ...this.activeRun };
  }

  respond(params) {
    this.calls.push(["respond", params]);
    return { answered: true };
  }

  async control(params) {
    this.calls.push(["control", params]);
    if (params.action === "disconnect") {
      this.attachedSessionId = null;
      this.attachedCwd = null;
    }
    return { controlled: true, action: params.action };
  }

  async status() {
    return {
      leader: { running: false },
      acpConnected: Boolean(this.attachedSessionId),
      attachedSessionId: this.attachedSessionId,
      activeRun: this.activeRun,
      pendingPermissions: [],
      pendingElicitations: [],
      recordedTuis: [],
    };
  }

  async disconnect() {
    this.attachedSessionId = null;
    this.attachedCwd = null;
    return { disconnected: true };
  }
}

function noSpawn() {
  throw new Error("test client unexpectedly tried to spawn a daemon");
}

test("daemon launch uses the persistent content-addressed runtime instead of the plugin cache", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-launch-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime", "daemon-0123456789abcdef0123");
  const daemonScript = join(runtimeRoot, "supervisor-daemon.mjs");
  let launch = null;
  const client = new SupervisorClient({
    stateRoot: root,
    clientVersion: "0.1.1-test",
    daemonRuntime: {
      runtimeRoot,
      daemonScript,
      fingerprint: "0123456789abcdef".repeat(4),
    },
    spawnProcess(command, args, options) {
      launch = { command, args, options };
      return { pid: 4242, unref() {} };
    },
  });

  assert.equal(client.launchDaemon(), 4242);
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.args[0], daemonScript);
  assert.equal(launch.options.cwd, dirname(daemonScript));
  assert.deepEqual(launch.args.slice(1, 5), ["--state-root", root, "--runtime-version", "0.1.1-test"]);
  assert.deepEqual(launch.args.slice(5), ["--runtime-fingerprint", client.runtimeFingerprint]);
  assert.equal(launch.options.detached, true);
});

test("MCP frontend derives a bounded host identity without trusting prompt arguments", () => {
  assert.equal(resolveHostKind({ CODEX_THREAD_ID: "thread-1" }), "codex");
  assert.equal(resolveHostKind({ CLAUDE_CODE_SESSION_ID: "session-1" }), "claude_code");
  assert.equal(resolveHostKind({ CLAUDE_PROJECT_DIR: "C:\\project" }), "claude_code");
  assert.equal(resolveHostKind({ GROK_SUPERVISOR_HOST_KIND: "claude_code", CODEX_THREAD_ID: "thread-1" }), "claude_code");
  assert.equal(resolveHostKind({ GROK_SUPERVISOR_HOST_KIND: "pi", CODEX_THREAD_ID: "thread-1" }), "pi");
  assert.equal(resolveHostKind({}), "unknown");
});

test("new MCP frontend coalesces and artifacts cumulative payloads from a legacy daemon", (t) => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "grok-legacy-result-"));
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const cumulative = `LEGACY_CUMULATIVE_TEXT:${"x".repeat(6_000)}`;
  const working = coalesceInteractionResult({
    view: "interaction",
    state: "working",
    run: {
      runId: SESSION_ID,
      sessionId: SESSION_ID,
      status: "running",
      finalText: cumulative,
      latestMessage: cumulative,
    },
    progress: cumulative,
    cursor: {
      nextAfterSequence: 20,
      hasMore: true,
      oldestAvailableSequence: 1,
      latestSequence: 240,
      cursorGap: false,
    },
  }, { afterSequence: 10 });
  assert.equal(working.run.finalText, null);
  assert.equal("latestMessage" in working.run, false);
  assert.equal(working.progress.contentSuppressed, true);
  assert.equal(working.progress.coalesced, true);
  assert.equal(working.progress.eventsCollapsed, true);
  assert.equal(working.progress.newActivity, true);
  assert.equal("phase" in working.progress, false);
  assert.equal(working.cursor.nextAfterSequence, 240);
  assert.equal(working.cursor.hasMore, false);
  assert.doesNotMatch(JSON.stringify(working), /LEGACY_CUMULATIVE_TEXT/);

  const structured = coalesceInteractionResult({
    view: "interaction",
    state: "working",
    run: { runId: SESSION_ID, sessionId: SESSION_ID, status: "running" },
    progress: {
      phase: "modifying",
      message: "Modifying: 1 file touched.",
      filesRead: 2,
      filesChanged: 1,
    },
    cursor: { latestSequence: 241, nextAfterSequence: 241, hasMore: false },
  }, { afterSequence: 240 });
  assert.equal(structured.progress.phase, "modifying");
  assert.equal(structured.progress.filesChanged, 1);
  assert.equal(structured.progress.eventsCollapsed, false);

  const completed = coalesceInteractionResult({
    ...working,
    state: "completed",
    run: { ...working.run, status: "completed", finalText: cumulative },
    cursor: { ...working.cursor, latestSequence: 241 },
  }, { afterSequence: 240 }, {
    resultArtifactRoot: artifactRoot,
    persistResultArtifact,
  });
  assert.equal(completed.run.finalText, null);
  assert.equal(completed.delivery.finalTextIncluded, false);
  assert.equal(completed.delivery.resultArtifactIncluded, true);
  assert.equal(readFileSync(completed.run.resultArtifact.path, "utf8"), cumulative);
  assert.ok(Buffer.byteLength(JSON.stringify(completed)) < 4_000);
  const legacyTerminal = coalesceInteractionResult({
    view: "interaction",
    state: "completed",
    run: { runId: SESSION_ID, sessionId: SESSION_ID, status: "completed", finalText: "done" },
    progress: "legacy cumulative progress",
    cursor: { latestSequence: 242, nextAfterSequence: 242, hasMore: false },
  }, { afterSequence: 241 });
  assert.equal(legacyTerminal.progress, null);
  const repeated = coalesceInteractionResult({
    view: "interaction",
    state: "completed",
    run: {
      runId: SESSION_ID,
      sessionId: SESSION_ID,
      status: "completed",
      finalText: cumulative,
    },
    cursor: { ...completed.cursor, latestSequence: 241 },
  }, { afterSequence: completed.cursor.nextAfterSequence }, {
    resultArtifactRoot: artifactRoot,
    persistResultArtifact,
  });
  assert.equal(repeated.run.finalText, null);
  assert.equal(repeated.delivery.finalTextIncluded, false);
  assert.equal(repeated.run.resultArtifact, null);
  assert.equal(repeated.delivery.resultArtifactAvailable, true);
  assert.equal(repeated.delivery.resultArtifactIncluded, false);
  assert.doesNotMatch(JSON.stringify(repeated), /LEGACY_CUMULATIVE_TEXT/);
});

test("daemon requires the capability token and never returns it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-daemon-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = daemonPaths(root);
  const token = ensureDaemonAuth(paths);
  const daemon = new SupervisorDaemon({ paths, authToken: token, supervisor: new FakeSupervisor(), runtimeVersion: "test" });
  await daemon.start();
  t.after(() => daemon.stop());

  await assert.rejects(() => sendDaemonRequest({
    paths,
    authToken: "0".repeat(64),
    clientId: randomUUID(),
    clientVersion: "test-client",
    method: "ping",
    params: {},
    timeoutMs: 2000,
  }), (error) => {
    assert.equal(error.code, "DAEMON_AUTH_FAILED");
    return true;
  });

  const client = new SupervisorClient({ paths, spawnProcess: noSpawn, clientVersion: "test" });
  const ping = await client.ping();
  assert.equal(ping.protocolVersion, 1);
  assert.equal(ping.capabilities.hostIdentityEnvelope, true);
  assert.equal(ping.capabilities.interactionDeliveryV2, true);
  assert.equal(ping.capabilities.persistentTuiRuntime, true);
  assert.equal(ping.capabilities.resultArtifacts, true);
  assert.equal(JSON.stringify(ping).includes(token), false);
});

test("new frontends fail safely against a legacy daemon that lacks host and TUI runtime capabilities", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-legacy-capabilities-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = daemonPaths(root);
  const daemon = new SupervisorDaemon({
    paths,
    supervisor: new FakeSupervisor(),
    runtimeVersion: "legacy",
    capabilities: {},
  });
  await daemon.start();
  t.after(() => daemon.stop());
  const claude = new SupervisorClient({
    paths,
    clientVersion: "legacy",
    hostKind: "claude_code",
    spawnProcess: noSpawn,
  });

  await assert.rejects(() => claude.initializeProxy({}), (error) => error.code === "GROK_INIT_REQUIRES_IDLE_UPGRADE");
  await assert.rejects(() => claude.openSession({
    mode: "new",
    cwd: process.cwd(),
    presentation: "windows_terminal",
    confirmation: "OPEN_GROK_SESSION",
  }), (error) => error.code === "GROK_OPEN_REQUIRES_IDLE_UPGRADE");
  await assert.rejects(() => claude.startPrompt({
    sessionId: SESSION_ID,
    prompt: "do not mislabel this sender",
    confirmation: "SEND_TO_GROK",
  }), (error) => error.code === "GROK_HOST_IDENTITY_UPGRADE_REQUIRED");
});

test("two MCP clients share one Supervisor while a fencing lease keeps one writer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-daemon-shared-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = daemonPaths(root);
  let now = 1_000;
  const fake = new FakeSupervisor();
  const daemon = new SupervisorDaemon({
    paths,
    supervisor: fake,
    runtimeVersion: "test",
    leaseMs: 100,
    now: () => now,
  });
  await daemon.start();
  t.after(() => daemon.stop());
  const first = new SupervisorClient({ paths, clientId: randomUUID(), clientVersion: "test", hostKind: "codex", spawnProcess: noSpawn });
  const second = new SupervisorClient({ paths, clientId: randomUUID(), clientVersion: "test", hostKind: "claude_code", spawnProcess: noSpawn });

  const initialized = await first.initializeProxy({});
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.proxy.port, 43123);
  assert.equal(first.leaseToken, null);

  const opened = await first.openSession({
    mode: "resume",
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    presentation: "none",
    confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  assert.equal(opened.sessionId, SESSION_ID);
  assert.match(first.leaseToken, /^[0-9a-f-]{36}$/i);
  await assert.rejects(() => second.initializeProxy({}), (error) => {
    assert.equal(error.code, "GROK_INIT_BUSY");
    return true;
  });
  let leakedLeaseToken = null;
  await sendDaemonRequest({
    paths,
    authToken: ensureDaemonAuth(paths),
    clientId: first.clientId,
    clientVersion: "forged-client",
    method: "ping",
    params: {},
    timeoutMs: 2000,
    onLeaseToken: (token) => { leakedLeaseToken = token; },
  });
  assert.equal(leakedLeaseToken, null);
  const newerFrontend = new SupervisorClient({
    paths,
    clientId: randomUUID(),
    clientVersion: "newer-test",
    spawnProcess: noSpawn,
  });
  const preservedDaemon = await newerFrontend.ping();
  assert.equal(preservedDaemon.runtimeVersion, "test");
  await assert.rejects(() => newerFrontend.initializeProxy({}), (error) => {
    assert.equal(error.code, "GROK_INIT_BUSY");
    return true;
  });
  const observed = await second.inspect({});
  assert.equal(observed.session.sessionId, SESSION_ID);

  await assert.rejects(() => sendDaemonRequest({
    paths,
    authToken: ensureDaemonAuth(paths),
    clientId: first.clientId,
    clientVersion: "forged-client",
    leaseToken: randomUUID(),
    method: "prompt",
    params: {
      sessionId: SESSION_ID,
      prompt: "stale writer must be fenced",
      confirmation: "SEND_TO_GROK",
    },
    timeoutMs: 2000,
  }), (error) => {
    assert.equal(error.code, "GROK_WRITER_FENCED");
    return true;
  });

  await assert.rejects(() => second.startPrompt({
    sessionId: SESSION_ID,
    prompt: "must wait for the lease",
    confirmation: "SEND_TO_GROK",
  }), (error) => {
    assert.equal(error.code, "GROK_WRITER_BUSY");
    return true;
  });

  const detached = await first.detach();
  assert.equal(detached.releasedWriter, true);
  const started = await second.startPrompt({
    sessionId: SESSION_ID,
    prompt: "take over after clean frontend detach",
    hostKind: "codex",
    confirmation: "SEND_TO_GROK",
  });
  assert.equal(started.started, true);
  assert.equal(fake.calls.filter(([kind]) => kind === "prompt").at(-1)[1].hostKind, "claude_code");

  const third = new SupervisorClient({ paths, clientId: randomUUID(), clientVersion: "test", spawnProcess: noSpawn });
  await assert.rejects(() => third.startPrompt({
    sessionId: SESSION_ID,
    prompt: "must wait for second writer",
    confirmation: "SEND_TO_GROK",
  }), (error) => error.code === "GROK_WRITER_BUSY");
  now += 101;
  const recoveredAfterCrash = await third.startPrompt({
    sessionId: SESSION_ID,
    prompt: "take over after crashed writer lease expires",
    confirmation: "SEND_TO_GROK",
  });
  assert.equal(recoveredAfterCrash.started, true);
  const status = await second.inspect({ view: "status" });
  assert.equal(status.status.daemon.writer.ownedByClient, false);
  assert.equal(fake.calls.filter(([kind]) => kind === "open").length, 1);
});

test("daemon busy state ignores a reused PID without registry and Leader ownership matches", async () => {
  const fake = new FakeSupervisor();
  fake.status = async () => ({
    acpConnected: false,
    attachedSessionId: null,
    activeRun: null,
    pendingPermissions: [],
    pendingElicitations: [],
    ownedVisibleTuiPids: [],
    recordedTuis: [{
      processAlive: true,
      processIdentityMatch: false,
      activeRegistryMatch: false,
      leaderOwnershipMatch: false,
    }],
  });
  const daemon = new SupervisorDaemon({ supervisor: fake, runtimeVersion: "test" });
  const state = await daemon.daemonBusyState();
  assert.equal(state.busy, false);
  assert.equal(state.liveTuiCount, 0);
});

test("daemon busy state blocks shutdown for a fully verified live TUI", async () => {
  const fake = new FakeSupervisor();
  fake.status = async () => ({
    acpConnected: false,
    attachedSessionId: null,
    activeRun: null,
    pendingPermissions: [],
    pendingElicitations: [],
    ownedVisibleTuiPids: [],
    recordedTuis: [{
      processAlive: true,
      processIdentityMatch: true,
      activeRegistryMatch: true,
      leaderOwnershipMatch: true,
    }],
  });
  const daemon = new SupervisorDaemon({ supervisor: fake, runtimeVersion: "test" });
  const state = await daemon.daemonBusyState();
  assert.equal(state.busy, true);
  assert.equal(state.liveTuiCount, 1);
});

test("daemon busy state uses the full verified-live count when public TUI details are capped", async () => {
  const fake = new FakeSupervisor();
  fake.status = async () => ({
    acpConnected: false,
    attachedSessionId: null,
    activeRun: null,
    pendingPermissions: [],
    pendingElicitations: [],
    pendingWorkspaceTrust: [],
    ownedVisibleTuiPids: [],
    recordedTuiCounts: { total: 21, verifiedLive: 1, repairableOrphaned: 0, displayed: 20 },
    recordedTuis: [],
  });
  const daemon = new SupervisorDaemon({ supervisor: fake, runtimeVersion: "test" });
  const state = await daemon.daemonBusyState();
  assert.equal(state.busy, true);
  assert.equal(state.liveTuiCount, 1);
});

test("daemon busy state preserves a verified trust-pending TUI before registry activation", async () => {
  const fake = new FakeSupervisor();
  fake.status = async () => ({
    acpConnected: false,
    attachedSessionId: null,
    activeRun: null,
    pendingPermissions: [],
    pendingElicitations: [],
    pendingWorkspaceTrust: [],
    ownedVisibleTuiPids: [],
    recordedTuis: [{
      status: "awaiting_workspace_trust",
      processAlive: true,
      processIdentityMatch: true,
      activeRegistryMatch: false,
      leaderOwnershipMatch: true,
    }],
  });
  const daemon = new SupervisorDaemon({ supervisor: fake, runtimeVersion: "test" });
  const state = await daemon.daemonBusyState();
  assert.equal(state.busy, true);
  assert.equal(state.liveTuiCount, 1);
});

test("detached daemon survives the launching client and accepts a fresh client", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-daemon-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = daemonPaths(root);
  const first = new SupervisorClient({ paths, startTimeoutMs: 15_000 });
  const firstPing = await first.ping();
  assert.notEqual(firstPing.daemonPid, process.pid);

  const second = new SupervisorClient({ paths, clientId: randomUUID(), startTimeoutMs: 15_000 });
  const secondPing = await second.ping();
  assert.equal(secondPing.daemonInstanceId, firstPing.daemonInstanceId);
  assert.equal(secondPing.daemonPid, firstPing.daemonPid);

  const stopped = await second.shutdownIdleDaemon();
  assert.equal(stopped.shuttingDown, true);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
});
