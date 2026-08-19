import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { GrokSupervisor } from "./supervisor-core.mjs";

const sessionId = process.env.GROK_SMOKE_SESSION_ID;
const cwd = process.env.GROK_SMOKE_CWD;
if (!sessionId || !cwd) {
  throw new Error("Set GROK_SMOKE_SESSION_ID and GROK_SMOKE_CWD");
}

const stateRoot = join(tmpdir(), `grok-build-supervisor-smoke-${process.pid}`);
const supervisor = new GrokSupervisor({ stateRoot, socketPath: join(stateRoot, "leader.sock") });
let started = false;

try {
  const opened = await supervisor.openSession({
    mode: "resume",
    sessionId,
    cwd,
    presentation: "none",
    confirmation: "OPEN_GROK_SESSION_HEADLESS",
  });
  started = opened.leader.started === true;
  const status = await supervisor.status();
  await supervisor.disconnect();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
  const leaderAfterDisconnect = await supervisor.leaderInfo();
  const ownershipAfterDisconnect = supervisor.readLeaderOwnership();
  if (!leaderAfterDisconnect.running || !ownershipAfterDisconnect.valid) {
    throw new Error("The verified detached Leader did not survive the ACP disconnect handoff");
  }
  process.stdout.write(`${JSON.stringify({
    leaderStarted: started,
    opened: opened.opened,
    presentation: opened.presentation,
    visibleTuiLaunched: opened.presentation === "windows_terminal",
    attached: opened.attachment.attached,
    attachedSessionId: status.attachedSessionId,
    acpConnected: status.acpConnected,
    leaderProxySource: status.leaderProxy?.source ?? null,
    leaderProxyEndpoint: status.leaderProxy?.endpoint ?? null,
    leaderProxyVerified: status.leaderProxy?.route?.verified === true,
    leaderPid: ownershipAfterDisconnect.record.leaderPid,
    leaderLauncherPid: opened.leader.launcherPid ?? null,
    leaderSurvivedDisconnect: true,
    promptSent: false,
  }, null, 2)}\n`);
} finally {
  await supervisor.disconnect().catch(() => {});
  if (started) {
    await supervisor.stopOwnedLeader({ confirmation: "STOP_OWNED_LEADER" }).catch(() => {});
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(stateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      break;
    } catch (error) {
      if (attempt === 19) {
        process.stderr.write(`Smoke cleanup warning: ${error.message}\n`);
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
}
