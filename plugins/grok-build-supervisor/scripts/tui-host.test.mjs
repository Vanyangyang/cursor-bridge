import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { buildGrokTuiArgs, parseCli, runTuiHost } from "./tui-host.mjs";

const SESSION_ID = "01a010fc-7377-7330-b20f-9089aa5d93b6";
const OWNER_TOKEN = "01900000-0000-7000-8000-000000000001";

test("parseCli accepts only explicit valued flags", () => {
  assert.deepEqual(parseCli(["--mode", "resume", "--session-id", SESSION_ID]), {
    mode: "resume",
    "session-id": SESSION_ID,
  });
  assert.throws(() => parseCli(["resume"]), /Unexpected positional/);
  assert.throws(() => parseCli(["--mode"]), /Missing value/);
});

test("buildGrokTuiArgs creates or resumes without a shell command", () => {
  const cwd = process.cwd();
  const socket = join(cwd, "leader.sock");
  const created = buildGrokTuiArgs({ leaderSocket: socket, cwd, mode: "new", sessionId: SESSION_ID });
  const resumed = buildGrokTuiArgs({ leaderSocket: socket, cwd, mode: "resume", sessionId: SESSION_ID });
  assert.deepEqual(created.slice(-2), ["--session-id", SESSION_ID]);
  assert.deepEqual(resumed.slice(-2), ["--resume", SESSION_ID]);
  assert.ok(created.includes("--fullscreen"));
  assert.deepEqual(created.slice(0, 2), ["--permission-mode", "default"]);
  assert.equal(created.includes("--always-approve"), false);
  assert.equal(created.includes("--subagents"), false);
  assert.equal(created.includes("--no-subagents"), false);
  assert.throws(() => buildGrokTuiArgs({ leaderSocket: socket, cwd, mode: "resume", sessionId: "short" }), /exact UUID/);
});

test("runTuiHost records the real Grok PID and terminal exit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-tui-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const statePath = join(root, "state.json");
  let receivedArgs = null;
  let receivedOptions = null;
  const child = new EventEmitter();
  child.pid = 24680;
  child.kill = () => {};
  const exitCode = await runTuiHost({
    "state-path": statePath,
    "grok-binary": join(root, "grok.exe"),
    "leader-socket": join(root, "leader.sock"),
    "leader-owner-token": OWNER_TOKEN,
    cwd,
    mode: "resume",
    "session-id": SESSION_ID,
    "launch-id": "launch-1",
  }, (_command, args, options) => {
    receivedArgs = args;
    receivedOptions = options;
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  }, () => ({
    environment: {
      TEST_BASE: "1",
      HTTP_PROXY: "http://127.0.0.1:43123",
      HTTPS_PROXY: "http://127.0.0.1:43123",
    },
  }), (pid) => ({
    fingerprint: pid === child.pid ? "grok-fingerprint" : "host-fingerprint",
    executablePath: pid === child.pid ? join(root, "grok.exe") : process.execPath,
    createdAt: "2026-08-19T00:00:00.000Z",
  }));
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(exitCode, 0);
  assert.equal(state.status, "exited");
  assert.equal(state.grokPid, 24680);
  assert.equal(state.grokProcessFingerprint, "grok-fingerprint");
  assert.equal(state.hostProcessFingerprint, "host-fingerprint");
  assert.equal(state.leaderOwnerToken, OWNER_TOKEN);
  assert.deepEqual(receivedArgs.slice(-2), ["--resume", SESSION_ID]);
  assert.equal(receivedOptions.stdio, "inherit");
  assert.equal(receivedOptions.env.HTTPS_PROXY, "http://127.0.0.1:43123");
});
