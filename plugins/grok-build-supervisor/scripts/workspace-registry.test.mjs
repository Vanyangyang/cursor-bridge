import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokSupervisor } from "./supervisor-core.mjs";
import { canonicalWorkspace, WorkspaceRegistry } from "./workspace-registry.mjs";

const SESSION_A = "01900000-0000-7000-8000-000000000001";
const SESSION_B = "01900000-0000-7000-8000-000000000002";
const RUN_A = "01900000-0000-7000-8000-000000000003";
const RUN_B = "01900000-0000-7000-8000-000000000005";
const PERMISSION_B = "01900000-0000-7000-8000-000000000004";

function fixture(t, legacySupervisor = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "grok-workspace-registry-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const a = join(root, "a");
  const b = join(root, "b");
  for (const path of [stateRoot, a, b]) mkdirSync(path);
  const created = [];
  const createSupervisor = (options) => {
    created.push(options);
    return { options, pendingPermissions: new Map(), pendingElicitations: new Map() };
  };
  const registry = new WorkspaceRegistry({ stateRoot, legacySupervisor, createSupervisor });
  return { root, stateRoot, a, b, created, registry, createSupervisor };
}

test("workspace registry separates state and reconnects exact sessions after restart", async (t) => {
  const f = fixture(t);
  const a = await f.registry.select({ cwd: f.a }, { create: true });
  f.registry.rememberSession(a, SESSION_A);
  const b = await f.registry.select({ cwd: f.b }, { create: true });
  f.registry.rememberSession(b, SESSION_B);
  assert.notEqual(a.supervisor, b.supervisor);
  assert.notEqual(a.stateRoot, b.stateRoot);
  assert.equal(a.stateRoot, f.stateRoot);
  assert.equal(b.stateRoot, join(f.stateRoot, "workspaces", canonicalWorkspace(f.b).key));
  assert.equal(f.created[0].proxySettingsPath, join(f.stateRoot, "proxy-settings.json"));
  assert.equal(f.created[0].workspaceCwd, f.b);
  const restored = new WorkspaceRegistry({
    stateRoot: f.stateRoot, legacySupervisor: {}, createSupervisor: f.createSupervisor,
  });
  assert.equal((await restored.select({ sessionId: SESSION_B })).cwd, f.b);
  assert.equal((await restored.select({ sessionId: SESSION_A })).cwd, f.a);
  assert.equal(restored.entries.size, 2);
  const saved = JSON.parse(readFileSync(f.registry.path, "utf8"));
  assert.equal(saved.workspaces.length, 2);
});

test("workspace registry preserves pre-upgrade Leader ownership in its original root", async (t) => {
  const legacy = { attachedSessionId: SESSION_A };
  const f = fixture(t, legacy);
  legacy.readLeaderOwnership = () => ({ valid: false, reason: "leader_process_not_alive", record: { cwd: f.a } });
  const b = await f.registry.select({ cwd: f.b }, { create: true });
  assert.notEqual(b.key, "legacy");
  assert.equal(f.registry.legacy.cwd, f.a);
  assert.equal((await f.registry.select({ sessionId: SESSION_A })).supervisor, legacy);
  assert.equal(f.registry.legacy.stateRoot, f.stateRoot);
});

test("workspace aliases resolve to the same state and writer domain", async (t) => {
  const f = fixture(t);
  const a = await f.registry.select({ cwd: f.a }, { create: true });
  const alias = join(f.root, "a-alias");
  symlinkSync(f.a, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await f.registry.select({ cwd: alias }, { create: true }), a);
  if (process.platform === "win32") {
    assert.equal(await f.registry.select({ cwd: f.a.toUpperCase() }, { create: true }), a);
  }
  assert.equal(f.registry.entries.size, 1);
  await assert.rejects(() => f.registry.select({ cwd: "relative" }, { create: true }), { code: "GROK_WORKSPACE_REQUIRED" });
});

test("workspace selection rejects conflicting session, permission, run, and host binding", async (t) => {
  const f = fixture(t);
  const a = await f.registry.select({ cwd: f.a }, { create: true });
  const b = await f.registry.select({ cwd: f.b }, { create: true });
  f.registry.rememberSession(a, SESSION_A);
  f.registry.rememberSession(b, SESSION_B);
  a.supervisor.activeRun = { sessionId: SESSION_A, runId: RUN_A };
  b.supervisor.pendingPermissions.set(PERMISSION_B, { sessionId: SESSION_B });
  for (const selectors of [
    { cwd: f.a, sessionId: SESSION_B },
    { sessionId: SESSION_A, permissionId: PERMISSION_B },
    { runId: RUN_A, permissionId: PERMISSION_B },
  ]) {
    await assert.rejects(() => f.registry.select(selectors, { create: true }), { code: "GROK_WORKSPACE_SESSION_MISMATCH" });
  }
  await assert.rejects(() => f.registry.select({ sessionId: SESSION_B }, { boundKey: a.key }), { code: "GROK_WORKSPACE_SESSION_MISMATCH" });
  assert.equal(await f.registry.select({ sessionId: SESSION_B }, { boundKey: a.key, readOnly: true }), b);
  assert.equal(await f.registry.select({ permissionId: PERMISSION_B }), b);
  await assert.rejects(() => f.registry.select({}), { code: "GROK_WORKSPACE_REQUIRED" });
  await assert.rejects(() => f.registry.select({}, { readOnly: true }), { code: "GROK_WORKSPACE_REQUIRED" });
  assert.throws(() => f.registry.rememberSession(b, SESSION_A), { code: "GROK_WORKSPACE_SESSION_MISMATCH" });
});

test("malformed or contradictory persisted ownership never creates a guessed workspace", async (t) => {
  const f = fixture(t);
  writeFileSync(f.registry.path, "{invalid");
  await assert.rejects(() => f.registry.initialize(), { code: "GROK_WORKSPACE_REGISTRY_INVALID" });
  assert.equal(f.created.length, 0);
});

test("real core instances isolate pending state, results, sockets and recovery journals", async (t) => {
  const f = fixture(t);
  const options = { stateRoot: f.stateRoot, durableEvents: false };
  const legacy = new GrokSupervisor(options);
  const registry = new WorkspaceRegistry({
    stateRoot: f.stateRoot, legacySupervisor: legacy,
    createSupervisor: (args) => new GrokSupervisor({ ...args, persistTuiRuntime: false, durableEvents: false }),
  });
  const a = await registry.select({ cwd: f.a }, { create: true });
  const b = await registry.select({ cwd: f.b }, { create: true });
  for (const field of ["socketPath", "leaderOwnershipPath", "tuiStateRoot", "resultArtifactRoot"]) {
    assert.notEqual(a.supervisor[field], b.supervisor[field], field);
  }
  assert.equal(a.supervisor.proxySettingsPath, b.supervisor.proxySettingsPath);
  assert.equal(a.supervisor.sessionRoot, b.supervisor.sessionRoot);
  assert.notEqual(a.supervisor.journal, b.supervisor.journal);
  a.supervisor.pendingPermissions.set(PERMISSION_B, { sessionId: SESSION_A });
  assert.equal(b.supervisor.pendingPermissions.size, 0);
  a.supervisor.activeRun = { sessionId: SESSION_A, runId: RUN_A, status: "running" };
  assert.equal(b.supervisor.activeRun, null);
});

test("stopping a recovered workspace Leader targets only its verified PID", async (t) => {
  const f = fixture(t);
  const alive = new Set([424240, 424241]);
  const terminated = [];
  const core = new GrokSupervisor({
    stateRoot: f.stateRoot, durableEvents: false,
    processIsAlive: (pid) => alive.has(pid),
    inspectProcessIdentity: (pid) => ({ fingerprint: `leader-${pid}` }),
    terminateProcess: (pid) => { terminated.push(pid); alive.delete(pid); },
  });
  core.readLeaderOwnership = () => ({ valid: true, record: { leaderPid: 424240, ownerToken: SESSION_A, processFingerprint: "leader-424240" } });
  core.readActiveSessions = () => [];
  core.disconnect = async () => ({ disconnected: true });
  core.leaderInfo = async () => ({ running: alive.has(424240) });
  core.removeStaleOwnedLock = () => {};
  core.clearLeaderOwnership = () => {};
  core.runGrok = async () => { assert.fail("must not use Grok's all-Leader kill command"); };
  const result = await core.stopOwnedLeader({ confirmation: "STOP_OWNED_LEADER" });
  assert.equal(result.stopped, true);
  assert.deepEqual(terminated, [424240]);
  assert.equal(alive.has(424241), true);
});

test("two persisted in-flight runs recover independently after the registry is recreated", async (t) => {
  const f = fixture(t);
  const createSupervisor = (args) => new GrokSupervisor({ ...args, persistTuiRuntime: false });
  const registry = new WorkspaceRegistry({
    stateRoot: f.stateRoot, legacySupervisor: createSupervisor({ stateRoot: f.stateRoot }), createSupervisor,
  });
  const a = await registry.select({ cwd: f.a }, { create: true });
  const b = await registry.select({ cwd: f.b }, { create: true });
  registry.rememberSession(a, SESSION_A);
  registry.rememberSession(b, SESSION_B);
  a.supervisor.record("prompt_started", { sessionId: SESSION_A, runId: RUN_A });
  b.supervisor.record("prompt_started", { sessionId: SESSION_B, runId: RUN_B });
  b.supervisor.record("permission_requested", { sessionId: SESSION_B, permissionId: PERMISSION_B });

  const restarted = new WorkspaceRegistry({
    stateRoot: f.stateRoot, legacySupervisor: createSupervisor({ stateRoot: f.stateRoot }), createSupervisor,
  });
  const recoveredA = (await restarted.select({ sessionId: SESSION_A })).supervisor.recovery;
  const recoveredB = (await restarted.select({ sessionId: SESSION_B })).supervisor.recovery;
  assert.equal(recoveredA.interruptedRun.runId, RUN_A);
  assert.equal(recoveredB.interruptedRun.runId, RUN_B);
  assert.equal(recoveredA.orphanedPermissions.length, 0);
  assert.equal(recoveredB.orphanedPermissions[0].permissionId, PERMISSION_B);
});

test("Leader identity is rechecked after disconnect before terminating a recovered PID", async (t) => {
  const f = fixture(t);
  let disconnected = false;
  const core = new GrokSupervisor({
    stateRoot: f.stateRoot, durableEvents: false,
    processIsAlive: () => true,
    terminateProcess: () => assert.fail("changed identity must not be terminated"),
  });
  core.readLeaderOwnership = () => ({
    valid: !disconnected, record: { leaderPid: 424240, ownerToken: SESSION_A },
  });
  core.readActiveSessions = () => [];
  core.disconnect = async () => { disconnected = true; };
  await assert.rejects(() => core.stopOwnedLeader({ confirmation: "STOP_OWNED_LEADER" }), /ownership changed before stop/);
});

test("unresolved session IDs never fall through to a singleton workspace mutation", async (t) => {
  const f = fixture(t);
  const a = await f.registry.select({ cwd: f.a }, { create: true });
  f.registry.rememberSession(a, SESSION_A);
  await assert.rejects(() => f.registry.select({ sessionId: SESSION_B }, { boundKey: a.key }), { code: "GROK_WORKSPACE_SESSION_MISMATCH" });
  await assert.rejects(() => f.registry.select({}), { code: "GROK_WORKSPACE_REQUIRED" });
  assert.equal(await f.registry.select({ cwd: f.a, sessionId: SESSION_B }, { create: true }), a);
});

test("failed registry writes never leave an unpersisted workspace or claim a durable session", async (t) => {
  const f = fixture(t);
  await f.registry.initialize();
  const save = f.registry.persist.bind(f.registry);
  f.registry.persist = () => { throw new Error("synthetic disk failure"); };
  await assert.rejects(() => f.registry.select({ cwd: f.a }, { create: true }), { code: "GROK_WORKSPACE_REGISTRY_WRITE_FAILED" });
  assert.equal(f.registry.legacy.cwd, null);
  f.registry.persist = save;
  const a = await f.registry.select({ cwd: f.a }, { create: true });
  f.registry.persist = () => { throw new Error("synthetic disk failure"); };
  assert.throws(() => f.registry.rememberSession(a, SESSION_A), (error) => {
    assert.equal(error.code, "GROK_WORKSPACE_REGISTRY_WRITE_FAILED");
    assert.equal(error.details.sessionId, SESSION_A);
    assert.equal(error.details.verificationRequired, true);
    return true;
  });
  assert.equal(a.sessionIds.has(SESSION_A), false);
  await assert.rejects(() => f.registry.select({ cwd: f.b }, { create: true }), { code: "GROK_WORKSPACE_REGISTRY_WRITE_FAILED" });
  assert.equal(f.registry.entries.size, 1);
});

test("unlocated legacy recovery is preserved instead of rebound to the next workspace", async (t) => {
  const legacy = { recovery: { interruptedRun: { sessionId: SESSION_A, runId: RUN_A } } };
  const f = fixture(t, legacy);
  const b = await f.registry.select({ cwd: f.b }, { create: true });
  assert.notEqual(b.key, "legacy");
  assert.equal(f.registry.legacy.cwd, null);
  assert.equal((await f.registry.select({ sessionId: SESSION_A, runId: RUN_A })).supervisor, legacy);
  await assert.rejects(() => f.registry.select({ cwd: f.b, sessionId: SESSION_A }, { create: true }), { code: "GROK_WORKSPACE_SESSION_MISMATCH" });
});

test("complete single-workspace legacy history retains its original root", async (t) => {
  const legacy = {};
  const f = fixture(t, legacy);
  legacy.events = [{ kind: "session_attached", sessionId: SESSION_A, cwd: f.a }];
  const a = await f.registry.select({ cwd: f.a }, { create: true });
  assert.equal(a.key, "legacy");
  assert.equal(f.registry.entries.size, 1);
});

test("a partial historical journal is insufficient to assign the unlocated legacy root", async (t) => {
  const legacy = { journal: { nextSequence: 100 } };
  const f = fixture(t, legacy);
  legacy.events = [{ kind: "session_attached", sessionId: SESSION_A, cwd: f.a }];
  assert.notEqual((await f.registry.select({ cwd: f.a }, { create: true })).key, "legacy");
  assert.equal(f.registry.legacy.cwd, null);
});

test("legacy discovery write failure restores the previous registration and blocks initialization", async (t) => {
  const legacy = { attachedSessionId: SESSION_A };
  const f = fixture(t, legacy);
  legacy.attachedCwd = f.a;
  f.registry.persist = () => { throw new Error("synthetic disk failure"); };
  await assert.rejects(() => f.registry.initialize(), { code: "GROK_WORKSPACE_REGISTRY_WRITE_FAILED" });
  assert.equal(f.registry.legacy.cwd, null);
  assert.equal(f.registry.legacy.sessionIds.size, 0);
});

test("a matching stale lock PID cannot authorize termination of a reused process", async (t) => {
  const f = fixture(t);
  const core = new GrokSupervisor({
    stateRoot: f.stateRoot, durableEvents: false,
    processIsAlive: () => true,
    inspectProcessIdentity: () => ({ fingerprint: "unrelated-process" }),
    terminateProcess: () => assert.fail("a reused PID must not be terminated"),
  });
  core.readLeaderOwnership = () => ({ valid: true, reason: "verified_lock_pid", record: {
    leaderPid: 424240, ownerToken: SESSION_A, processFingerprint: "original-leader",
  } });
  core.readActiveSessions = () => [];
  core.disconnect = async () => {};
  await assert.rejects(() => core.stopOwnedLeader({ confirmation: "STOP_OWNED_LEADER" }), /ownership changed before stop/);
});
