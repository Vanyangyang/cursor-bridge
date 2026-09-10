import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SupervisorDaemon } from "./supervisor-transport.mjs";

test("older host clients cannot roll an idle newer daemon back to an old runtime", async (t) => {
  for (const [current, target] of [
    ["0.4.2+codex.20260909163310", "0.4.2"],
    ["0.4.2+codex.20260909163310", "0.4.2+codex.20260909160000"],
    ["0.5.0", "0.4.2+codex.20260909163310"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "grok-runtime-version-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const daemon = new SupervisorDaemon({
      stateRoot: root, runtimeVersion: current, runtimeFingerprint: "new",
      supervisor: { status: async () => assert.fail("downgrade must be refused before lifecycle changes") },
    });
    const result = await daemon.route({
      clientId: randomUUID(), method: "upgrade_if_idle",
      params: { confirmation: "RESTART_IDLE_SUPERVISOR_DAEMON", targetVersion: target, targetFingerprint: "old" },
    });
    assert.equal(result.restarting, false);
    assert.equal(result.newerRuntimePreserved, true);
    assert.equal(result.runtimeVersion, current);
    assert.equal(daemon.lifecycleOperation, null);
  }
});

test("a newer cache or release still reaches the ordinary busy/idle upgrade guard", async (t) => {
  for (const target of ["0.4.2+codex.20260909170000", "0.4.3"]) {
    const root = mkdtempSync(join(tmpdir(), "grok-runtime-forward-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const daemon = new SupervisorDaemon({
      stateRoot: root, runtimeVersion: "0.4.2+codex.20260909163310",
      runtimeFingerprint: "old", supervisor: {},
    });
    daemon.daemonBusyState = async () => ({ busy: true, workspaces: [] });
    const result = await daemon.route({
      clientId: randomUUID(), method: "upgrade_if_idle",
      params: { confirmation: "RESTART_IDLE_SUPERVISOR_DAEMON", targetVersion: target, targetFingerprint: "new" },
    });
    assert.equal(result.busy, true);
    assert.equal(result.newerRuntimePreserved, undefined);
  }
});
