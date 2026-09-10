import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateRoot, GrokSupervisor, normalizeHostKind } from "./supervisor-core.mjs";
import { readJsonFile, writeJsonAtomic } from "./tui-presentation.mjs";
import {
  DEFAULT_INLINE_RESULT_MAX_BYTES,
  persistResultArtifact,
  summarizeResultText,
} from "./result-artifact.mjs";
import { materializeDaemonRuntime } from "./runtime-snapshot.mjs";
import { canonicalWorkspace, WorkspaceRegistry } from "./workspace-registry.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(MODULE_DIRECTORY, "..");
const DEFAULT_DAEMON_BUNDLE = join(PLUGIN_ROOT, "dist", "supervisor-daemon.mjs");
const MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const CONNECTION_RETRY_MS = 100;

export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_CAPABILITIES = Object.freeze({
  cacheIndependentDaemonRuntime: true,
  hostIdentityEnvelope: true,
  interactionDeliveryV2: true,
  persistentTuiRuntime: true,
  proxyInitialization: true,
  resultArtifacts: true,
  sessionOpenV2: true,
  multiWorkspaceSessions: true,
});

function conciseError(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorWithCode(message, code, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isOlderRuntime(targetVersion, currentVersion) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)(?:\+codex\.(.+))?$/.exec(String(value || ""));
  const target = parse(targetVersion);
  const current = parse(currentVersion);
  if (!target || !current) return false;
  for (let part = 1; part <= 3; part += 1) {
    if (Number(target[part]) !== Number(current[part])) {
      return Number(target[part]) < Number(current[part]);
    }
  }
  if (current[4] && !target[4]) return true;
  return /^\d{14}$/.test(target[4] || "") && /^\d{14}$/.test(current[4] || "")
    && target[4] < current[4];
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveHostKind(env = process.env) {
  const explicit = normalizeHostKind(env.GROK_SUPERVISOR_HOST_KIND);
  if (explicit !== "unknown") return explicit;
  if (String(env.CODEX_THREAD_ID || "").trim()) return "codex";
  if (String(env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || "").trim()) return "claude_code";
  if (String(env.CLAUDE_PROJECT_DIR || env.CLAUDE_CODE_PROJECT_DIR || "").trim()) return "claude_code";
  return "unknown";
}

export function coalesceInteractionResult(result, params = {}, options = {}) {
  if (!result || result.view !== "interaction") {
    return result;
  }
  const afterSequence = Number.isInteger(params.afterSequence) && params.afterSequence >= 0
    ? params.afterSequence
    : 0;
  const originalCursor = result.cursor && typeof result.cursor === "object" ? result.cursor : {};
  const latestSequence = Number.isInteger(originalCursor.latestSequence)
    ? originalCursor.latestSequence
    : Number.isInteger(originalCursor.nextAfterSequence)
      ? originalCursor.nextAfterSequence
      : afterSequence;
  const originalRun = result.run && typeof result.run === "object" ? result.run : null;
  const terminalSequence = Number.isInteger(originalRun?.terminalSequence)
    ? originalRun.terminalSequence
    : new Set(["completed", "failed"]).has(result.state)
      ? latestSequence
      : null;
  let sourceFinalText = typeof originalRun?.finalText === "string" ? originalRun.finalText : null;
  let sourceArtifact = originalRun?.resultArtifact && typeof originalRun.resultArtifact === "object"
    ? originalRun.resultArtifact
    : null;
  let resultSummary = typeof originalRun?.resultSummary === "string" ? originalRun.resultSummary : null;
  let artifactError = typeof originalRun?.artifactError === "string" ? originalRun.artifactError : null;
  const inlineResultMaxBytes = options.inlineResultMaxBytes ?? DEFAULT_INLINE_RESULT_MAX_BYTES;
  if (result.state === "completed"
    && sourceFinalText !== null
    && !sourceArtifact
    && Buffer.byteLength(sourceFinalText, "utf8") > inlineResultMaxBytes
    && typeof options.persistResultArtifact === "function") {
    try {
      sourceArtifact = options.persistResultArtifact({
        root: options.resultArtifactRoot,
        sessionId: originalRun.sessionId || result.session?.sessionId,
        runId: originalRun.runId,
        text: sourceFinalText,
        sourceChars: sourceFinalText.length,
        inlineMaxBytes: inlineResultMaxBytes,
      });
      if (sourceArtifact) {
        sourceFinalText = null;
      }
    } catch (error) {
      artifactError = conciseError(error);
      resultSummary = summarizeResultText(sourceFinalText);
      sourceFinalText = null;
    }
  }
  const resultArtifactAvailable = result.delivery?.resultArtifactAvailable === true || sourceArtifact !== null;
  const resultArtifactIncluded = result.state === "completed"
    && sourceArtifact !== null
    && (terminalSequence === null || terminalSequence > afterSequence);
  const finalTextAvailable = (result.delivery?.finalTextAvailable === true || sourceFinalText !== null)
    && !resultArtifactAvailable;
  const finalTextIncluded = result.state === "completed"
    && sourceFinalText !== null
    && !resultArtifactAvailable
    && (terminalSequence === null || terminalSequence > afterSequence);
  const run = originalRun ? { ...originalRun } : null;
  if (run) {
    delete run.latestMessage;
    run.terminalSequence = terminalSequence;
    run.finalText = finalTextIncluded ? sourceFinalText : null;
    run.resultArtifact = resultArtifactIncluded ? sourceArtifact : null;
    run.resultSummary = terminalSequence === null || terminalSequence > afterSequence ? resultSummary : null;
    run.artifactError = artifactError;
  }
  const working = result.state === "working";
  const terminalProgress = new Set(["completed", "failed"]).has(result.state)
    && (terminalSequence === null || terminalSequence > afterSequence);
  const sourceProgress = result.progress && typeof result.progress === "object" && !Array.isArray(result.progress)
    ? result.progress
    : null;
  return {
    ...result,
    run,
    progress: working ? {
      ...(sourceProgress || {}),
      status: "streaming",
      newActivity: latestSequence > afterSequence,
      contentSuppressed: true,
      coalesced: true,
      eventsCollapsed: originalCursor.hasMore === true,
    } : terminalProgress ? sourceProgress : null,
    delivery: {
      mode: "terminal_cursor_once",
      finalTextAvailable,
      finalTextIncluded,
      resultArtifactAvailable,
      resultArtifactIncluded,
      terminalSequence,
    },
    cursor: {
      ...originalCursor,
      nextAfterSequence: latestSequence,
      latestSequence,
      hasMore: false,
      coalesced: true,
    },
  };
}

export function daemonPaths(stateRoot = defaultStateRoot()) {
  const root = resolve(stateRoot);
  const identity = process.platform === "win32" ? root.toLowerCase() : root;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 20);
  return {
    stateRoot: root,
    pipePath: process.platform === "win32"
      ? `\\\\.\\pipe\\grok-build-supervisor-${suffix}`
      : join(tmpdir(), `grok-build-supervisor-${suffix}.sock`),
    authPath: join(root, "daemon-auth.json"),
    metadataPath: join(root, "daemon.json"),
    startupErrorPath: join(root, "daemon-startup-error.json"),
  };
}

function parseAuthRecord(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.schemaVersion !== 1 || typeof value.token !== "string" || !/^[0-9a-f]{64}$/i.test(value.token)) {
    throw new Error(`Invalid Supervisor daemon auth record: ${path}`);
  }
  return value;
}

export function ensureDaemonAuth(paths = daemonPaths()) {
  mkdirSync(paths.stateRoot, { recursive: true });
  if (existsSync(paths.authPath)) {
    return parseAuthRecord(paths.authPath).token;
  }
  const record = {
    schemaVersion: 1,
    token: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  let descriptor;
  try {
    descriptor = openSync(paths.authPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  return parseAuthRecord(paths.authPath).token;
}

function secretsMatch(expected, received) {
  if (typeof received !== "string") {
    return false;
  }
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function serializeError(error) {
  const payload = { message: conciseError(error) };
  if (typeof error?.code === "string") {
    payload.code = error.code;
  }
  if (error?.details && typeof error.details === "object") {
    payload.details = error.details;
  }
  return payload;
}

function responseLine(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
    return `${JSON.stringify({
      id: value?.id ?? null,
      ok: false,
      error: { message: "Supervisor daemon response exceeded 1 MiB", code: "DAEMON_RESPONSE_TOO_LARGE" },
    })}\n`;
  }
  return `${serialized}\n`;
}

export class SupervisorDaemon {
  constructor(options = {}) {
    this.paths = options.paths || daemonPaths(options.stateRoot);
    this.authToken = options.authToken || ensureDaemonAuth(this.paths);
    this.runtimeVersion = options.runtimeVersion || readPluginVersion();
    this.runtimeFingerprint = options.runtimeFingerprint || null;
    this.runtimeScript = fileURLToPath(import.meta.url);
    this.runtimeRoot = dirname(this.runtimeScript);
    this.capabilities = options.capabilities || DAEMON_CAPABILITIES;
    this.supervisor = options.supervisor || new GrokSupervisor({
      stateRoot: this.paths.stateRoot,
      persistTuiRuntime: true,
    });
    this.registry = options.workspaceRegistry || new WorkspaceRegistry({
      stateRoot: this.paths.stateRoot,
      legacySupervisor: this.supervisor,
      createSupervisor: options.supervisorFactory || ((supervisorOptions) => new GrokSupervisor(supervisorOptions)),
    });
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now || (() => Date.now());
    this.daemonInstanceId = options.daemonInstanceId || randomUUID();
    this.server = null;
    this.clients = new Map();
    this.stopping = false;
    this.lifecycleOperation = null;
    this.routingWritesInFlight = 0;
  }

  // Retain the old single-workspace field as a compatibility view of the
  // permanently rooted legacy workspace. New code always passes an entry.
  get writerLease() {
    return this.registry.legacy.writerLease;
  }

  set writerLease(value) {
    this.registry.legacy.writerLease = value;
  }

  leaseSnapshot(entry = this.registry.legacy, clientId = null) {
    const lease = entry.writerLease;
    const active = Boolean(lease && lease.expiresAt > this.now());
    return {
      active,
      ownedByClient: active && lease.clientId === clientId,
      sessionId: active ? lease.sessionId : null,
      expiresAt: active ? new Date(lease.expiresAt).toISOString() : null,
    };
  }

  touchClient(clientId) {
    const now = this.now();
    const existing = this.clients.get(clientId);
    const client = existing && typeof existing === "object"
      ? existing
      : { lastSeen: now, boundKey: null };
    client.lastSeen = now;
    this.clients.set(clientId, client);
    return client;
  }

  acquireWriter(entry, clientId, sessionId = null, leaseToken = null) {
    const now = this.now();
    const lease = entry.writerLease;
    if (lease && lease.expiresAt > now) {
      if (lease.clientId !== clientId) {
        throw errorWithCode(
          "Another host client currently holds the Grok writer lease",
          "GROK_WRITER_BUSY",
          { sessionId: lease.sessionId, expiresAt: new Date(lease.expiresAt).toISOString() },
        );
      }
      if (lease.fencingToken !== leaseToken) {
        throw errorWithCode("The Grok writer fencing token is stale or missing", "GROK_WRITER_FENCED");
      }
      if (sessionId && lease.sessionId && lease.sessionId !== sessionId) {
        throw errorWithCode(
          `Writer lease is bound to ${lease.sessionId}, not ${sessionId}`,
          "GROK_WRITER_SESSION_MISMATCH",
        );
      }
      lease.sessionId = sessionId || lease.sessionId;
      lease.expiresAt = now + this.leaseMs;
      return lease;
    }
    if (!lease || lease.expiresAt <= now) {
      entry.writerLease = {
        clientId,
        sessionId,
        fencingToken: randomUUID(),
        acquiredAt: now,
        expiresAt: now + this.leaseMs,
      };
    }
    return entry.writerLease;
  }

  requireWriter(entry, clientId, sessionId = null, leaseToken = null) {
    return this.acquireWriter(entry, clientId, sessionId, leaseToken);
  }

  releaseWriter(entry, clientId) {
    if (entry.writerLease?.clientId === clientId) {
      entry.writerLease = null;
      return true;
    }
    return false;
  }

  refreshWriter(entry, clientId, leaseToken) {
    const lease = entry.writerLease;
    const now = this.now();
    if (lease
      && lease.expiresAt > now
      && lease.clientId === clientId
      && lease.fencingToken === leaseToken) {
      lease.expiresAt = now + this.leaseMs;
      return true;
    }
    return false;
  }

  async daemonBusyState() {
    await this.registry.initialize();
    const workspaceStates = await Promise.all([...this.registry.entries.values()].map(async (entry) => {
      const status = await entry.supervisor.status();
      const liveTuis = (status.recordedTuis || []).filter((item) =>
        item.processAlive === true
        && item.leaderOwnershipMatch === true
        && item.processIdentityMatch !== false);
      const verifiedLiveTuiCount = Number.isInteger(status.recordedTuiCounts?.verifiedLive)
        ? status.recordedTuiCounts.verifiedLive
        : liveTuis.length;
      const ownedLiveTuiCount = Array.isArray(status.ownedVisibleTuiPids)
        ? status.ownedVisibleTuiPids.length
        : 0;
      const busy = Boolean(
        entry.opening
        || entry.inFlightWrites > 0
        || status.acpConnected
        || status.attachedSessionId
        || status.activeRun?.status === "running"
        || status.pendingPermissions?.length
        || status.pendingElicitations?.length
        || status.pendingWorkspaceTrust?.length
        || verifiedLiveTuiCount
        || ownedLiveTuiCount
      );
      return { entry, status, busy, liveTuiCount: verifiedLiveTuiCount, ownedLiveTuiCount };
    }));
    const legacy = workspaceStates.find((item) => item.entry === this.registry.legacy) || workspaceStates[0];
    return {
      busy: this.routingWritesInFlight > 0 || workspaceStates.some((item) => item.busy),
      status: legacy?.status || {},
      liveTuiCount: workspaceStates.reduce((sum, item) => sum + item.liveTuiCount, 0),
      ownedLiveTuiCount: workspaceStates.reduce((sum, item) => sum + item.ownedLiveTuiCount, 0),
      leaderRunningCount: workspaceStates.filter((item) => item.status.leader?.running === true).length,
      routingWritesInFlight: this.routingWritesInFlight,
      workspaces: workspaceStates.map((item) => ({
        key: item.entry.key,
        cwd: item.entry.cwd,
        busy: item.busy,
        attachedSessionId: item.status.attachedSessionId || null,
        activeRun: item.status.activeRun?.status || null,
        leaderRunning: item.status.leader?.running === true,
        liveTuiCount: item.liveTuiCount,
        inFlightWrites: item.entry.inFlightWrites,
        opening: Boolean(item.entry.opening),
      })),
    };
  }

  assertWritesAllowed() {
    if (this.lifecycleOperation) {
      throw errorWithCode(
        `Supervisor daemon ${this.lifecycleOperation} is in progress`,
        "GROK_SUPERVISOR_BUSY",
        { operation: this.lifecycleOperation },
      );
    }
  }

  async runEntryWrite(entry, operation, { serializeOpen = false } = {}) {
    this.assertWritesAllowed();
    entry.inFlightWrites += 1;
    const previous = entry.writeTail || Promise.resolve();
    const current = Promise.resolve(previous).catch(() => {}).then(() => {
      this.assertWritesAllowed();
      return operation();
    });
    entry.writeTail = current;
    if (serializeOpen) entry.opening = current;
    try {
      return await current;
    } finally {
      if (entry.writeTail === current) entry.writeTail = null;
      if (serializeOpen && entry.opening === current) entry.opening = false;
      entry.inFlightWrites = Math.max(0, entry.inFlightWrites - 1);
    }
  }

  async runWithWriter(entry, clientId, sessionId, leaseToken, operation) {
    const now = this.now();
    const previous = entry.writerLease && entry.writerLease.expiresAt > now
      ? { ...entry.writerLease }
      : null;
    const lease = this.requireWriter(entry, clientId, sessionId, leaseToken);
    const newlyGranted = previous === null;
    try {
      const result = await operation(lease);
      if (entry.writerLease?.fencingToken === lease.fencingToken) {
        lease.expiresAt = this.now() + this.leaseMs;
      }
      return result;
    } catch (error) {
      // A failed core mutation must not leave a lease behind, and an expired
      // fencing token must never be restored.
      if (newlyGranted && entry.writerLease?.fencingToken === lease.fencingToken) {
        entry.writerLease = null;
      }
      throw error;
    }
  }

  async beginLifecycleOperation(operation) {
    if (this.lifecycleOperation) {
      throw errorWithCode(
        `Another Supervisor daemon lifecycle operation (${this.lifecycleOperation}) is already running`,
        operation === "initialize_proxy" ? "GROK_INIT_BUSY" : "GROK_SUPERVISOR_BUSY",
      );
    }
    this.lifecycleOperation = operation;
    try {
      return await this.daemonBusyState();
    } catch (error) {
      this.finishLifecycleOperation(operation);
      throw error;
    }
  }

  finishLifecycleOperation(operation) {
    if (this.lifecycleOperation === operation) this.lifecycleOperation = null;
  }

  async disconnectAllSupervisors() {
    await Promise.all([...this.registry.entries.values()].map((entry) =>
      entry.supervisor.disconnect().catch(() => {})));
  }

  async routeRequest({
    clientId,
    clientVersion,
    hostKind = "unknown",
    leaseToken = null,
    workspaceCwd = null,
    method,
    params = {},
  }) {
    if (typeof clientId !== "string" || clientId.length > 128) {
      throw errorWithCode("A bounded clientId is required", "DAEMON_INVALID_CLIENT");
    }
    await this.registry.initialize();
    const client = this.touchClient(clientId);
    const requesterHostKind = normalizeHostKind(hostKind);
    if (method === "ping") {
      return { result: {
        ok: true,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        daemonInstanceId: this.daemonInstanceId,
        daemonPid: process.pid,
        runtimeVersion: this.runtimeVersion,
        runtimeFingerprint: this.runtimeFingerprint,
        runtimeScript: this.runtimeScript,
        capabilities: this.capabilities,
        clientVersion: clientVersion || null,
        writer: this.leaseSnapshot(this.registry.legacy, clientId),
        workspaces: this.registry.snapshot(),
      }, entry: null, includeLeaseToken: false };
    }
    if (method === "client_disconnect") {
      const matching = [...this.registry.entries.values()].find((entry) =>
        entry.writerLease?.clientId === clientId
        && entry.writerLease.fencingToken === leaseToken);
      const released = Boolean(matching && this.releaseWriter(matching, clientId));
      this.clients.delete(clientId);
      return {
        result: { disconnected: true, releasedWriter: released },
        entry: matching || null,
        workspace: matching ? { key: matching.key, cwd: matching.cwd } : null,
        includeLeaseToken: false,
      };
    }
    if (method === "initialize_proxy") {
      const state = await this.beginLifecycleOperation(method);
      try {
        if (state.busy || state.leaderRunningCount > 0) {
          throw errorWithCode(
            "Grok proxy cannot be reinitialized while any workspace owns an active Leader, TUI, ACP session, prompt, or in-flight write",
            "GROK_INIT_BUSY",
            {
              liveTuiCount: state.liveTuiCount,
              leaderRunningCount: state.leaderRunningCount,
              workspaces: state.workspaces,
            },
          );
        }
        return {
          result: await this.supervisor.initializeProxy(params),
          entry: null,
          includeLeaseToken: false,
        };
      } finally {
        this.finishLifecycleOperation(method);
      }
    }

    if (method === "upgrade_if_idle") {
      if (params.confirmation !== "RESTART_IDLE_SUPERVISOR_DAEMON") {
        throw errorWithCode("Invalid daemon upgrade confirmation", "DAEMON_UPGRADE_REFUSED");
      }
      const versionCurrent = params.targetVersion === this.runtimeVersion;
      if (isOlderRuntime(params.targetVersion, this.runtimeVersion)) {
        return { result: {
          restarting: false,
          newerRuntimePreserved: true,
          runtimeVersion: this.runtimeVersion,
          runtimeFingerprint: this.runtimeFingerprint,
          targetVersion: params.targetVersion,
        }, entry: null, includeLeaseToken: false };
      }
      const fingerprintCurrent = !params.targetFingerprint
        || !this.runtimeFingerprint
        || params.targetFingerprint === this.runtimeFingerprint;
      if (versionCurrent && fingerprintCurrent) {
        return { result: {
          restarting: false,
          alreadyCurrent: true,
          runtimeVersion: this.runtimeVersion,
          runtimeFingerprint: this.runtimeFingerprint,
        }, entry: null, includeLeaseToken: false };
      }
      const idle = await this.beginLifecycleOperation(method);
      let restartAccepted = false;
      try {
        if (idle.busy) {
          return { result: {
            restarting: false,
            busy: true,
            runtimeVersion: this.runtimeVersion,
            runtimeFingerprint: this.runtimeFingerprint,
            targetVersion: params.targetVersion || null,
            targetFingerprint: params.targetFingerprint || null,
            workspaces: idle.workspaces,
          }, entry: null, includeLeaseToken: false };
        }
        await this.disconnectAllSupervisors();
        restartAccepted = true;
        setTimeout(() => this.stop(), 10);
        return { result: {
          restarting: true,
          runtimeVersion: this.runtimeVersion,
          runtimeFingerprint: this.runtimeFingerprint,
          targetVersion: params.targetVersion || null,
          targetFingerprint: params.targetFingerprint || null,
        }, entry: null, includeLeaseToken: false };
      } finally {
        if (!restartAccepted) this.finishLifecycleOperation(method);
      }
    }

    if (method === "shutdown") {
      if (params.confirmation !== "STOP_IDLE_SUPERVISOR_DAEMON") {
        throw errorWithCode("Invalid daemon shutdown confirmation", "DAEMON_SHUTDOWN_REFUSED");
      }
      const idle = await this.beginLifecycleOperation(method);
      let shutdownAccepted = false;
      try {
        if (idle.busy) {
          throw errorWithCode(
            "Supervisor daemon is not idle; refusing shutdown",
            "DAEMON_NOT_IDLE",
            { liveTuiCount: idle.liveTuiCount, workspaces: idle.workspaces },
          );
        }
        await this.disconnectAllSupervisors();
        shutdownAccepted = true;
        setTimeout(() => this.stop(), 10);
        return {
          result: { shuttingDown: true, daemonInstanceId: this.daemonInstanceId },
          entry: null,
          includeLeaseToken: false,
        };
      } finally {
        if (!shutdownAccepted) this.finishLifecycleOperation(method);
      }
    }

    const envelopeWorkspace = workspaceCwd !== null && workspaceCwd !== undefined
      ? canonicalWorkspace(workspaceCwd)
      : null;
    const parameterWorkspace = params.cwd !== null && params.cwd !== undefined
      ? canonicalWorkspace(params.cwd)
      : null;
    if (envelopeWorkspace && parameterWorkspace
      && envelopeWorkspace.identity !== parameterWorkspace.identity) {
      throw errorWithCode(
        "The workspace envelope and request cwd identify different projects",
        "GROK_WORKSPACE_SESSION_MISMATCH",
        { workspaceCwd: envelopeWorkspace.cwd, cwd: parameterWorkspace.cwd },
      );
    }
    const routingCwd = (envelopeWorkspace || parameterWorkspace)?.cwd || null;
    const readOnly = method === "inspect";
    const mutation = ["open", "prompt", "respond", "control"].includes(method);
    if (mutation) {
      this.assertWritesAllowed();
      this.routingWritesInFlight += 1;
    }
    let entry;
    try {
      entry = await this.registry.select({
        cwd: routingCwd,
        sessionId: params.sessionId || null,
        runId: params.runId || null,
        permissionId: params.permissionId || null,
        elicitationId: params.elicitationId || null,
      }, {
        boundKey: client.boundKey,
        create: Boolean(routingCwd) && ["open", "inspect"].includes(method),
        readOnly,
      });
    } finally {
      if (mutation) this.routingWritesInFlight = Math.max(0, this.routingWritesInFlight - 1);
    }
    this.touchClient(clientId);
    let result;
    let includeLeaseToken = false;
    if (method === "inspect") {
      this.refreshWriter(entry, clientId, leaseToken);
      const coreParams = entry.cwd ? { ...params, cwd: entry.cwd } : params;
      result = await entry.supervisor.inspect(coreParams);
      this.refreshWriter(entry, clientId, leaseToken);
      if (result?.view === "status" && result.status) {
        result.status.daemon = {
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          instanceId: this.daemonInstanceId,
          pid: process.pid,
          runtimeVersion: this.runtimeVersion,
          runtimeFingerprint: this.runtimeFingerprint,
          runtimeScript: this.runtimeScript,
          capabilities: this.capabilities,
          writer: this.leaseSnapshot(entry, clientId),
          workspace: { key: entry.key, cwd: entry.cwd },
          workspaces: this.registry.snapshot(),
        };
      }
    } else if (method === "open") {
      result = await this.runEntryWrite(entry, () => this.runWithWriter(
        entry,
        clientId,
        params.sessionId || null,
        leaseToken,
        async (lease) => {
          const coreParams = entry.cwd ? { ...params, cwd: entry.cwd } : params;
          const opened = await entry.supervisor.openSession(coreParams);
          lease.sessionId = opened.sessionId;
          this.registry.rememberSession(entry, opened.sessionId);
          return opened;
        },
      ), { serializeOpen: true });
      includeLeaseToken = true;
    } else if (method === "prompt") {
      result = await this.runEntryWrite(entry, () => this.runWithWriter(
        entry,
        clientId,
        params.sessionId,
        leaseToken,
        () => entry.supervisor.startPrompt({ ...params, hostKind: requesterHostKind }),
      ));
      this.registry.rememberSession(entry, result?.sessionId || params.sessionId);
      includeLeaseToken = true;
    } else if (method === "respond") {
      const { cwd: _routingCwd, sessionId: _routingSessionId, ...coreParams } = params;
      result = await this.runEntryWrite(entry, () => this.runWithWriter(
        entry,
        clientId,
        params.sessionId || entry.supervisor.attachedSessionId,
        leaseToken,
        () => entry.supervisor.respond(coreParams),
      ));
      includeLeaseToken = true;
    } else if (method === "control") {
      result = await this.runEntryWrite(entry, () => this.runWithWriter(
        entry,
        clientId,
        params.sessionId || entry.supervisor.attachedSessionId,
        leaseToken,
        () => entry.supervisor.control(params),
      ));
      if (["disconnect", "stop_leader"].includes(params.action)) {
        this.releaseWriter(entry, clientId);
      } else {
        includeLeaseToken = true;
      }
    } else {
      throw errorWithCode(`Unknown Supervisor daemon method: ${method}`, "DAEMON_METHOD_NOT_FOUND");
    }

    if ((method === "open" && routingCwd) || !client.boundKey) client.boundKey = entry.key;
    return {
      result,
      entry,
      workspace: { key: entry.key, cwd: entry.cwd },
      includeLeaseToken,
    };
  }

  async route(request) {
    return (await this.routeRequest(request)).result;
  }

  async handleSocket(socket) {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      if (handled) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        handled = true;
        socket.end(responseLine({ id: null, ok: false, error: { message: "Daemon request exceeded 1 MiB", code: "DAEMON_REQUEST_TOO_LARGE" } }));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
        if (request?.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
          throw errorWithCode("Supervisor daemon protocol mismatch", "DAEMON_PROTOCOL_MISMATCH", {
            expected: DAEMON_PROTOCOL_VERSION,
            received: request?.protocolVersion ?? null,
          });
        }
        if (!secretsMatch(this.authToken, request.authToken)) {
          throw errorWithCode("Supervisor daemon authentication failed", "DAEMON_AUTH_FAILED");
        }
        const routed = await this.routeRequest(request);
        const lease = routed.entry?.writerLease || null;
        const responseLeaseToken = routed.includeLeaseToken
          && lease?.clientId === request.clientId
          && lease.expiresAt > this.now()
          ? lease.fencingToken
          : null;
        socket.end(responseLine({
          id: request.id,
          ok: true,
          result: routed.result,
          workspace: routed.workspace || null,
          leaseToken: responseLeaseToken,
        }));
      } catch (error) {
        socket.end(responseLine({ id: request?.id ?? null, ok: false, error: serializeError(error) }));
      }
    });
    socket.on("error", () => {});
  }

  async start() {
    if (this.server) {
      return this.info();
    }
    await this.registry.initialize();
    mkdirSync(this.paths.stateRoot, { recursive: true });
    if (process.platform !== "win32" && existsSync(this.paths.pipePath)) {
      const metadata = readJsonFile(this.paths.metadataPath);
      if (!metadata || !processIsAlive(metadata.pid)) {
        unlinkSync(this.paths.pipePath);
      }
    }
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        this.server = null;
        rejectListen(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolveListen();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.paths.pipePath);
    });
    writeJsonAtomic(this.paths.metadataPath, {
      schemaVersion: 1,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonInstanceId: this.daemonInstanceId,
      pid: process.pid,
      runtimeVersion: this.runtimeVersion,
      runtimeFingerprint: this.runtimeFingerprint,
      runtimeScript: this.runtimeScript,
      pipePathHash: createHash("sha256").update(this.paths.pipePath).digest("hex"),
      startedAt: new Date().toISOString(),
    });
    if (existsSync(this.paths.startupErrorPath)) {
      try {
        unlinkSync(this.paths.startupErrorPath);
      } catch {
        // A stale startup diagnostic does not affect the live daemon.
      }
    }
    return this.info();
  }

  info() {
    return {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonInstanceId: this.daemonInstanceId,
      pid: process.pid,
      runtimeVersion: this.runtimeVersion,
      runtimeFingerprint: this.runtimeFingerprint,
      runtimeScript: this.runtimeScript,
      capabilities: this.capabilities,
      pipePath: this.paths.pipePath,
    };
  }

  async stop() {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
    if (process.platform !== "win32" && existsSync(this.paths.pipePath)) {
      try {
        unlinkSync(this.paths.pipePath);
      } catch {
        // Best-effort removal of this daemon's Unix socket only.
      }
    }
    const metadata = readJsonFile(this.paths.metadataPath);
    if (metadata?.daemonInstanceId === this.daemonInstanceId) {
      try {
        unlinkSync(this.paths.metadataPath);
      } catch {
        // Metadata cleanup is non-critical.
      }
    }
  }
}

function connectionError(error, requestWritten = false) {
  error.requestWritten = requestWritten;
  return error;
}

export function sendDaemonRequest({
  paths,
  authToken,
  clientId,
  clientVersion,
  hostKind = "unknown",
  leaseToken = null,
  workspaceCwd = null,
  method,
  params,
  timeoutMs,
  onLeaseToken = null,
  onWorkspace = null,
}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const id = randomUUID();
    const socket = createConnection(paths.pipePath);
    let buffer = "";
    let settled = false;
    let requestWritten = false;
    const finishError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectRequest(connectionError(error, requestWritten));
    };
    const timer = setTimeout(() => finishError(errorWithCode(
      `Supervisor daemon request timed out after ${timeoutMs}ms`,
      "DAEMON_REQUEST_TIMEOUT",
    )), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const request = {
        id,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        authToken,
        clientId,
        clientVersion,
        hostKind: normalizeHostKind(hostKind),
        leaseToken,
        workspaceCwd,
        method,
        params,
      };
      requestWritten = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        finishError(errorWithCode("Supervisor daemon response exceeded 1 MiB", "DAEMON_RESPONSE_TOO_LARGE"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0 || settled) {
        return;
      }
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finishError(errorWithCode(`Invalid Supervisor daemon response: ${conciseError(error)}`, "DAEMON_INVALID_RESPONSE"));
        return;
      }
      if (response.id !== id) {
        finishError(errorWithCode("Supervisor daemon response ID mismatch", "DAEMON_RESPONSE_ID_MISMATCH"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (!response.ok) {
        const error = errorWithCode(response.error?.message || "Supervisor daemon request failed", response.error?.code || "DAEMON_REQUEST_FAILED", response.error?.details);
        error.requestWritten = true;
        rejectRequest(error);
        return;
      }
      if (response.workspace && typeof onWorkspace === "function") {
        onWorkspace({
          workspace: response.workspace,
          leaseToken: typeof response.leaseToken === "string" ? response.leaseToken : null,
        });
      } else if (typeof response.leaseToken === "string" && typeof onLeaseToken === "function") {
        onLeaseToken(response.leaseToken);
      }
      resolveRequest(response.result);
    });
    socket.on("error", finishError);
    socket.on("end", () => {
      if (!settled) {
        finishError(errorWithCode("Supervisor daemon closed before replying", "DAEMON_EARLY_CLOSE"));
      }
    });
  });
}

export class SupervisorClient {
  constructor(options = {}) {
    this.paths = options.paths || daemonPaths(options.stateRoot);
    this.clientId = options.clientId || randomUUID();
    this.clientVersion = options.clientVersion || readPluginVersion();
    this.hostKind = normalizeHostKind(options.hostKind || resolveHostKind(options.env || process.env));
    this.resultArtifactRoot = options.resultArtifactRoot || join(this.paths.stateRoot, "results");
    this.inlineResultMaxBytes = options.inlineResultMaxBytes ?? DEFAULT_INLINE_RESULT_MAX_BYTES;
    this.persistResultArtifact = options.persistResultArtifact || persistResultArtifact;
    this.daemonRuntime = options.daemonRuntime || (options.daemonScript ? null : materializeDaemonRuntime({
      daemonBundle: options.daemonBundle || DEFAULT_DAEMON_BUNDLE,
      sourceDirectory: options.daemonSourceDirectory || join(PLUGIN_ROOT, "scripts"),
      stateRoot: this.paths.stateRoot,
    }));
    this.daemonScript = resolve(options.daemonScript || this.daemonRuntime.daemonScript);
    this.daemonCwd = resolve(options.daemonCwd || this.daemonRuntime?.runtimeRoot || dirname(this.daemonScript));
    this.runtimeFingerprint = options.runtimeFingerprint || this.daemonRuntime?.fingerprint || null;
    this.spawnProcess = options.spawnProcess || spawn;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.workspaceCwd = typeof options.workspaceCwd === "string" && options.workspaceCwd.trim()
      ? resolve(options.workspaceCwd)
      : null;
    this.workspaceBinding = null;
    this.workspaceKeysByCwd = new Map();
    this.workspacesByKey = new Map();
    this.workspaceLeaseTokens = new Map();
    this.workspaceTokenSequences = new Map();
    this.requestSequence = 0;
    this.bindingSequence = 0;
    this.leaseToken = null;
    this.daemonInfo = null;
    this.nextUpgradeCheckAt = 0;
  }

  authToken() {
    return ensureDaemonAuth(this.paths);
  }

  requestTimeout(method, params = {}) {
    if (method === "inspect") {
      return Math.max(10_000, Math.min(Number(params.waitMs) || 0, 25_000) + 10_000);
    }
    if (method === "open") return 70_000;
    if (method === "initialize_proxy") return 45_000;
    return 30_000;
  }

  cwdIdentity(cwd) {
    if (!cwd) return null;
    const absolute = resolve(cwd);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }

  resultRootForWorkspace(params = {}) {
    const requestedCwd = typeof params.cwd === "string" && params.cwd.trim()
      ? resolve(params.cwd)
      : this.workspaceCwd || this.workspaceBinding?.cwd || null;
    const key = requestedCwd
      ? this.workspaceKeysByCwd.get(this.cwdIdentity(requestedCwd))
      : this.workspaceBinding?.key || null;
    return key && key !== "legacy"
      ? join(this.paths.stateRoot, "workspaces", key, "results")
      : this.resultArtifactRoot;
  }

  captureRequestContext(method, params = {}, workspaceOverride = undefined) {
    const sequence = ++this.requestSequence;
    const explicitCwd = typeof params.cwd === "string" && params.cwd.trim()
      ? resolve(params.cwd)
      : null;
    const globalMethod = new Set(["ping", "initialize_proxy", "upgrade_if_idle", "shutdown"])
      .has(method);
    const workspaceCwd = globalMethod
      ? null
      : workspaceOverride !== undefined
        ? workspaceOverride
        : explicitCwd || this.workspaceCwd || this.workspaceBinding?.cwd || null;
    const knownKey = workspaceCwd
      ? this.workspaceKeysByCwd.get(this.cwdIdentity(workspaceCwd))
        || (this.workspaceBinding?.cwd
          && this.cwdIdentity(this.workspaceBinding.cwd) === this.cwdIdentity(workspaceCwd)
          ? this.workspaceBinding.key
          : null)
      : this.workspaceBinding?.key || null;
    const leaseToken = method === "ping"
      ? null
      : (knownKey && this.workspaceLeaseTokens.get(knownKey))
        || (knownKey === this.workspaceBinding?.key ? this.leaseToken : null);
    return { sequence, explicitCwd, workspaceCwd, knownKey, leaseToken };
  }

  acceptWorkspaceResponse(context, { workspace, leaseToken }) {
    if (!workspace || typeof workspace.key !== "string") return;
    const canonicalCwd = typeof workspace.cwd === "string" && workspace.cwd
      ? resolve(workspace.cwd)
      : null;
    const normalized = { key: workspace.key, cwd: canonicalCwd };
    this.workspacesByKey.set(workspace.key, normalized);
    if (canonicalCwd) this.workspaceKeysByCwd.set(this.cwdIdentity(canonicalCwd), workspace.key);
    if (context.workspaceCwd) {
      this.workspaceKeysByCwd.set(this.cwdIdentity(context.workspaceCwd), workspace.key);
    }
    if (typeof leaseToken === "string") {
      const previousSequence = this.workspaceTokenSequences.get(workspace.key) || 0;
      if (context.sequence >= previousSequence) {
        this.workspaceLeaseTokens.set(workspace.key, leaseToken);
        this.workspaceTokenSequences.set(workspace.key, context.sequence);
      }
    }
    const explicitOpen = context.method === "open" && Boolean(context.explicitCwd);
    if ((!this.workspaceBinding || explicitOpen) && context.sequence >= this.bindingSequence) {
      this.workspaceBinding = normalized;
      this.workspaceCwd = canonicalCwd;
      this.bindingSequence = context.sequence;
    }
    if (this.workspaceBinding?.key === workspace.key) {
      this.leaseToken = this.workspaceLeaseTokens.get(workspace.key) || null;
    }
  }

  async requestOnce(
    method,
    params = {},
    timeoutMs = this.requestTimeout(method, params),
    frozenContext = null,
  ) {
    const context = frozenContext || this.captureRequestContext(method, params);
    context.method = method;
    const result = await sendDaemonRequest({
      paths: this.paths,
      authToken: this.authToken(),
      clientId: this.clientId,
      clientVersion: this.clientVersion,
      hostKind: this.hostKind,
      leaseToken: context.leaseToken,
      workspaceCwd: context.workspaceCwd,
      method,
      params,
      timeoutMs,
      onLeaseToken: (token) => {
        if (!context.knownKey) this.leaseToken = token;
      },
      onWorkspace: (response) => this.acceptWorkspaceResponse(context, response),
    });
    if (method === "control" && ["disconnect", "stop_leader"].includes(params.action)) {
      const key = context.knownKey || this.workspaceBinding?.key;
      if (key) {
        this.workspaceLeaseTokens.delete(key);
        this.workspaceTokenSequences.set(key, context.sequence);
      }
      if (this.workspaceBinding?.key === key) this.leaseToken = null;
    }
    return result;
  }

  launchDaemon() {
    const args = [
      this.daemonScript,
      "--state-root", this.paths.stateRoot,
      "--runtime-version", this.clientVersion,
    ];
    if (this.runtimeFingerprint) {
      args.push("--runtime-fingerprint", this.runtimeFingerprint);
    }
    const child = this.spawnProcess(process.execPath, args, {
      cwd: this.daemonCwd,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, GROK_SUPERVISOR_STATE_ROOT: this.paths.stateRoot },
    });
    child.unref();
    return child.pid;
  }

  async ensureDaemon() {
    try {
      const info = await this.requestOnce("ping", {}, 1500);
      return this.ensureRuntimeVersion(info);
    } catch (error) {
      if (error.requestWritten && !["ECONNREFUSED", "ENOENT", "EPIPE", "DAEMON_EARLY_CLOSE"].includes(error.code)) {
        throw error;
      }
    }
    this.launchDaemon();
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, CONNECTION_RETRY_MS));
      try {
        const info = await this.requestOnce("ping", {}, 1500);
        return this.ensureRuntimeVersion(info);
      } catch (error) {
        lastError = error;
      }
    }
    const startupError = readJsonFile(this.paths.startupErrorPath);
    throw errorWithCode(
      `Supervisor daemon did not become ready: ${startupError?.message || conciseError(lastError)}`,
      "DAEMON_START_FAILED",
      { startupError: startupError || null },
    );
  }

  async ensureRuntimeVersion(info) {
    this.daemonInfo = info;
    const versionCurrent = info?.runtimeVersion === this.clientVersion;
    const fingerprintCurrent = !info?.runtimeFingerprint
      || !this.runtimeFingerprint
      || info.runtimeFingerprint === this.runtimeFingerprint;
    if (!info || (versionCurrent && fingerprintCurrent)
      || info.runtimeVersion === "unknown" || this.clientVersion === "unknown"
      || Date.now() < this.nextUpgradeCheckAt) {
      return info;
    }
    const upgrade = await this.requestOnce("upgrade_if_idle", {
      confirmation: "RESTART_IDLE_SUPERVISOR_DAEMON",
      targetVersion: this.clientVersion,
      targetFingerprint: this.runtimeFingerprint,
    }, 5000);
    if (!upgrade.restarting) {
      this.nextUpgradeCheckAt = Date.now() + 60_000;
      return info;
    }
    this.leaseToken = null;
    this.workspaceLeaseTokens.clear();
    this.workspaceTokenSequences.clear();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError = null;
    let nextLaunchAt = 0;
    while (Date.now() < deadline) {
      if (Date.now() >= nextLaunchAt) {
        this.launchDaemon();
        nextLaunchAt = Date.now() + 500;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, CONNECTION_RETRY_MS));
      try {
        const restarted = await this.requestOnce("ping", {}, 1500);
        if (restarted.runtimeVersion !== this.clientVersion
          || (restarted.runtimeFingerprint && this.runtimeFingerprint
            && restarted.runtimeFingerprint !== this.runtimeFingerprint)) {
          continue;
        }
        this.daemonInfo = restarted;
        this.nextUpgradeCheckAt = 0;
        return restarted;
      } catch (error) {
        lastError = error;
      }
    }
    throw errorWithCode(
      `Supervisor daemon upgrade did not become ready: ${conciseError(lastError)}`,
      "DAEMON_UPGRADE_FAILED",
    );
  }

  async call(method, params = {}) {
    await this.ensureDaemon();
    const context = this.captureRequestContext(method, params);
    try {
      return await this.requestOnce(method, params, this.requestTimeout(method, params), context);
    } catch (error) {
      if (error.requestWritten) {
        throw error;
      }
      await this.ensureDaemon();
      return this.requestOnce(method, params, this.requestTimeout(method, params), context);
    }
  }

  async requireDaemonCapability(capability, code, message) {
    this.nextUpgradeCheckAt = 0;
    const info = await this.ensureDaemon();
    if (info?.capabilities?.[capability] !== true) {
      throw errorWithCode(message, code, {
        capability,
        runtimeVersion: info?.runtimeVersion || null,
        targetVersion: this.clientVersion,
      });
    }
    return info;
  }

  async inspect(params = {}) {
    if (params.cwd || this.workspaceCwd) {
      await this.requireDaemonCapability(
        "multiWorkspaceSessions",
        "GROK_INSPECT_REQUIRES_IDLE_UPGRADE",
        "The active Supervisor daemon cannot safely route inspection to an explicit workspace; exit the visible Grok TUI normally, then retry",
      );
    }
    const result = await this.call("inspect", params);
    return coalesceInteractionResult(result, params, {
      resultArtifactRoot: this.resultRootForWorkspace(params),
      inlineResultMaxBytes: this.inlineResultMaxBytes,
      persistResultArtifact: this.persistResultArtifact,
    });
  }

  initializeProxy(params = {}) {
    return this.requireDaemonCapability(
      "proxyInitialization",
      "GROK_INIT_REQUIRES_IDLE_UPGRADE",
      "The active Supervisor daemon predates /grok_init; exit the visible Grok TUI normally, then run /grok_init again",
    ).then(() => this.call("initialize_proxy", params));
  }

  async openSession(params) {
    await this.requireDaemonCapability(
      "sessionOpenV2",
      "GROK_OPEN_REQUIRES_IDLE_UPGRADE",
      "The active Supervisor daemon cannot safely open a new TUI after a plugin cache refresh; exit the existing visible TUI normally, then retry",
    );
    if (params.cwd || this.workspaceCwd) {
      await this.requireDaemonCapability(
        "multiWorkspaceSessions",
        "GROK_MULTIWORKSPACE_REQUIRES_IDLE_UPGRADE",
        "The active Supervisor daemon cannot safely route an explicit workspace; exit the visible Grok TUI normally, then retry after the daemon upgrade",
      );
    }
    return this.call("open", params);
  }

  async startPrompt(params) {
    if (params.cwd || this.workspaceCwd) {
      await this.requireDaemonCapability(
        "multiWorkspaceSessions",
        "GROK_MULTIWORKSPACE_REQUIRES_IDLE_UPGRADE",
        "The active Supervisor daemon cannot safely route this prompt to an explicit workspace; exit the visible Grok TUI normally, then retry",
      );
    }
    if (this.hostKind === "codex") {
      return this.call("prompt", params);
    }
    await this.requireDaemonCapability(
      "hostIdentityEnvelope",
      "GROK_HOST_IDENTITY_UPGRADE_REQUIRED",
      "The active Supervisor daemon cannot preserve the current host identity; exit the visible Grok TUI normally, then retry after the daemon upgrade",
    );
    return this.call("prompt", params);
  }

  async respond(params) {
    if (params.cwd || this.workspaceCwd) {
      await this.requireDaemonCapability(
        "multiWorkspaceSessions",
        "GROK_MULTIWORKSPACE_REQUIRES_IDLE_UPGRADE",
        "The active Supervisor daemon cannot safely route this response to an explicit workspace; exit the visible Grok TUI normally, then retry",
      );
    }
    return this.call("respond", params);
  }

  async control(params) {
    if (params.cwd || this.workspaceCwd) {
      await this.requireDaemonCapability(
        "multiWorkspaceSessions",
        "GROK_MULTIWORKSPACE_REQUIRES_IDLE_UPGRADE",
        "The active Supervisor daemon cannot safely route this control request to an explicit workspace; exit the visible Grok TUI normally, then retry",
      );
    }
    return this.call("control", params);
  }

  ping() {
    return this.call("ping", {});
  }

  shutdownIdleDaemon() {
    return this.call("shutdown", { confirmation: "STOP_IDLE_SUPERVISOR_DAEMON" });
  }

  async detach() {
    const scopes = [...this.workspaceLeaseTokens.entries()].map(([key, token]) => ({
      key,
      token,
      cwd: this.workspacesByKey.get(key)?.cwd || (this.workspaceBinding?.key === key ? this.workspaceBinding.cwd : null),
    }));
    if (scopes.length === 0) {
      scopes.push({
        key: this.workspaceBinding?.key || null,
        token: this.leaseToken,
        cwd: this.workspaceBinding?.cwd || this.workspaceCwd || null,
      });
    }
    let releasedWriters = 0;
    let lastResult = null;
    try {
      for (const scope of scopes) {
        const context = this.captureRequestContext("client_disconnect", {}, scope.cwd);
        context.method = "client_disconnect";
        context.knownKey = scope.key;
        context.leaseToken = scope.token;
        lastResult = await this.requestOnce("client_disconnect", {}, 2000, context);
        if (lastResult.releasedWriter) releasedWriters += 1;
      }
      return {
        ...(lastResult || { disconnected: true, releasedWriter: false }),
        releasedWriter: releasedWriters > 0,
        releasedWriters,
      };
    } finally {
      this.leaseToken = null;
      this.workspaceLeaseTokens.clear();
      this.workspaceTokenSequences.clear();
    }
  }
}

export function writeDaemonStartupError(stateRoot, error) {
  const paths = daemonPaths(stateRoot);
  mkdirSync(paths.stateRoot, { recursive: true });
  writeJsonAtomic(paths.startupErrorPath, {
    schemaVersion: 1,
    message: conciseError(error),
    code: typeof error?.code === "string" ? error.code : null,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });
}

export function daemonMetadataIsLive(stateRoot = defaultStateRoot()) {
  const metadata = readJsonFile(daemonPaths(stateRoot).metadataPath);
  return Boolean(metadata && processIsAlive(metadata.pid));
}
