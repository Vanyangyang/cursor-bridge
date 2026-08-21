import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  agentMessageText,
  buildSupervisedPrompt,
  collectActiveSessions,
  compactForTransport,
  buildGrokAcpArgs,
  GrokSupervisor,
  parseLeaderPid,
  parseSupervisorQuestion,
  progressPhaseForToolCall,
  validateSessionId,
  validateWorkingDirectory,
} from "./supervisor-core.mjs";

const SESSION_ID = "01a010fc-7377-7330-b20f-9089aa5d93b6";
const OWNER_TOKEN = "01900000-0000-7000-8000-000000000001";

function createSupervisor(options = {}) {
  return new GrokSupervisor({ durableEvents: false, ...options });
}

test("validateSessionId accepts exact UUID and rejects partial IDs", () => {
  assert.equal(validateSessionId(SESSION_ID), SESSION_ID);
  assert.throws(() => validateSessionId("01a010fc"), /exact UUID/);
});

test("collectActiveSessions handles nested registry shapes", () => {
  const sessions = collectActiveSessions({
    clients: [{ session_id: "a", pid: 1 }, { nested: { session_id: "b", pid: 2 } }],
  });
  assert.deepEqual(sessions.map((item) => item.session_id), ["a", "b"]);
});

test("validateWorkingDirectory requires an absolute existing directory", () => {
  assert.equal(validateWorkingDirectory(process.cwd()), process.cwd());
  assert.throws(() => validateWorkingDirectory("."), /absolute existing directory/);
  assert.throws(() => validateWorkingDirectory("Z:\\definitely-missing-grok-supervisor"), /not an existing directory/);
});

test("proxy initialization is persisted by the Supervisor state owner and reflected in status", async () => {
  let stored = null;
  const supervisor = createSupervisor({
    proxySettingsPath: join(process.cwd(), "proxy-settings.test.json"),
    readProxySettings: () => stored,
    initializeProxySettings: async ({ settingsPath, proxyUrl }) => {
      assert.match(settingsPath, /proxy-settings\.test\.json$/);
      assert.equal(proxyUrl, undefined);
      stored = {
        proxy: { url: "http://127.0.0.1:43123", protocol: "http", host: "127.0.0.1", port: 43123 },
        source: "loopback_listener",
        verification: { kind: "http_connect", target: "example.com:443", statusCode: 200 },
        verifiedAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      };
      return {
        initialized: true,
        status: "ready",
        settingsPath,
        proxy: stored.proxy,
        source: stored.source,
        verification: stored.verification,
        verifiedAt: stored.verifiedAt,
        previousProxy: null,
      };
    },
  });
  assert.equal(supervisor.proxyConfigurationView().initialized, false);
  const initialized = await supervisor.initializeProxy({});
  assert.equal(initialized.proxyConfiguration.initialized, true);
  assert.equal(initialized.proxyConfiguration.endpoint.port, 43123);
  assert.equal(supervisor.events.at(-1).kind, "proxy_initialized");
});

test("compactForTransport bounds large transport values", () => {
  const compacted = compactForTransport({ text: "x".repeat(100_000) }, 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(compacted)) <= 4096);
  assert.match(compacted.text, /chars truncated/);
  const multibyte = compactForTransport({ text: "界".repeat(10_000) }, 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(multibyte)) <= 1024);
});

test("compactForTransport redacts common secret fields and bearer credentials", () => {
  const compacted = compactForTransport({
    apiKey: "secret-value",
    nested: { authorization: "Bearer abc.def.ghi", safe: "Bearer another-token" },
  });
  assert.equal(compacted.apiKey, "[redacted]");
  assert.equal(compacted.nested.authorization, "[redacted]");
  assert.equal(compacted.nested.safe, "Bearer [redacted]");
});

test("Leader JSON parsing and ACP arguments preserve verified ownership and safe permissions", () => {
  assert.equal(parseLeaderPid(JSON.stringify({ pid: 7331, socket_path: "leader.sock" })), 7331);
  assert.equal(parseLeaderPid(JSON.stringify({ leader: { process_id: "7332" } })), 7332);
  assert.equal(parseLeaderPid("not-json"), null);
  const args = buildGrokAcpArgs({ leaderSocket: join(process.cwd(), "leader.sock") });
  assert.deepEqual(args.slice(0, 3), ["--permission-mode", "default", "agent"]);
  assert.equal(args.includes("--always-approve"), false);
});

test("supervision prompt and fallback question keep clarification narrowly scoped", () => {
  const codexPrompt = buildSupervisedPrompt("Inspect the failing build.", "codex");
  const claudePrompt = buildSupervisedPrompt("Inspect the failing build.", "claude_code");
  const neutralPrompt = buildSupervisedPrompt("Inspect the failing build.");
  assert.match(codexPrompt, /delegated by Codex/);
  assert.match(claudePrompt, /\[Claude Code supervision contract\]/);
  assert.match(claudePrompt, /delegated by Claude Code/);
  assert.doesNotMatch(claudePrompt, /delegated by Codex/);
  assert.match(neutralPrompt, /delegated by the supervising host agent/);
  assert.match(codexPrompt, /specific fact or coordination decision/);
  assert.match(codexPrompt, /Inspect the failing build/);
  assert.equal(agentMessageText({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "result" },
  }), "result");
  assert.equal(agentMessageText({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "hidden" },
  }), "");
  assert.deepEqual(parseSupervisorQuestion(
    '<supervisor_question>{"question":"Which target is authoritative?","evidenceGap":"Both configs claim ownership","attempted":["read both files"]}</supervisor_question>',
  ), {
    question: "Which target is authoritative?",
    evidenceGap: "Both configs claim ownership",
    attempted: ["read both files"],
  });
});

test("progress phases use ACP tool metadata without exposing raw tool output", () => {
  assert.equal(progressPhaseForToolCall({ kind: "read", title: "Read target" }), "locating");
  assert.equal(progressPhaseForToolCall({ kind: "edit", title: "Patch target" }), "modifying");
  assert.equal(progressPhaseForToolCall({ kind: "execute", title: "Run targeted tests" }), "verifying");
  assert.equal(progressPhaseForToolCall({ kind: "execute", title: "Build the release bundle" }), "executing");
  assert.equal(progressPhaseForToolCall({ kind: "execute", title: "Generate fixture" }), "executing");
  assert.equal(progressPhaseForToolCall({ kind: "think", title: "Choose next step" }), "planning");
});

test("updates are paged, bounded, and do not duplicate run or permission state", () => {
  const supervisor = createSupervisor();
  for (let index = 0; index < 30; index += 1) {
    supervisor.record("session_update", { text: `event-${index}` });
  }
  const first = supervisor.updates();
  assert.equal(first.events.length, 20);
  assert.equal(first.hasMore, true);
  assert.equal("activeRun" in first, false);
  assert.equal("pendingPermissions" in first, false);
  const second = supervisor.updates({ afterSequence: first.nextAfterSequence });
  assert.equal(second.events.length, 10);
  assert.equal(second.hasMore, false);
});

test("durable supervision marks interrupted runs and permissions unknown after restart", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new GrokSupervisor({ stateRoot: root, maxSegmentEvents: 2 });
  first.record("prompt_started", { runId: "run-before-restart", sessionId: SESSION_ID });
  first.record("permission_requested", {
    permissionId: "01900000-0000-7000-8000-000000000001",
    sessionId: SESSION_ID,
    toolTitle: "Run command",
    requestedAt: "2026-08-19T00:00:00Z",
  });
  const recovered = new GrokSupervisor({ stateRoot: root, maxSegmentEvents: 2 });
  assert.equal(recovered.recovery.interruptedRun.status, "unknown_after_restart");
  assert.equal(recovered.recovery.interruptedRun.runId, "run-before-restart");
  assert.equal(recovered.recovery.orphanedPermissions.length, 1);
  assert.equal(recovered.permissionSummaries().length, 0);
  recovered.acpContext = { notify: async () => {} };
  recovered.acpConnection = { signal: { aborted: false } };
  recovered.attachedSessionId = SESSION_ID;
  assert.throws(() => recovered.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Do not overlap the unknown run",
    confirmation: "SEND_TO_GROK",
  }), /unknown state after Supervisor restart/);
  return recovered.cancelPrompt({ sessionId: SESSION_ID, confirmation: "CANCEL_GROK_PROMPT" }).then(() => {
    assert.equal(recovered.recovery.interruptedRun, null);
    assert.equal(recovered.recovery.orphanedPermissions.length, 0);
  });
});

test("journal write failure degrades to bounded memory and remains observable", () => {
  const failingJournal = {
    recentEvents: [],
    nextSequence: 1,
    append: () => { throw new Error("disk unavailable"); },
    info: () => ({ durable: true }),
  };
  const supervisor = createSupervisor({ eventJournal: failingJournal });
  const event = supervisor.record("session_update", { text: "work" });
  assert.equal(event.kind, "journal_write_failed");
  assert.match(supervisor.journalError, /disk unavailable/);
  assert.equal(supervisor.journal.info().durable, false);
});

test("leader ownership requires the exact live lock PID and dedicated socket", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const supervisor = createSupervisor({
    stateRoot: root,
    socketPath: join(root, "leader.sock"),
    inspectProcessIdentity: (pid) => pid === process.pid
      ? { fingerprint: "test-current-process", executablePath: process.execPath }
      : null,
  });
  writeFileSync(supervisor.leaderLockPath(), String(process.pid));
  const record = supervisor.writeLeaderOwnership({ leaderPid: process.pid, cwd: root });
  assert.equal(validateSessionId(record.ownerToken), record.ownerToken);
  assert.equal(supervisor.readLeaderOwnership().valid, true);
  const readLeaderLockPid = supervisor.readLeaderLockPid.bind(supervisor);
  supervisor.readLeaderLockPid = () => null;
  assert.equal(supervisor.readLeaderOwnership().reason, "verified_process_fingerprint");
  supervisor.readLeaderLockPid = readLeaderLockPid;
  writeFileSync(supervisor.leaderLockPath(), "999999");
  assert.equal(supervisor.readLeaderOwnership().valid, false);
});

test("default Leader startup rotates away from an unowned stale socket", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-socket-rotation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const supervisor = createSupervisor({ stateRoot: root });
  const previousSocketPath = supervisor.socketPath;
  writeFileSync(supervisor.leaderLockPath(), "999999");

  const prepared = supervisor.prepareLeaderSocketForStart();

  assert.equal(prepared.rotated, true);
  assert.notEqual(supervisor.socketPath, previousSocketPath);
  assert.match(supervisor.socketPath, /leader-[0-9a-f-]+\.sock$/i);
  assert.equal(supervisor.events.at(-1).kind, "leader_socket_rotated");
});

test("default Supervisor recovers the socket recorded by a live owned Leader", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-socket-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "leader-recorded.sock");
  writeFileSync(join(root, "leader-owner.json"), JSON.stringify({
    schemaVersion: 1,
    ownerToken: OWNER_TOKEN,
    leaderPid: process.pid,
    socketPath,
  }));

  const supervisor = createSupervisor({ stateRoot: root });

  assert.equal(supervisor.socketPath, socketPath);
});

test("socket rotation refuses to overwrite an invalid live ownership record", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-live-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "leader-recorded.sock");
  writeFileSync(join(root, "leader-owner.json"), JSON.stringify({
    schemaVersion: 1,
    ownerToken: "invalid",
    leaderPid: process.pid,
    socketPath,
  }));
  const supervisor = createSupervisor({ stateRoot: root });

  assert.throws(() => supervisor.prepareLeaderSocketForStart(), /refusing to replace or bypass it/);
  assert.equal(supervisor.socketPath, socketPath);
});

test("startLeader injects the fresh terminal proxy environment", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-proxy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const grokBinary = join(root, "grok.exe");
  writeFileSync(grokBinary, "test");
  const fakeProcess = new EventEmitter();
  fakeProcess.pid = 4242;
  fakeProcess.exitCode = null;
  fakeProcess.kill = () => {};
  let spawnOptions = null;
  let spawnArgs = null;
  const proxyContext = {
    policy: "required",
    environment: {
      HTTP_PROXY: "http://127.0.0.1:43123",
      HTTPS_PROXY: "http://127.0.0.1:43123",
      http_proxy: "http://127.0.0.1:43123",
      https_proxy: "http://127.0.0.1:43123",
      NO_PROXY: "localhost,127.0.0.1,::1",
    },
    httpProxy: { host: "127.0.0.1", port: 43123 },
    httpsProxy: { host: "127.0.0.1", port: 43123 },
    summary: {
      configured: true,
      policy: "required",
      source: "windows_user_environment",
      endpoint: { protocol: "http", host: "127.0.0.1", port: 43123 },
      fingerprint: "proxy-fingerprint",
    },
  };
  const supervisor = createSupervisor({
    grokBinary,
    stateRoot: join(root, "state"),
    socketPath: join(root, "state", "leader.sock"),
    resolveProxyContext: () => proxyContext,
    probeProxyEndpoint: async () => ({ reachable: true }),
    spawnProcess: (_command, args, options) => {
      spawnArgs = args;
      spawnOptions = options;
      return fakeProcess;
    },
  });
  let infoCalls = 0;
  supervisor.leaderInfo = async () => ({
    running: infoCalls++ > 0,
    pid: 7331,
    source: "grok_leader_info_json",
  });
  supervisor.writeLeaderOwnership = ({ proxy }) => {
    assert.equal(proxy.fingerprint, "proxy-fingerprint");
    return { ownerToken: OWNER_TOKEN };
  };

  const started = await supervisor.startLeader({ cwd: root });
  assert.equal(started.started, true);
  assert.equal(started.pid, 7331);
  assert.equal(started.launcherPid, 4242);
  assert.deepEqual(spawnArgs.slice(0, 2), ["agent", "leader"]);
  assert.equal(spawnOptions.env.HTTPS_PROXY, "http://127.0.0.1:43123");
  assert.equal(spawnOptions.env.https_proxy, "http://127.0.0.1:43123");
  assert.equal(started.proxy.fingerprint, "proxy-fingerprint");
});

test("startLeader preserves real detached Leader ownership when the launcher exits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-detached-leader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const grokBinary = join(root, "grok.exe");
  writeFileSync(grokBinary, "test");
  const fakeProcess = new EventEmitter();
  fakeProcess.pid = 4242;
  fakeProcess.exitCode = null;
  fakeProcess.kill = () => {};
  const supervisor = createSupervisor({
    grokBinary,
    stateRoot: join(root, "state"),
    socketPath: join(root, "state", "leader.sock"),
    resolveProxyContext: () => ({
      policy: "required",
      environment: {},
      summary: { configured: true, policy: "required", source: "test", endpoint: null, fingerprint: "proxy" },
    }),
    probeProxyEndpoint: async () => ({ reachable: true }),
    spawnProcess: () => fakeProcess,
  });
  let infoCalls = 0;
  supervisor.leaderInfo = async () => ({
    running: infoCalls++ > 0,
    pid: process.pid,
    source: "grok_leader_info_json",
  });
  supervisor.writeLeaderOwnership = ({ leaderPid }) => {
    writeFileSync(supervisor.leaderOwnershipPath, JSON.stringify({ leaderPid }));
    return { ownerToken: OWNER_TOKEN };
  };

  const started = await supervisor.startLeader({ cwd: root });
  assert.equal(started.pid, process.pid);
  fakeProcess.emit("exit", 0, null);
  assert.equal(supervisor.leaderProcess, null);
  assert.equal(supervisor.leaderProxyContext.summary.fingerprint, "proxy");
  assert.equal(supervisor.events.at(-1).kind, "leader_launcher_exit");
  assert.equal(JSON.parse(readFileSync(supervisor.leaderOwnershipPath, "utf8")).leaderPid, process.pid);
});

test("startLeader refuses to recover a Leader without a matching proxy record", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-proxy-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const grokBinary = join(root, "grok.exe");
  writeFileSync(grokBinary, "test");
  const proxyContext = {
    policy: "required",
    environment: { HTTPS_PROXY: "http://127.0.0.1:43123" },
    httpsProxy: { host: "127.0.0.1", port: 43123 },
    summary: {
      configured: true,
      policy: "required",
      source: "windows_user_environment",
      endpoint: { protocol: "http", host: "127.0.0.1", port: 43123 },
      fingerprint: "current-proxy",
    },
  };
  const supervisor = createSupervisor({
    grokBinary,
    stateRoot: join(root, "state"),
    resolveProxyContext: () => proxyContext,
    probeProxyEndpoint: async () => ({ reachable: true }),
    spawnProcess: () => { throw new Error("must not spawn over an existing Leader"); },
  });
  supervisor.leaderInfo = async () => ({ running: true });
  supervisor.readLeaderOwnership = () => ({
    valid: true,
    record: { ownerToken: OWNER_TOKEN, proxy: null },
  });

  const recovered = await supervisor.startLeader({ cwd: root });
  assert.equal(recovered.started, false);
  assert.equal(recovered.managed, false);
  assert.equal(recovered.reason, "leader_proxy_unverified");
});

test("inspect returns bounded natural-language session candidates for one cwd", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const sessionRoot = join(root, "sessions");
  const projectCatalog = join(sessionRoot, encodeURIComponent(cwd));
  const sessionDirectory = join(projectCatalog, SESSION_ID);
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, "summary.json"), JSON.stringify({
    info: { cwd },
    generated_title: "Creature animation handoff",
    updated_at: "2026-08-19T00:00:00Z",
    last_turn_summary: "Battle scene still needs verification",
    num_chat_messages: 12,
  }));
  const supervisor = createSupervisor({ sessionRoot });
  supervisor.status = async () => ({ ok: true });
  const inspected = await supervisor.inspect({ view: "summary", cwd, sessionId: SESSION_ID, sessionQuery: "animation", sessionLimit: 3 });
  assert.equal(inspected.view, "summary");
  assert.equal(inspected.sessionCandidates.length, 1);
  assert.equal(inspected.sessionCandidates[0].sessionId, SESSION_ID);
  assert.equal(inspected.sessionCandidates[0].authority, "AGENT_SUMMARY_CLAIM");
  assert.equal(inspected.agentSummary.authority, "AGENT_SUMMARY_CLAIM");
  assert.match(inspected.agentSummary.summaryPath, /summary\.json$/);
  assert.equal(inspected.summary.eventCount, 0);
  assert.equal("stream" in inspected, false);
});

test("launchTui accepts a visible Windows Terminal ancestor after the launcher hands off", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-tui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const stateRoot = join(root, "state");
  const fakeProcess = new EventEmitter();
  fakeProcess.pid = 5150;
  fakeProcess.exitCode = 0;
  fakeProcess.unref = () => {};
  let spawnOptions = null;
  const grokBinary = join(root, "grok.exe");
  const supervisor = createSupervisor({
    grokBinary,
    stateRoot,
    socketPath: join(stateRoot, "leader.sock"),
    sessionRoot: join(root, "sessions"),
    nodeBinary: process.execPath,
    resolveTerminalPresentation: () => ({
      wtBinary: join(root, "wt.exe"),
      profile: "core-profile",
      profileName: "PowerShell",
      powerShellBinary: join(root, "pwsh.exe"),
    }),
    spawnProcess: (_command, args, options) => {
      spawnOptions = options;
      const value = (flag) => args[args.indexOf(flag) + 1];
      writeFileSync(value("-StatePath"), JSON.stringify({
        schemaVersion: 1,
        launchId: value("-LaunchId"),
        leaderOwnerToken: OWNER_TOKEN,
        status: "running",
        sessionId: SESSION_ID,
        cwd,
        hostPid: 31337,
        grokPid: 424242,
        hostProcessFingerprint: "host-fingerprint",
        grokProcessFingerprint: "grok-fingerprint",
      }));
      return fakeProcess;
    },
    inspectTerminalPresentation: ({ hostPid, launcherPid }) => ({
      processName: "WindowsTerminal",
      processId: 7000,
      mainWindowHandle: 1234,
      mainWindowTitle: "Grok Build test",
      visible: hostPid === 31337 && launcherPid === fakeProcess.pid,
      evidence: "visible_windows_terminal_ancestor",
    }),
    inspectProcessIdentity: (pid) => ({
      fingerprint: pid === 424242 ? "grok-fingerprint" : "host-fingerprint",
      executablePath: pid === 424242 ? grokBinary : process.execPath,
    }),
  });
  supervisor.leaderInfo = async () => ({ running: true });
  supervisor.readLeaderOwnership = () => ({ valid: true, record: { ownerToken: OWNER_TOKEN } });
  supervisor.acpProcess = { pid: 31338 };
  supervisor.attachedSessionId = SESSION_ID;
  supervisor.attachedCwd = cwd;
  supervisor.readActiveSessions = () => [{ session_id: SESSION_ID, pid: 31338, cwd }];
  const launched = await supervisor.launchTui({
    sessionId: SESSION_ID,
    cwd,
    mode: "resume",
    confirmation: "LAUNCH_VISIBLE_TUI",
  });
  assert.equal(launched.pid, 424242);
  assert.equal(launched.hostPid, 31337);
  assert.equal(launched.terminalProfile, "PowerShell");
  assert.equal(launched.terminalPid, 5150);
  assert.equal(launched.terminalWindowPid, 7000);
  assert.equal(launched.presentationEvidence, "visible_windows_terminal_ancestor");
  assert.equal(launched.visible, true);
  assert.equal(spawnOptions.windowsHide, false);
  assert.equal(supervisor.tuiProcesses.has(424242), true);
});

test("launchTui rejects a background terminal process without a visible window", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-hidden-tui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const stateRoot = join(root, "state");
  const fakeProcess = new EventEmitter();
  fakeProcess.pid = 6160;
  fakeProcess.exitCode = 0;
  fakeProcess.unref = () => {};
  const grokBinary = join(root, "grok.exe");
  const supervisor = createSupervisor({
    grokBinary,
    stateRoot,
    socketPath: join(stateRoot, "leader.sock"),
    sessionRoot: join(root, "sessions"),
    nodeBinary: process.execPath,
    tuiLaunchTimeoutMs: 25,
    tuiPollIntervalMs: 5,
    resolveTerminalPresentation: () => ({
      wtBinary: join(root, "wt.exe"),
      profile: "core-profile",
      profileName: "PowerShell",
      powerShellBinary: join(root, "pwsh.exe"),
    }),
    spawnProcess: (_command, args) => {
      const value = (flag) => args[args.indexOf(flag) + 1];
      writeFileSync(value("-StatePath"), JSON.stringify({
        schemaVersion: 1,
        launchId: value("-LaunchId"),
        leaderOwnerToken: OWNER_TOKEN,
        status: "running",
        sessionId: SESSION_ID,
        cwd,
        hostPid: 31337,
        grokPid: 424242,
        hostProcessFingerprint: "host-fingerprint",
        grokProcessFingerprint: "grok-fingerprint",
      }));
      return fakeProcess;
    },
    inspectTerminalPresentation: () => ({
      processName: "WindowsTerminal",
      processId: null,
      mainWindowHandle: 0,
      mainWindowTitle: "",
      visible: false,
      evidence: "no_visible_windows_terminal_ancestor",
    }),
    inspectProcessIdentity: (pid) => ({
      fingerprint: pid === 424242 ? "grok-fingerprint" : "host-fingerprint",
      executablePath: pid === 424242 ? grokBinary : process.execPath,
    }),
  });
  supervisor.leaderInfo = async () => ({ running: true });
  supervisor.readLeaderOwnership = () => ({ valid: true, record: { ownerToken: OWNER_TOKEN } });
  supervisor.readActiveSessions = () => [];

  await assert.rejects(() => supervisor.launchTui({
    sessionId: SESSION_ID,
    cwd,
    mode: "resume",
    confirmation: "LAUNCH_VISIBLE_TUI",
  }), (error) => {
    assert.match(error.message, /did not present a visible window/);
    assert.equal(error.ownedTuiPid, 424242);
    return true;
  });
  assert.equal(supervisor.events.some((event) => event.kind === "terminal_launcher_handoff"), true);
});

test("openSession rolls back the Leader when ACP attach fails before TUI launch", async () => {
  const supervisor = createSupervisor();
  const actions = [];
  supervisor.readActiveSessions = () => [];
  supervisor.startLeader = async () => ({ started: true, pid: 10 });
  supervisor.launchTui = async () => { throw new Error("must not launch before ACP attach"); };
  supervisor.attachSession = async () => { throw new Error("attach failed"); };
  supervisor.disconnect = async () => { actions.push("disconnect"); return { disconnected: true }; };
  supervisor.leaderProcess = { pid: 10 };
  supervisor.stopOwnedLeader = async () => { actions.push("leader"); return { stopped: true }; };

  await assert.rejects(() => supervisor.openSession({
    mode: "resume",
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    presentation: "windows_terminal",
    confirmation: "OPEN_GROK_SESSION",
  }), /attach failed/);
  assert.deepEqual(actions, ["disconnect", "leader"]);
});

test("openSession rolls back a TUI observed before launch visibility fails", async () => {
  const supervisor = createSupervisor();
  const actions = [];
  supervisor.readActiveSessions = () => [];
  supervisor.startLeader = async () => ({ started: true, pid: 10 });
  supervisor.leaderProcess = { pid: 10 };
  supervisor.attachSession = async () => ({ attached: true, sessionId: SESSION_ID, pid: 30 });
  supervisor.launchTui = async () => {
    const error = new Error("visibility verification failed");
    error.ownedTuiPid = 20;
    throw error;
  };
  supervisor.disconnect = async () => { actions.push("disconnect"); return { disconnected: true }; };
  supervisor.stopOwnedTuiForRollback = async (pid) => {
    assert.equal(pid, 20);
    actions.push("tui");
    return { stopped: true };
  };
  supervisor.stopOwnedLeader = async () => { actions.push("leader"); return { stopped: true }; };

  let failure = null;
  try {
    await supervisor.openSession({
      mode: "resume",
      sessionId: SESSION_ID,
      cwd: process.cwd(),
      presentation: "windows_terminal",
      confirmation: "OPEN_GROK_SESSION",
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, "GROK_SESSION_OPEN_FAILED");
  assert.equal(failure.details.rollbackComplete, true);
  assert.equal(failure.details.verificationRequired, true);
  assert.deepEqual(failure.details.rollback, ["acp_disconnected", "owned_tui_stopped", "owned_leader_stopped"]);
  const failureEvent = supervisor.events.find((event) => event.kind === "session_open_failed");
  assert.equal(failureEvent.rollbackComplete, true);
  assert.equal(failureEvent.verificationRequired, true);
  assert.deepEqual(actions, ["disconnect", "tui", "leader"]);
});

test("openSession reports an incomplete rollback instead of hiding cleanup failures", async () => {
  const supervisor = createSupervisor();
  supervisor.readActiveSessions = () => [];
  supervisor.startLeader = async () => ({ started: true, pid: 10 });
  supervisor.leaderProcess = { pid: 10 };
  supervisor.attachSession = async () => ({ attached: true, sessionId: SESSION_ID, pid: 30 });
  supervisor.launchTui = async () => {
    const error = new Error("visibility verification failed");
    error.ownedTuiPid = 20;
    throw error;
  };
  supervisor.disconnect = async () => { throw new Error("disconnect stuck"); };
  supervisor.stopOwnedTuiForRollback = async () => { throw new Error("TUI still alive"); };
  supervisor.stopOwnedLeader = async () => ({ stopped: true });

  await assert.rejects(() => supervisor.openSession({
    mode: "resume",
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    presentation: "windows_terminal",
    confirmation: "OPEN_GROK_SESSION",
  }), (error) => {
    assert.equal(error.details.rollbackComplete, false);
    assert.equal(error.details.verificationRequired, true);
    assert.equal(error.details.rollback.some((step) => step.startsWith("acp_disconnect_failed:")), true);
    assert.equal(error.details.rollback.some((step) => step.startsWith("owned_tui_stop_failed:")), true);
    return true;
  });
});

test("openSession keeps the owned ACP attached while launching a visible new session", async () => {
  const supervisor = createSupervisor();
  supervisor.readActiveSessions = () => [];
  supervisor.startLeader = async () => ({ started: false, managed: true, reason: "managed_leader_recovered" });
  supervisor.launchTui = async ({ sessionId, mode }) => {
    assert.equal(mode, "resume");
    assert.equal(sessionId, SESSION_ID);
    return { launched: true, pid: 22, sessionId };
  };
  supervisor.waitForTuiSession = async ({ sessionId }) => {
    assert.equal(sessionId, SESSION_ID);
    return { observed: true, pid: 22 };
  };
  const attachModes = [];
  supervisor.attachSession = async ({ mode, sessionId }) => {
    attachModes.push(mode);
    if (mode === "new") {
      assert.equal(sessionId, undefined);
      return { attached: true, sessionId: SESSION_ID, created: true };
    }
    throw new Error(`unexpected second attachment for ${sessionId}`);
  };

  const opened = await supervisor.openSession({
    mode: "new",
    cwd: process.cwd(),
    presentation: "windows_terminal",
    confirmation: "OPEN_GROK_SESSION",
  });
  assert.equal(opened.mode, "new");
  assert.equal(opened.sessionId, SESSION_ID);
  assert.deepEqual(attachModes, ["new"]);
  assert.equal(opened.bootstrapAttachment.created, true);
});

test("openSession creates a headless session through ACP session/new", async () => {
  const supervisor = createSupervisor();
  supervisor.startLeader = async () => ({ started: false, managed: true, reason: "managed_leader_recovered" });
  supervisor.attachSession = async ({ mode, sessionId }) => {
    assert.equal(mode, "new");
    assert.equal(sessionId, undefined);
    return { attached: true, created: true, sessionId: SESSION_ID };
  };
  const opened = await supervisor.openSession({
    mode: "new",
    cwd: process.cwd(),
    presentation: "none",
    confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  assert.equal(opened.sessionId, SESSION_ID);
  assert.equal(opened.tui, null);
});

test("openSession requires a distinct explicit confirmation for headless presentation", async () => {
  const supervisor = createSupervisor();
  await assert.rejects(() => supervisor.openSession({
    mode: "new",
    cwd: process.cwd(),
    presentation: "none",
    confirmation: "OPEN_GROK_SESSION",
  }), /OPEN_GROK_SESSION_HEADLESS/);
});

test("openSession refuses an existing Leader without verified plugin ownership", async () => {
  const supervisor = createSupervisor();
  supervisor.startLeader = async () => ({ started: false, managed: false, reason: "leader_already_running" });
  supervisor.attachSession = async () => { throw new Error("must not attach"); };
  await assert.rejects(() => supervisor.openSession({
    mode: "new",
    cwd: process.cwd(),
    presentation: "none",
    confirmation: "OPEN_GROK_SESSION_HEADLESS",
  }), /not backed by a verified plugin ownership record/);
});

test("openSession safely recovers an exact active plugin-recorded TUI without claiming ownership", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-recover-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const stateRoot = join(root, "state");
  const tuiStateRoot = join(stateRoot, "tuis");
  mkdirSync(cwd);
  mkdirSync(tuiStateRoot, { recursive: true });
  writeFileSync(join(tuiStateRoot, "launch.json"), JSON.stringify({
    schemaVersion: 1,
    launchId: "launch-1",
    leaderOwnerToken: OWNER_TOKEN,
    status: "running",
    sessionId: SESSION_ID,
    cwd,
    hostPid: process.pid,
    grokPid: process.pid,
  }));
  const supervisor = createSupervisor({
    stateRoot,
    tuiStateRoot,
    grokBinary: process.execPath,
    inspectProcessIdentity: () => ({ fingerprint: "current-process", executablePath: process.execPath }),
  });
  supervisor.readActiveSessions = () => [{ session_id: SESSION_ID, pid: process.pid, cwd }];
  supervisor.leaderInfo = async () => ({ running: true });
  supervisor.readLeaderOwnership = () => ({ valid: true, record: { ownerToken: OWNER_TOKEN } });
  supervisor.startLeader = async () => ({ started: false, managed: true, reason: "managed_leader_recovered" });
  supervisor.launchTui = async () => { throw new Error("must not launch a second TUI"); };
  supervisor.attachSession = async ({ mode, sessionId }) => ({ attached: true, mode, sessionId });

  const opened = await supervisor.openSession({
    mode: "resume",
    sessionId: SESSION_ID,
    cwd,
    presentation: "windows_terminal",
    confirmation: "OPEN_GROK_SESSION",
  });
  assert.equal(opened.recovered, true);
  assert.equal(opened.tui.pid, process.pid);
  assert.equal(opened.tui.ownedByCurrentMcp, false);
  assert.deepEqual(supervisor.tuiProcesses.size, 0);
});

test("openSession still refuses an active plain TUI without a matching plugin launch record", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-plain-active-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const supervisor = createSupervisor({ stateRoot: join(root, "state") });
  supervisor.readActiveSessions = () => [{ session_id: SESSION_ID, pid: process.pid, cwd }];
  supervisor.leaderInfo = async () => ({ running: true });
  await assert.rejects(() => supervisor.openSession({
    mode: "resume",
    sessionId: SESSION_ID,
    cwd,
    presentation: "windows_terminal",
    confirmation: "OPEN_GROK_SESSION",
  }), /refusing a concurrent open/);
});

test("inspect keeps summary and exact evidence as explicit diagnostic views", async () => {
  const supervisor = createSupervisor();
  supervisor.status = async () => ({ attachedSessionId: null, attachedCwd: null, pendingPermissions: [] });
  supervisor.record("session_update", { update: { message: "working" } });
  supervisor.record("prompt_failed", { runId: "run-1", sessionId: SESSION_ID, message: "test failure" });
  const summary = await supervisor.inspect({ view: "summary", afterSequence: 0 });
  assert.equal(summary.view, "summary");
  assert.equal(summary.summary.authority, "SUPERVISOR_DERIVED");
  assert.equal(summary.summary.critical.length, 1);
  assert.equal("stream" in summary, false);
  const evidence = await supervisor.inspect({ view: "evidence", sequences: [1] });
  assert.deepEqual(evidence.evidence.map((event) => event.sequence), [1]);
});

test("interaction view waits for prompt completion and returns only the final response", async () => {
  const supervisor = createSupervisor();
  let resolvePrompt;
  supervisor.acpConnection = { signal: { aborted: false } };
  supervisor.acpContext = {
    request: () => new Promise((resolve) => { resolvePrompt = resolve; }),
  };
  supervisor.attachedSessionId = SESSION_ID;
  supervisor.attachedCwd = process.cwd();
  const started = supervisor.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Finish the bounded task.",
    confirmation: "SEND_TO_GROK",
  });
  const waiting = supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: started.nextAfterSequence,
    waitMs: 1_000,
  });
  supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Task complete." },
    },
  });
  resolvePrompt({ stopReason: "end_turn" });
  const interaction = await waiting;
  assert.equal(interaction.view, "interaction");
  assert.equal(interaction.state, "completed");
  assert.equal(interaction.run.finalText, "Task complete.");
  assert.equal("latestMessage" in interaction.run, false);
  assert.equal(interaction.run.stopReason, "end_turn");
  assert.equal(interaction.delivery.finalTextIncluded, true);
  assert.equal(interaction.cursor.nextAfterSequence, interaction.cursor.latestSequence);
  assert.equal(interaction.timedOut, false);
  assert.equal("status" in interaction, false);

  const repeated = await supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: interaction.cursor.nextAfterSequence,
  });
  assert.equal(repeated.state, "completed");
  assert.equal(repeated.run.finalText, null);
  assert.equal(repeated.delivery.finalTextAvailable, true);
  assert.equal(repeated.delivery.finalTextIncluded, false);
  assert.doesNotMatch(JSON.stringify(repeated), /Task complete\./);
});

test("long completed response is cursor-delivered as one persistent result artifact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-result-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const supervisor = createSupervisor({
    stateRoot: join(root, "state"),
    resultArtifactRoot: join(root, "results"),
  });
  let resolvePrompt;
  supervisor.acpConnection = { signal: { aborted: false } };
  supervisor.acpContext = {
    request: () => new Promise((resolve) => { resolvePrompt = resolve; }),
  };
  supervisor.attachedSessionId = SESSION_ID;
  supervisor.attachedCwd = process.cwd();
  const started = supervisor.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Return a long report.",
    confirmation: "SEND_TO_GROK",
  });
  const finalText = `# LONG_RESULT_UNIQUE\n\n${"evidence line\n".repeat(900)}`;
  supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: finalText },
    },
  });
  resolvePrompt({ stopReason: "end_turn" });
  await supervisor.activeRun.promise;

  const interaction = await supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: started.nextAfterSequence,
  });
  const artifact = interaction.run.resultArtifact;
  assert.equal(interaction.state, "completed");
  assert.equal(interaction.run.finalText, null);
  assert.equal(interaction.delivery.finalTextAvailable, false);
  assert.equal(interaction.delivery.resultArtifactAvailable, true);
  assert.equal(interaction.delivery.resultArtifactIncluded, true);
  assert.equal(readFileSync(artifact.path, "utf8"), finalText);
  assert.equal(artifact.bytes, Buffer.byteLength(finalText));
  assert.equal(artifact.sha256, createHash("sha256").update(finalText).digest("hex"));
  assert.ok(Buffer.byteLength(JSON.stringify(interaction)) < 4_000);

  const repeated = await supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: interaction.cursor.nextAfterSequence,
  });
  assert.equal(repeated.run.resultArtifact, null);
  assert.equal(repeated.run.resultSummary, null);
  assert.equal(repeated.delivery.resultArtifactAvailable, true);
  assert.equal(repeated.delivery.resultArtifactIncluded, false);
  assert.doesNotMatch(JSON.stringify(repeated), /LONG_RESULT_UNIQUE/);
});

test("artifact persistence failure suppresses the long body and returns only a bounded fallback", async () => {
  const supervisor = createSupervisor({
    persistResultArtifact: () => { throw new Error("result disk unavailable"); },
  });
  let resolvePrompt;
  supervisor.acpConnection = { signal: { aborted: false } };
  supervisor.acpContext = {
    request: () => new Promise((resolve) => { resolvePrompt = resolve; }),
  };
  supervisor.attachedSessionId = SESSION_ID;
  const started = supervisor.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Return a long result while persistence fails.",
    confirmation: "SEND_TO_GROK",
  });
  const finalText = `ARTIFACT_FAILURE_UNIQUE:${"z".repeat(8_000)}`;
  supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: finalText } },
  });
  resolvePrompt({ stopReason: "end_turn" });
  await supervisor.activeRun.promise;
  const interaction = await supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: started.nextAfterSequence,
  });
  assert.equal(interaction.run.finalText, null);
  assert.equal(interaction.run.resultArtifact, null);
  assert.match(interaction.run.artifactError, /result disk unavailable/);
  assert.ok(interaction.run.resultSummary.length <= 801);
  assert.ok(Buffer.byteLength(JSON.stringify(interaction)) < 4_000);
  assert.equal(supervisor.events.some((event) => event.kind === "result_artifact_failed"), true);
  assert.doesNotMatch(JSON.stringify(interaction), /z{1000}/);
});

test("interaction view coalesces a long active stream without returning cumulative text", async () => {
  const supervisor = createSupervisor();
  supervisor.acpConnection = { signal: { aborted: false } };
  supervisor.acpContext = { request: () => new Promise(() => {}) };
  supervisor.attachedSessionId = SESSION_ID;
  const started = supervisor.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Keep working.",
    confirmation: "SEND_TO_GROK",
  });
  const streamedText = `UNIQUE_STREAM_PAYLOAD:${"x".repeat(6_000)}`;
  supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "progress-1",
      content: { type: "text", text: streamedText },
    },
  });
  supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "Read the bounded target",
      kind: "read",
      status: "completed",
      locations: [{ path: join(process.cwd(), "target.mjs") }],
      rawOutput: `RAW_TOOL_OUTPUT:${"y".repeat(4_000)}`,
    },
  });
  const interaction = await supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: started.nextAfterSequence,
    waitMs: 5,
  });
  assert.equal(interaction.state, "working");
  assert.equal(interaction.timedOut, true);
  assert.equal(interaction.progress.status, "streaming");
  assert.equal(interaction.progress.phase, "locating");
  assert.match(interaction.progress.message, /^Locating: 1 file inspected/);
  assert.equal(interaction.progress.filesRead, 1);
  assert.equal(interaction.progress.filesChanged, 0);
  assert.deepEqual(interaction.progress.toolCalls, { total: 1, completed: 1, failed: 0 });
  assert.equal(interaction.progress.newActivity, true);
  assert.equal(interaction.progress.contentSuppressed, true);
  assert.equal(interaction.progress.coalesced, true);
  assert.equal(interaction.progress.eventsCollapsed, false);
  assert.equal(interaction.run.finalText, null);
  assert.equal("latestMessage" in interaction.run, false);
  assert.equal(interaction.cursor.nextAfterSequence, interaction.cursor.latestSequence);
  assert.equal(interaction.cursor.hasMore, false);
  assert.doesNotMatch(JSON.stringify(interaction), /UNIQUE_STREAM_PAYLOAD/);
  assert.ok(Buffer.byteLength(JSON.stringify(interaction)) < 2_000);
  const progressEvents = supervisor.events.filter((event) => event.kind === "run_progress");
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents.at(-1).phase, "locating");
  assert.doesNotMatch(JSON.stringify(progressEvents), /UNIQUE_STREAM_PAYLOAD|RAW_TOOL_OUTPUT/);
  assert.equal(supervisor.events.some((event) => event.kind === "session_update"), false);

  supervisor.leaderInfo = async () => ({ running: false });
  supervisor.readLeaderOwnership = () => ({ valid: false, reason: "test", record: null });
  supervisor.readActiveSessions = () => [];
  supervisor.tuiStateRoot = join(tmpdir(), `grok-no-tui-${started.runId}`);
  const status = await supervisor.status();
  assert.equal(status.activeRun.responseChars, streamedText.length);
  assert.equal("finalText" in status.activeRun, false);
  assert.equal("latestMessage" in status.activeRun, false);
  assert.doesNotMatch(JSON.stringify(status.activeRun), /UNIQUE_STREAM_PAYLOAD/);

  const repeated = await supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: interaction.cursor.nextAfterSequence,
  });
  assert.equal(repeated.progress.newActivity, false);
  assert.doesNotMatch(JSON.stringify(repeated), /UNIQUE_STREAM_PAYLOAD/);
});

test("running interactions receive a compact heartbeat at the configured cadence", async () => {
  const supervisor = createSupervisor({ progressHeartbeatIntervalMs: 10 });
  let resolvePrompt;
  supervisor.acpConnection = { signal: { aborted: false } };
  supervisor.acpContext = { request: () => new Promise((resolve) => { resolvePrompt = resolve; }) };
  supervisor.attachedSessionId = SESSION_ID;
  const started = supervisor.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Keep the bounded task alive.",
    confirmation: "SEND_TO_GROK",
  });
  const interaction = await supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: started.nextAfterSequence,
    waitMs: 35,
  });
  assert.equal(interaction.state, "working");
  assert.equal(interaction.timedOut, true);
  assert.equal(interaction.progress.newActivity, false);
  assert.equal(interaction.progress.phase, "starting");
  assert.equal(interaction.progress.responseChars, 0);
  assert.ok(interaction.progress.heartbeatAt);
  assert.equal(supervisor.events.some((event) => event.kind === "run_progress" && event.heartbeat === true), false);

  supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "progress-text",
      content: { type: "text", text: "Still working." },
    },
  });
  const active = await supervisor.inspect({
    sessionId: SESSION_ID,
    runId: started.runId,
    afterSequence: interaction.cursor.nextAfterSequence,
    waitMs: 25,
  });
  assert.equal(active.progress.newActivity, true);
  assert.equal(active.progress.responseChars, "Still working.".length);
  assert.ok(supervisor.events.some((event) => event.kind === "run_progress" && event.heartbeat === true));

  resolvePrompt({ stopReason: "end_turn" });
  await supervisor.activeRun.promise;
  assert.equal(supervisor.activeRun.progressTimer, null);
  const progressEventCount = supervisor.events.filter((event) => event.kind === "run_progress").length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(supervisor.events.filter((event) => event.kind === "run_progress").length, progressEventCount);
});

test("failed and cancelled prompts stop their progress timers", async () => {
  const failed = createSupervisor({ progressHeartbeatIntervalMs: 5 });
  failed.acpConnection = { signal: { aborted: false } };
  failed.acpContext = { request: () => Promise.reject(new Error("synthetic failure")) };
  failed.attachedSessionId = SESSION_ID;
  failed.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Fail safely.",
    confirmation: "SEND_TO_GROK",
  });
  await failed.activeRun.promise;
  assert.equal(failed.activeRun.status, "failed");
  assert.equal(failed.activeRun.progressTimer, null);

  const cancelled = createSupervisor({ progressHeartbeatIntervalMs: 5 });
  cancelled.acpConnection = { signal: { aborted: false } };
  cancelled.acpContext = {
    request: () => new Promise(() => {}),
    notify: async () => {},
  };
  cancelled.attachedSessionId = SESSION_ID;
  cancelled.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Wait for cancellation.",
    confirmation: "SEND_TO_GROK",
  });
  await cancelled.cancelPrompt({ sessionId: SESSION_ID, confirmation: "CANCEL_GROK_PROMPT" });
  assert.equal(cancelled.activeRun.status, "cancel_requested");
  assert.equal(cancelled.activeRun.progressTimer, null);
  const count = cancelled.events.filter((event) => event.kind === "run_progress").length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelled.events.filter((event) => event.kind === "run_progress").length, count);
});

test("available command updates are hash-coalesced and never journal the full capability payload", () => {
  const supervisor = createSupervisor();
  const marker = `CAPABILITY_DESCRIPTION_PAYLOAD:${"z".repeat(5_000)}`;
  const first = supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: marker, input: { hint: "target" } }],
    },
  });
  const sequenceAfterFirst = supervisor.nextSequence;
  const duplicate = supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: marker, input: { hint: "target" } }],
    },
  });
  const changed = supervisor.handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: `${marker}-changed`, input: { hint: "target" } },
        { name: "verify", description: "Run targeted checks" },
      ],
    },
  });
  assert.equal(first.kind, "available_commands_changed");
  assert.equal(first.addedCount, 1);
  assert.equal(duplicate, null);
  assert.equal(supervisor.nextSequence, sequenceAfterFirst + 1);
  assert.equal(changed.changedCount, 1);
  assert.equal(changed.addedCount, 1);
  assert.equal(changed.payloadSuppressed, true);
  assert.doesNotMatch(JSON.stringify(supervisor.events), /CAPABILITY_DESCRIPTION_PAYLOAD/);
  assert.equal(supervisor.events.some((event) => event.kind === "session_update"), false);
});

test("ACP form elicitation is distinct from permission and validates the exact answer", async () => {
  const supervisor = createSupervisor();
  supervisor.attachedSessionId = SESSION_ID;
  const pending = supervisor.handleElicitation({
    mode: "form",
    sessionId: SESSION_ID,
    message: "Two authoritative configs conflict. Which one owns deployment?",
    requestedSchema: {
      type: "object",
      properties: {
        owner: { type: "string", enum: ["config-a", "config-b"] },
      },
      required: ["owner"],
    },
  });
  const interaction = await supervisor.inspect({ sessionId: SESSION_ID });
  assert.equal(interaction.state, "needs_input");
  assert.equal(interaction.request.kind, "input");
  assert.equal(interaction.request.message, "Two authoritative configs conflict. Which one owns deployment?");
  assert.throws(() => supervisor.respond({
    elicitationId: interaction.request.elicitationId,
    action: "accept",
    content: { owner: "invented" },
    confirmation: "ANSWER_GROK_INPUT",
  }), /not one of the allowed values/);
  const answered = supervisor.respond({
    elicitationId: interaction.request.elicitationId,
    action: "accept",
    content: { owner: "config-a" },
    confirmation: "ANSWER_GROK_INPUT",
  });
  assert.equal(answered.answered, true);
  assert.deepEqual(await pending, { action: "accept", content: { owner: "config-a" } });
});

test("status preserves stale TUI records for audit but does not report them as running", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-stale-tui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tuiStateRoot = join(root, "tuis");
  mkdirSync(tuiStateRoot, { recursive: true });
  writeFileSync(join(tuiStateRoot, "stale.json"), JSON.stringify({
    schemaVersion: 1,
    launchId: "stale-launch",
    status: "running",
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    hostPid: 2_147_483_647,
    grokPid: 2_147_483_647,
  }));
  const supervisor = createSupervisor({ stateRoot: root, tuiStateRoot });
  supervisor.leaderInfo = async () => ({ running: false });
  supervisor.readActiveSessions = () => [];
  const status = await supervisor.status();
  assert.equal(status.recordedTuis[0].status, "stale");
  assert.equal(status.recordedTuis[0].recordedStatus, "running");
  assert.equal(status.recordedTuis[0].processAlive, false);
});

test("status rejects a reused live PID whose process identity and session registry do not match", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-reused-tui-pid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tuiStateRoot = join(root, "tuis");
  mkdirSync(tuiStateRoot, { recursive: true });
  writeFileSync(join(tuiStateRoot, "reused.json"), JSON.stringify({
    schemaVersion: 1,
    launchId: "reused-launch",
    leaderOwnerToken: OWNER_TOKEN,
    status: "running",
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    hostPid: process.pid,
    grokPid: process.pid,
    grokProcessFingerprint: "original-grok-fingerprint",
  }));
  const supervisor = createSupervisor({
    stateRoot: root,
    tuiStateRoot,
    grokBinary: join(root, "grok.exe"),
    inspectProcessIdentity: () => ({ fingerprint: "reused-cmd-fingerprint", executablePath: process.execPath }),
  });
  supervisor.leaderInfo = async () => ({ running: false });
  supervisor.readActiveSessions = () => [];
  supervisor.readLeaderOwnership = () => ({ valid: false, reason: "missing" });

  const status = await supervisor.status();
  assert.equal(status.recordedTuis[0].pidAlive, true);
  assert.equal(status.recordedTuis[0].processIdentityMatch, false);
  assert.equal(status.recordedTuis[0].processAlive, false);
  assert.equal(status.recordedTuis[0].status, "stale_pid_reused_or_unverified");
});

test("rollback refuses to terminate a PID after its owned process fingerprint changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-rollback-reused-pid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "launch.json");
  writeFileSync(statePath, JSON.stringify({
    launchId: "launch-1",
    status: "running",
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    grokPid: process.pid,
    grokProcessFingerprint: "original-grok-fingerprint",
  }));
  const supervisor = createSupervisor({
    grokBinary: process.execPath,
    inspectProcessIdentity: () => ({ fingerprint: "reused-process-fingerprint", executablePath: process.execPath }),
  });
  supervisor.tuiProcesses.set(process.pid, {
    launchId: "launch-1",
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    statePath,
    processFingerprint: "original-grok-fingerprint",
  });

  await assert.rejects(
    () => supervisor.stopOwnedTuiForRollback(process.pid),
    /refusing to terminate/,
  );
  assert.equal(supervisor.tuiProcesses.has(process.pid), false);
});

test("permission responses require an exact Grok option and resolve the pending request", async () => {
  const supervisor = createSupervisor();
  const pending = supervisor.handlePermission({
    sessionId: SESSION_ID,
    toolCall: { title: "Run tests", toolCallId: "tool-1" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  const [summary] = supervisor.permissionSummaries();
  assert.equal(summary.toolTitle, "Run tests");
  assert.throws(() => supervisor.answerPermission({
    permissionId: summary.permissionId,
    action: "select",
    optionId: "invented",
    confirmation: "ANSWER_GROK_PERMISSION",
  }), /not one of the options/);
  const answer = supervisor.answerPermission({
    permissionId: summary.permissionId,
    action: "select",
    optionId: "allow-once",
    confirmation: "ANSWER_GROK_PERMISSION",
  });
  assert.equal(answer.answered, true);
  assert.deepEqual(await pending, { outcome: { outcome: "selected", optionId: "allow-once" } });
});

test("startPrompt is asynchronous, single-flight, and bounds the terminal result", async () => {
  const supervisor = createSupervisor();
  let resolvePrompt;
  let promptParams;
  supervisor.acpConnection = { signal: { aborted: false } };
  supervisor.acpContext = {
    request: (_method, params) => {
      promptParams = params;
      return new Promise((resolve) => { resolvePrompt = resolve; });
    },
  };
  supervisor.attachedSessionId = SESSION_ID;
  const started = supervisor.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Inspect the project without changing files.",
    hostKind: "claude_code",
    confirmation: "SEND_TO_GROK",
  });
  assert.equal(started.started, true);
  assert.equal(started.hostKind, "claude_code");
  assert.match(promptParams.prompt[0].text, /Claude Code supervision contract/);
  assert.doesNotMatch(promptParams.prompt[0].text, /Codex supervision contract/);
  assert.match(promptParams.prompt[0].text, /Inspect the project without changing files/);
  assert.throws(() => supervisor.startPrompt({
    sessionId: SESSION_ID,
    prompt: "Second prompt",
    confirmation: "SEND_TO_GROK",
  }), /still running/);
  resolvePrompt({ text: "x".repeat(100_000) });
  await supervisor.activeRun.promise;
  assert.equal(supervisor.activeRun.status, "completed");
  assert.match(supervisor.activeRun.result.text, /chars truncated/);
});
