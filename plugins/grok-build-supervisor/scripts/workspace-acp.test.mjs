import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { GrokSupervisor } from "./supervisor-core.mjs";
import { SupervisorClient, SupervisorDaemon, daemonPaths } from "./supervisor-transport.mjs";

// Exercise the real ACP client, core, daemon and Named Pipe client together.
// Only the Grok process is simulated; no installed Grok process is contacted.
function simulatedGrokPeer(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.stdin.end();
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
    return true;
  };
  const requests = [];
  let pendingPrompt;
  let sessionId;
  let buffer = "";
  const send = (value) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      requests.push(request);
      if (request.method === "initialize") {
        send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      } else if (request.method === "session/new") {
        sessionId = randomUUID();
        send({ id: request.id, result: { sessionId } });
      } else if (request.method === "session/prompt") {
        pendingPrompt = request;
      }
    }
  });
  return {
    child, requests,
    get promptPending() { return Boolean(pendingPrompt); },
    finish(text) {
      assert.ok(pendingPrompt, "ACP must have received the prompt before completion");
      send({ method: "session/update", params: {
        sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      } });
      send({ id: pendingPrompt.id, result: { stopReason: "end_turn" } });
      pendingPrompt = null;
    },
  };
}

async function eventually(check, description) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await delay(5);
  }
}

test("two workspaces execute simultaneously through real ACP connections and isolated daemon routes", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "grok-multi-acp-")));
  const stateRoot = join(root, "state");
  const a = join(root, "a");
  const b = join(root, "b");
  for (const path of [stateRoot, a, b]) mkdirSync(path);
  const aliasA = join(root, "alias-a");
  symlinkSync(a, aliasA, process.platform === "win32" ? "junction" : "dir");
  const cores = [];
  const peers = [];
  const createSupervisor = (options) => {
    const core = new GrokSupervisor({
      ...options, persistTuiRuntime: false,
      spawnProcess: () => {
        const peer = simulatedGrokPeer(424250 + peers.length);
        peers.push(peer);
        return peer.child;
      },
    });
    core.readActiveSessions = () => [];
    core.leaderInfo = async () => ({ running: Boolean(core.leaderCwd) });
    core.startLeader = async ({ cwd }) => {
      core.leaderCwd = cwd;
      core.leaderProxyContext = { environment: {} };
      return { started: false, managed: true };
    };
    core.ensureLeaderProxyRouteVerified = async () => ({ verified: true });
    cores.push(core);
    return core;
  };
  const paths = daemonPaths(stateRoot);
  const daemon = new SupervisorDaemon({
    paths, supervisor: createSupervisor({ stateRoot }), supervisorFactory: createSupervisor, runtimeVersion: "test",
  });
  const first = new SupervisorClient({ paths, clientVersion: "test", spawnProcess: () => assert.fail("daemon already started") });
  const second = new SupervisorClient({ paths, clientVersion: "test", spawnProcess: () => assert.fail("daemon already started") });
  t.after(async () => {
    await Promise.allSettled([first.detach(), second.detach()]);
    await Promise.allSettled(cores.map((core) => core.disconnect()));
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await daemon.start();
  const [sessionA, sessionB] = await Promise.all([
    first.openSession({ mode: "new", cwd: aliasA, presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS" }),
    second.openSession({ mode: "new", cwd: b, presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS" }),
  ]);
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);
  assert.equal(peers.length, 2);
  const resumedA = await first.openSession({
    mode: "resume", cwd: a, sessionId: sessionA.sessionId, presentation: "none", confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  assert.equal(resumedA.sessionId, sessionA.sessionId);
  assert.equal(peers.length, 2, "canonical and alias paths reuse the same ACP connection");
  const [runA, runB] = await Promise.all([
    first.startPrompt({ sessionId: sessionA.sessionId, prompt: "A", confirmation: "SEND_TO_GROK" }),
    second.startPrompt({ sessionId: sessionB.sessionId, prompt: "B", confirmation: "SEND_TO_GROK" }),
  ]);
  await eventually(() => peers.every((peer) => peer.promptPending), "both peers receive work before either completes");
  assert.equal(cores[0].activeRun.status, "running");
  assert.equal(cores[1].activeRun.status, "running");
  assert.notEqual(cores[0].acpConnection, cores[1].acpConnection);
  assert.notEqual(cores[0].socketPath, cores[1].socketPath);

  const peerA = peers.find((peer) => peer.requests.some((request) => request.params?.sessionId === sessionA.sessionId));
  const peerB = peers.find((peer) => requestFor(peer, sessionB.sessionId));
  peerA.finish("ONLY_WORKSPACE_A_RESULT");
  await eventually(() => cores.find((core) => core.attachedSessionId === sessionA.sessionId).activeRun.status === "completed", "A completes");
  assert.equal(cores.find((core) => core.attachedSessionId === sessionB.sessionId).activeRun.status, "running");
  peerB.finish("ONLY_WORKSPACE_B_RESULT");
  await eventually(() => cores.every((core) => core.activeRun?.status === "completed"), "both complete independently");
  const [resultA, resultB] = await Promise.all([
    first.inspect({ cwd: a, sessionId: sessionA.sessionId, runId: runA.runId }),
    second.inspect({ cwd: b, sessionId: sessionB.sessionId, runId: runB.runId }),
  ]);
  assert.equal(resultA.run.finalText, "ONLY_WORKSPACE_A_RESULT");
  assert.equal(resultB.run.finalText, "ONLY_WORKSPACE_B_RESULT");
  await first.control({ cwd: a, sessionId: sessionA.sessionId, action: "disconnect", confirmation: "CONTROL_GROK_SESSION" });
  const stillAttachedB = await second.inspect({ cwd: b, sessionId: sessionB.sessionId });
  assert.equal(stillAttachedB.session.attached, true);
  assert.equal(cores.find((core) => core.attachedSessionId === sessionB.sessionId).acpConnection.signal.aborted, false);
});

function requestFor(peer, sessionId) {
  return peer.requests.some((request) => request.params?.sessionId === sessionId);
}
