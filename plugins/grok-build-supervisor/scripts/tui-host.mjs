#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveLeaderProxyContext } from "./proxy-environment.mjs";
import { writeJsonAtomic } from "./tui-presentation.mjs";
import { inspectProcessIdentity } from "./process-identity.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${item}`);
    }
    const key = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

export function buildGrokTuiArgs({ leaderSocket, cwd, mode, sessionId }) {
  if (!isAbsolute(leaderSocket) || !isAbsolute(cwd)) {
    throw new Error("leader socket and cwd must be absolute");
  }
  if (!UUID_RE.test(sessionId || "")) {
    throw new Error("session-id must be an exact UUID");
  }
  const args = [
    "--permission-mode",
    "default",
    "--leader",
    "--leader-socket", leaderSocket,
    "--cwd", cwd,
    "--fullscreen",
  ];
  if (mode === "new") {
    args.push("--session-id", sessionId);
  } else if (mode === "resume") {
    args.push("--resume", sessionId);
  } else {
    throw new Error("mode must be new or resume");
  }
  return args;
}

export async function runTuiHost(
  options,
  spawnProcess = spawn,
  resolveProxyContext = resolveLeaderProxyContext,
  inspectIdentity = inspectProcessIdentity,
) {
  const statePath = options["state-path"];
  const grokBinary = options["grok-binary"];
  const leaderSocket = options["leader-socket"];
  const leaderOwnerToken = options["leader-owner-token"];
  const cwd = options.cwd;
  const mode = options.mode;
  const sessionId = options["session-id"];
  const launchId = options["launch-id"];
  if (![statePath, grokBinary, leaderSocket, cwd].every(isAbsolute) || !launchId || !UUID_RE.test(leaderOwnerToken || "")) {
    throw new Error("state-path, grok-binary, leader-socket, cwd, launch-id, and an exact leader-owner-token are required; paths must be absolute");
  }
  const hostIdentity = inspectIdentity(process.pid);
  const baseState = {
    schemaVersion: 1,
    launchId,
    leaderOwnerToken,
    mode,
    sessionId,
    cwd,
    hostPid: process.pid,
    hostProcessFingerprint: hostIdentity?.fingerprint ?? null,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(statePath, { ...baseState, status: "starting", grokPid: null });

  const args = buildGrokTuiArgs({ leaderSocket, cwd, mode, sessionId });
  const proxyContext = await resolveProxyContext({
    baseEnvironment: process.env,
    policy: process.env.GROK_SUPERVISOR_PROXY_POLICY || "required",
  });
  const child = spawnProcess(grokBinary, args, {
    cwd,
    stdio: "inherit",
    windowsHide: false,
    env: proxyContext.environment,
  });
  const exitPromise = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
    writeJsonAtomic(statePath, {
      ...baseState,
      status: "failed",
      grokPid: child.pid ?? null,
      error: error.message,
      updatedAt: new Date().toISOString(),
    });
  });

  if (!child.pid) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  if (spawnError || !child.pid) {
    throw spawnError || new Error("Grok TUI process did not provide a PID");
  }
  let grokIdentity = inspectIdentity(child.pid);
  for (let attempt = 0; process.platform === "win32" && !grokIdentity && attempt < 20; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    grokIdentity = inspectIdentity(child.pid);
  }
  if (process.platform === "win32" && !grokIdentity) {
    try {
      child.kill();
    } catch {
      // The child may already have exited while identity capture was pending.
    }
    throw new Error(`Could not capture a durable process identity for Grok TUI PID ${child.pid}`);
  }
  const grokState = {
    grokPid: child.pid,
    grokProcessFingerprint: grokIdentity?.fingerprint ?? null,
    grokExecutablePath: grokIdentity?.executablePath ?? null,
    grokCreatedAt: grokIdentity?.createdAt ?? null,
  };
  writeJsonAtomic(statePath, {
    ...baseState,
    status: "running",
    ...grokState,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const forward = () => {
    if (child.pid) {
      try {
        child.kill();
      } catch {
        // The child may already have exited.
      }
    }
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);

  const result = await exitPromise;
  process.removeListener("SIGINT", forward);
  process.removeListener("SIGTERM", forward);
  writeJsonAtomic(statePath, {
    ...baseState,
    status: "exited",
    ...grokState,
    exitCode: result.code,
    signal: result.signal,
    exitedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return result.code ?? (result.signal ? 1 : 0);
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const code = await runTuiHost(options);
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
