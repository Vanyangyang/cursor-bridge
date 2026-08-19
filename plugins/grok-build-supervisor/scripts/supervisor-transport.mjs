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
  return {
    ...result,
    run,
    progress: working ? {
      status: "streaming",
      newActivity: latestSequence > afterSequence,
      contentSuppressed: true,
      coalesced: originalCursor.hasMore === true,
    } : null,
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
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now || (() => Date.now());
    this.daemonInstanceId = options.daemonInstanceId || randomUUID();
    this.server = null;
    this.writerLease = null;
    this.clients = new Map();
    this.stopping = false;
    this.initializingProxy = false;
  }

  leaseSnapshot(clientId = null) {
    const lease = this.writerLease;
    const active = Boolean(lease && lease.expiresAt > this.now());
    return {
      active,
      ownedByClient: active && lease.clientId === clientId,
      sessionId: active ? lease.sessionId : null,
      expiresAt: active ? new Date(lease.expiresAt).toISOString() : null,
    };
  }

  touchClient(clientId, leaseToken = null) {
    const now = this.now();
    this.clients.set(clientId, now);
    if (this.writerLease?.clientId === clientId && this.writerLease.fencingToken === leaseToken) {
      this.writerLease.expiresAt = now + this.leaseMs;
    }
  }

  acquireWriter(clientId, sessionId = null, leaseToken = null) {
    const now = this.now();
    const lease = this.writerLease;
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
      lease.sessionId = sessionId || lease.sessionId;
      lease.expiresAt = now + this.leaseMs;
      return lease;
    }
    if (!lease || lease.expiresAt <= now) {
      this.writerLease = {
        clientId,
        sessionId,
        fencingToken: randomUUID(),
        acquiredAt: now,
        expiresAt: now + this.leaseMs,
      };
    }
    return this.writerLease;
  }

  requireWriter(clientId, sessionId = null, leaseToken = null) {
    const lease = this.acquireWriter(clientId, sessionId, leaseToken);
    if (sessionId && lease.sessionId && lease.sessionId !== sessionId) {
      throw errorWithCode(
        `Writer lease is bound to ${lease.sessionId}, not ${sessionId}`,
        "GROK_WRITER_SESSION_MISMATCH",
      );
    }
    lease.sessionId = sessionId || lease.sessionId;
    return lease;
  }

  releaseWriter(clientId) {
    if (this.writerLease?.clientId === clientId) {
      this.writerLease = null;
      return true;
    }
    return false;
  }

  async daemonBusyState() {
    const status = await this.supervisor.status();
    const liveTuis = (status.recordedTuis || []).filter((item) =>
      item.processAlive === true
      && item.activeRegistryMatch === true
      && item.leaderOwnershipMatch === true
      && item.processIdentityMatch !== false);
    const ownedLiveTuiCount = Array.isArray(status.ownedVisibleTuiPids)
      ? status.ownedVisibleTuiPids.length
      : 0;
    return {
      busy: Boolean(
        status.acpConnected
        || status.attachedSessionId
        || status.activeRun?.status === "running"
        || status.pendingPermissions?.length
        || status.pendingElicitations?.length
        || liveTuis.length
        || ownedLiveTuiCount
      ),
      status,
      liveTuiCount: liveTuis.length,
      ownedLiveTuiCount,
    };
  }

  async route({ clientId, clientVersion, hostKind = "unknown", leaseToken = null, method, params = {} }) {
    if (typeof clientId !== "string" || clientId.length > 128) {
      throw errorWithCode("A bounded clientId is required", "DAEMON_INVALID_CLIENT");
    }
    this.touchClient(clientId, leaseToken);
    const requesterHostKind = normalizeHostKind(hostKind);
    if (method === "ping") {
      return {
        ok: true,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        daemonInstanceId: this.daemonInstanceId,
        daemonPid: process.pid,
        runtimeVersion: this.runtimeVersion,
        runtimeFingerprint: this.runtimeFingerprint,
        runtimeScript: this.runtimeScript,
        capabilities: this.capabilities,
        clientVersion: clientVersion || null,
        writer: this.leaseSnapshot(clientId),
      };
    }
    if (method === "client_disconnect") {
      const released = Boolean(this.writerLease
        && this.writerLease.clientId === clientId
        && this.writerLease.fencingToken === leaseToken
        && this.releaseWriter(clientId));
      this.clients.delete(clientId);
      return { disconnected: true, releasedWriter: released };
    }
    if (method === "initialize_proxy") {
      if (this.initializingProxy) {
        throw errorWithCode("Another Grok proxy initialization is already running", "GROK_INIT_BUSY");
      }
      const state = await this.daemonBusyState();
      if (state.busy || state.status.leader?.running === true) {
        throw errorWithCode(
          "Grok proxy cannot be reinitialized while the Supervisor owns an active Leader, TUI, ACP session, or prompt",
          "GROK_INIT_BUSY",
          {
            attachedSessionId: state.status.attachedSessionId || null,
            activeRun: state.status.activeRun?.status || null,
            leaderRunning: state.status.leader?.running === true,
            liveTuiCount: state.liveTuiCount,
          },
        );
      }
      this.initializingProxy = true;
      try {
        return await this.supervisor.initializeProxy(params);
      } finally {
        this.initializingProxy = false;
      }
    }
    if (method === "inspect") {
      const result = await this.supervisor.inspect(params);
      if (result?.view === "status" && result.status) {
        result.status.daemon = {
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          instanceId: this.daemonInstanceId,
          pid: process.pid,
          runtimeVersion: this.runtimeVersion,
          runtimeFingerprint: this.runtimeFingerprint,
          runtimeScript: this.runtimeScript,
          capabilities: this.capabilities,
          writer: this.leaseSnapshot(clientId),
        };
      }
      return result;
    }
    if (method === "open") {
      const previousLease = this.writerLease ? { ...this.writerLease } : null;
      this.acquireWriter(clientId, params.sessionId || null, leaseToken);
      try {
        const result = await this.supervisor.openSession(params);
        this.writerLease.sessionId = result.sessionId;
        this.touchClient(clientId, this.writerLease.fencingToken);
        return result;
      } catch (error) {
        this.writerLease = previousLease;
        throw error;
      }
    }
    if (method === "prompt") {
      this.requireWriter(clientId, params.sessionId, leaseToken);
      return this.supervisor.startPrompt({ ...params, hostKind: requesterHostKind });
    }
    if (method === "respond") {
      this.requireWriter(clientId, this.supervisor.attachedSessionId, leaseToken);
      return this.supervisor.respond(params);
    }
    if (method === "control") {
      this.requireWriter(clientId, params.sessionId || this.supervisor.attachedSessionId, leaseToken);
      const result = await this.supervisor.control(params);
      if (["disconnect", "stop_leader"].includes(params.action)) {
        this.releaseWriter(clientId);
      }
      return result;
    }
    if (method === "upgrade_if_idle") {
      if (params.confirmation !== "RESTART_IDLE_SUPERVISOR_DAEMON") {
        throw errorWithCode("Invalid daemon upgrade confirmation", "DAEMON_UPGRADE_REFUSED");
      }
      const versionCurrent = params.targetVersion === this.runtimeVersion;
      const fingerprintCurrent = !params.targetFingerprint
        || !this.runtimeFingerprint
        || params.targetFingerprint === this.runtimeFingerprint;
      if (versionCurrent && fingerprintCurrent) {
        return {
          restarting: false,
          alreadyCurrent: true,
          runtimeVersion: this.runtimeVersion,
          runtimeFingerprint: this.runtimeFingerprint,
        };
      }
      const idle = await this.daemonBusyState();
      if (idle.busy) {
        return {
          restarting: false,
          busy: true,
          runtimeVersion: this.runtimeVersion,
          runtimeFingerprint: this.runtimeFingerprint,
          targetVersion: params.targetVersion || null,
          targetFingerprint: params.targetFingerprint || null,
        };
      }
      await this.supervisor.disconnect().catch(() => {});
      setTimeout(() => this.stop(), 10);
      return {
        restarting: true,
        runtimeVersion: this.runtimeVersion,
        runtimeFingerprint: this.runtimeFingerprint,
        targetVersion: params.targetVersion || null,
        targetFingerprint: params.targetFingerprint || null,
      };
    }
    if (method === "shutdown") {
      if (params.confirmation !== "STOP_IDLE_SUPERVISOR_DAEMON") {
        throw errorWithCode("Invalid daemon shutdown confirmation", "DAEMON_SHUTDOWN_REFUSED");
      }
      const idle = await this.daemonBusyState();
      if (idle.busy) {
        throw errorWithCode(
          "Supervisor daemon is not idle; refusing shutdown",
          "DAEMON_NOT_IDLE",
          { activeRun: idle.status.activeRun?.status || null, liveTuiCount: idle.liveTuiCount },
        );
      }
      await this.supervisor.disconnect().catch(() => {});
      setTimeout(() => this.stop(), 10);
      return { shuttingDown: true, daemonInstanceId: this.daemonInstanceId };
    }
    throw errorWithCode(`Unknown Supervisor daemon method: ${method}`, "DAEMON_METHOD_NOT_FOUND");
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
        const leaseBefore = this.writerLease ? { ...this.writerLease } : null;
        const routeStartedAt = this.now();
        const result = await this.route(request);
        const lease = this.leaseSnapshot(request.clientId);
        const leaseGrantedNow = lease.ownedByClient && (
          !leaseBefore
          || leaseBefore.expiresAt <= routeStartedAt
          || leaseBefore.clientId !== request.clientId
          || leaseBefore.fencingToken !== this.writerLease?.fencingToken
        );
        const leaseTokenAccepted = lease.ownedByClient
          && request.leaseToken === this.writerLease?.fencingToken;
        socket.end(responseLine({
          id: request.id,
          ok: true,
          result,
          leaseToken: leaseGrantedNow || leaseTokenAccepted ? this.writerLease.fencingToken : null,
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

export function sendDaemonRequest({ paths, authToken, clientId, clientVersion, hostKind = "unknown", leaseToken = null, method, params, timeoutMs, onLeaseToken = null }) {
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
      if (typeof response.leaseToken === "string" && typeof onLeaseToken === "function") {
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

  async requestOnce(method, params = {}, timeoutMs = this.requestTimeout(method, params)) {
    return sendDaemonRequest({
      paths: this.paths,
      authToken: this.authToken(),
      clientId: this.clientId,
      clientVersion: this.clientVersion,
      hostKind: this.hostKind,
      leaseToken: this.leaseToken,
      method,
      params,
      timeoutMs,
      onLeaseToken: (token) => { this.leaseToken = token; },
    });
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
    try {
      return await this.requestOnce(method, params);
    } catch (error) {
      if (error.requestWritten) {
        throw error;
      }
      await this.ensureDaemon();
      return this.requestOnce(method, params);
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
    const result = await this.call("inspect", params);
    return coalesceInteractionResult(result, params, {
      resultArtifactRoot: this.resultArtifactRoot,
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

  openSession(params) {
    return this.requireDaemonCapability(
      "sessionOpenV2",
      "GROK_OPEN_REQUIRES_IDLE_UPGRADE",
      "The active Supervisor daemon cannot safely open a new TUI after a plugin cache refresh; exit the existing visible TUI normally, then retry",
    ).then(() => this.call("open", params));
  }

  startPrompt(params) {
    if (this.hostKind === "codex") {
      return this.call("prompt", params);
    }
    return this.requireDaemonCapability(
      "hostIdentityEnvelope",
      "GROK_HOST_IDENTITY_UPGRADE_REQUIRED",
      "The active Supervisor daemon cannot preserve the current host identity; exit the visible Grok TUI normally, then retry after the daemon upgrade",
    ).then(() => this.call("prompt", params));
  }

  respond(params) {
    return this.call("respond", params);
  }

  control(params) {
    return this.call("control", params);
  }

  ping() {
    return this.call("ping", {});
  }

  shutdownIdleDaemon() {
    return this.call("shutdown", { confirmation: "STOP_IDLE_SUPERVISOR_DAEMON" });
  }

  async detach() {
    try {
      return await this.requestOnce("client_disconnect", {}, 2000);
    } finally {
      this.leaseToken = null;
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
