/**
 * Adapter-side client for the user-level Cursor lifecycle supervisor.
 * Creates the singleton on first use (job-breakaway on Windows), then reuses IPC.
 */
import net from 'node:net';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, win32 as win32Path } from 'node:path';
import {
  defaultLifecycleDir,
  ensureLifecycleDir,
  supervisorSockPath,
  supervisorPidPath,
  supervisorLockPath,
} from './lifecycle-paths.mjs';
import { spawnNodeOutsideJob, spawnOutsideJob, whichNode } from './win-job-breakaway.mjs';

const DEFAULT_CREATE_WAIT_MS = 20000;
const DEFAULT_ACL_NORMALIZATION_WAIT_MS = 10000;

export function resolveSupervisorSpawnCwd({
  requestedCwd = null,
  runtimeRoot = null,
  nodeExecutable = whichNode(),
  platform = process.platform,
} = {}) {
  if (requestedCwd) return requestedCwd;
  if (platform === 'win32') {
    const nodeDir = win32Path.dirname(String(nodeExecutable || ''));
    if (win32Path.isAbsolute(nodeDir)) return nodeDir;
  }
  return runtimeRoot;
}

export async function normalizeLifecycleTreeOutsideJob(dir, runtimeRoot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { method: 'not-required', stateRoot: dirname(dir) };

  const existsImpl = options.existsImpl || existsSync;
  const systemRoot = String(options.systemRoot || process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
  const icacls = options.icaclsExecutable || win32Path.join(systemRoot, 'System32', 'icacls.exe');
  const commandInterpreter = options.commandInterpreter || win32Path.join(systemRoot, 'System32', 'cmd.exe');
  if (!existsImpl(icacls) || !existsImpl(commandInterpreter)) {
    throw lifecycleClientError('Windows ACL normalization tools are unavailable for lifecycle bootstrap', {
      errorKind: 'configuration',
      degradedReason: 'lifecycle-acl-tools-missing',
      errorCode: 'ENOENT',
      canAttachFallback: false,
    });
  }

  const env = options.env || process.env;
  const user = String(options.userIdentity || [env.USERDOMAIN, env.USERNAME].filter(Boolean).join('\\') || env.USER || '').trim();
  if (!user) {
    throw lifecycleClientError('Current Windows user identity is unavailable for lifecycle ACL normalization', {
      errorKind: 'configuration',
      degradedReason: 'lifecycle-acl-user-missing',
      errorCode: null,
      canAttachFallback: false,
    });
  }

  const nodeExecutable = options.nodeExecutable || whichNode();
  const spawnCwd = resolveSupervisorSpawnCwd({ runtimeRoot, nodeExecutable, platform });
  const stateRoot = options.stateRoot || dirname(dir);
  const spawnImpl = options.spawnOutsideJobImpl || spawnOutsideJob;
  const normalized = spawnImpl(icacls, [
    stateRoot,
    '/inheritance:r',
    '/grant:r',
    `${user}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
    '/T',
    '/C',
    '/Q',
  ], { cwd: spawnCwd, env });
  if (!normalized.ok) {
    throw lifecycleClientError(`failed to normalize lifecycle ACLs outside the Codex sandbox: ${normalized.error || normalized.method}`, {
      errorKind: normalized.errorKind || 'unknown',
      degradedReason: normalized.degradedReason || 'lifecycle-acl-normalization-failed',
      errorCode: normalized.errorCode ?? null,
      returnValue: normalized.returnValue ?? null,
      canAttachFallback: normalized.canAttachFallback === true,
      commandLine: normalized.commandLine || null,
      spawnCwd: normalized.spawnCwd || spawnCwd || null,
      stderr: normalized.stderr || null,
      attempts: normalized.attempts ?? null,
    });
  }

  const probeImpl = options.probeOutsideJobImpl || ((cwd) => spawnOutsideJob(
    commandInterpreter,
    ['/d', '/c', 'exit', '0'],
    { cwd, env },
  ));
  const sleepImpl = options.sleepImpl || sleep;
  const waitMs = Math.max(500, Number(options.waitMs || DEFAULT_ACL_NORMALIZATION_WAIT_MS));
  const deadline = Date.now() + waitMs;
  let lastProbe = null;
  while (Date.now() < deadline) {
    lastProbe = probeImpl(runtimeRoot);
    if (lastProbe && lastProbe.ok) {
      return {
        method: normalized.method,
        pid: normalized.pid || null,
        spawnCwd: normalized.spawnCwd || spawnCwd || null,
        stateRoot,
        probeMethod: lastProbe.method || null,
      };
    }
    await sleepImpl(100);
  }
  throw lifecycleClientError(`lifecycle ACL normalization did not make ${runtimeRoot} reachable within ${waitMs}ms`, {
    errorKind: 'bootstrap-failed',
    degradedReason: 'lifecycle-acl-normalization-timeout',
    errorCode: lastProbe && (lastProbe.errorCode ?? lastProbe.returnValue) || null,
    canAttachFallback: true,
    commandLine: normalized.commandLine || null,
    spawnCwd: normalized.spawnCwd || spawnCwd || null,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function resolveSupervisorScript() {
  if (process.env.CURSOR_BRIDGE_SUPERVISOR_SCRIPT && existsSync(process.env.CURSOR_BRIDGE_SUPERVISOR_SCRIPT)) {
    return resolve(process.env.CURSOR_BRIDGE_SUPERVISOR_SCRIPT);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  if (typeof process.argv[1] === 'string') {
    const entryDir = dirname(resolve(process.argv[1]));
    candidates.push(join(entryDir, 'dist', 'cursor-lifecycle-supervisor.mjs'));
    candidates.push(join(entryDir, 'cursor-lifecycle-supervisor.mjs'));
  }
  candidates.push(
    join(here, 'dist', 'cursor-lifecycle-supervisor.mjs'),
    join(here, 'cursor-lifecycle-supervisor.mjs'),
  );
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(here, 'cursor-lifecycle-supervisor.mjs');
}

function writeRuntimeFile(target, content) {
  if (existsSync(target) && readFileSync(target).equals(content)) return;
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content);
  try {
    renameSync(temporary, target);
  } catch (error) {
    if (!existsSync(target)) {
      rmSync(temporary, { force: true });
      throw error;
    }
    if (readFileSync(target).equals(content)) {
      rmSync(temporary, { force: true });
      return;
    }
    rmSync(target, { force: true });
    renameSync(temporary, target);
  }
}

export function materializeLifecycleSupervisorRuntime({ sourceScript, dir = defaultLifecycleDir() } = {}) {
  const described = describeLifecycleSupervisorRuntime({ sourceScript, dir });
  const { sourceScript: source, content, fingerprint } = described;
  const runtimeRoot = join(ensureLifecycleDir(dir), 'runtime', `supervisor-${fingerprint.slice(0, 20)}`);
  mkdirSync(runtimeRoot, { recursive: true });
  const script = join(runtimeRoot, 'cursor-lifecycle-supervisor.mjs');
  writeRuntimeFile(script, content);
  return { sourceScript: source, script, runtimeRoot, fingerprint };
}

export function describeLifecycleSupervisorRuntime({ sourceScript, dir = defaultLifecycleDir() } = {}) {
  const source = resolve(sourceScript || resolveSupervisorScript());
  if (!existsSync(source)) throw new Error(`lifecycle supervisor script missing: ${source}`);
  const content = readFileSync(source);
  const fingerprint = createHash('sha256').update(content).digest('hex');
  const runtimeRoot = join(dir, 'runtime', `supervisor-${fingerprint.slice(0, 20)}`);
  const script = join(runtimeRoot, 'cursor-lifecycle-supervisor.mjs');
  return { sourceScript: source, script, runtimeRoot, fingerprint, content };
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(pidPath) {
  try {
    const n = Number(String(readFileSync(pidPath, 'utf8')).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function connectSupervisor(sock, timeoutMs = 8000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(sock);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      reject(new Error(`supervisor connect timeout (${timeoutMs}ms) sock=${sock}`));
    }, timeoutMs);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(socket);
    });
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function request(socket, payload, timeoutMs = 120000) {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    let settled = false;
    const id = payload.id || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message = { ...payload, id };

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      clearTimeout(timer);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        finish(resolvePromise, msg);
        return;
      }
    };
    const onError = (error) => finish(reject, error);
    const onClose = () => finish(reject, new Error('supervisor socket closed before response'));
    const timer = setTimeout(() => finish(reject, new Error(`supervisor request timeout id=${id}`)), timeoutMs);

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.write(`${JSON.stringify(message)}\n`);
  });
}

async function tryConnect(sock) {
  try {
    return await connectSupervisor(sock, 1500);
  } catch {
    return null;
  }
}

async function tryConnectDetailed(sock, connectImpl = connectSupervisor) {
  try {
    return { socket: await connectImpl(sock, 1500), error: null };
  } catch (error) {
    return { socket: null, error };
  }
}

function lifecycleClientError(message, details = {}, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  Object.assign(error, details);
  return error;
}

function filesystemFallbackDetails(error) {
  const code = error && typeof error === 'object' && error.code != null ? String(error.code) : null;
  const blocked = code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
  return {
    errorKind: blocked ? 'policy-blocked' : 'configuration',
    degradedReason: blocked ? 'fs-policy-blocked' : null,
    errorCode: code,
    canAttachFallback: blocked,
  };
}

function tryUnlink(path) {
  try { if (path && existsSync(path)) unlinkSync(path); } catch {}
}

export function writeBootEnv(dir, extra = {}) {
  const bootPath = join(dir, `boot-env-${process.pid}-${Date.now()}.json`);
  const payload = { ...extra };
  // WMI Win32_Process.Create does not inherit adapter env; forward bridge knobs via boot-env.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CURSOR_BRIDGE_') || key === 'CURSOR_PROJECT_PATH' || key === 'CURSOR_EXE') {
      payload[key] = value;
    }
  }
  const cleaned = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v != null && v !== '') cleaned[k] = String(v);
  }
  writeFileSync(bootPath, `${JSON.stringify(cleaned, null, 2)}\n`, { encoding: 'utf8' });
  return bootPath;
}

export function listBootEnvFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.startsWith('boot-env-') && name.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Ensure a supervisor is reachable. Creates one outside the Windows job if needed.
 */
export async function ensureSupervisorConnected(options = {}) {
  const dir = options.dir || defaultLifecycleDir();
  const sock = options.sock || supervisorSockPath(dir);
  const pidPath = options.pidPath || supervisorPidPath(dir);
  const lockPath = options.lockPath || supervisorLockPath(dir);
  const createWaitMs = Number(options.createWaitMs || DEFAULT_CREATE_WAIT_MS);
  const sourceScript = options.supervisorScript || resolveSupervisorScript();
  const connectImpl = options.connectSupervisorImpl || connectSupervisor;
  const initialConnection = await tryConnectDetailed(sock, connectImpl);
  let socket = initialConnection.socket;
  if (socket) {
    const pid = readPidFile(pidPath);
    let current = null;
    try {
      current = await request(socket, { type: 'ping' }, 5000);
    } catch (error) {
      try { socket.destroy(); } catch {}
      throw lifecycleClientError(`lifecycle supervisor is reachable but unresponsive: ${error instanceof Error ? error.message : String(error)}`, {
        errorKind: 'supervisor-unresponsive',
        degradedReason: 'supervisor-unresponsive',
        errorCode: error && typeof error === 'object' && error.code != null ? String(error.code) : null,
        canAttachFallback: true,
      }, error);
    }
    let targetRuntime = null;
    try {
      targetRuntime = options.persistSupervisorRuntime === false
        ? {
            sourceScript: resolve(sourceScript),
            script: resolve(sourceScript),
            runtimeRoot: dirname(resolve(sourceScript)),
            fingerprint: null,
          }
        : describeLifecycleSupervisorRuntime({ sourceScript, dir });
    } catch {
      // A healthy existing supervisor is usable even when the current plugin source
      // cannot be read from this sandbox. Do not turn reuse into a filesystem write/read gate.
    }
    const mismatch = Boolean(targetRuntime?.fingerprint
      && current?.runtimeFingerprint
      && current.runtimeFingerprint !== targetRuntime.fingerprint);
    return {
      socket,
      sock,
      dir,
      supervisorPid: pid,
      reusedSupervisor: true,
      createdSupervisor: false,
      spawnMethod: null,
      runtimeFingerprint: current?.runtimeFingerprint || null,
      runtimeScript: current?.runtimeScript || null,
      targetRuntimeFingerprint: targetRuntime?.fingerprint || null,
      runtimeUpgradeDeferred: mismatch,
    };
  }

  const connectCode = initialConnection.error && typeof initialConnection.error === 'object'
    ? String(initialConnection.error.code || '')
    : '';
  const connectMessage = initialConnection.error instanceof Error ? initialConnection.error.message : String(initialConnection.error || '');
  if (connectCode === 'EPERM' || connectCode === 'EACCES') {
    throw lifecycleClientError(`lifecycle supervisor pipe access was blocked: ${connectMessage || connectCode}`, {
      errorKind: 'policy-blocked',
      degradedReason: 'pipe-policy-blocked',
      errorCode: connectCode,
      canAttachFallback: true,
    }, initialConnection.error);
  }
  const normalAbsenceCodes = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE']);
  if (initialConnection.error && (!normalAbsenceCodes.has(connectCode) || /connect timeout/i.test(connectMessage))) {
    throw lifecycleClientError(`lifecycle supervisor pipe is unavailable without a clean absence signal: ${connectMessage || connectCode || 'unknown connect error'}`, {
      errorKind: 'supervisor-unresponsive',
      degradedReason: 'supervisor-unresponsive',
      errorCode: connectCode || null,
      canAttachFallback: true,
    }, initialConnection.error);
  }

  let runtime;
  try {
    ensureLifecycleDir(dir);
    runtime = options.persistSupervisorRuntime === false
      ? {
          sourceScript: resolve(sourceScript),
          script: resolve(sourceScript),
          runtimeRoot: dirname(resolve(sourceScript)),
          fingerprint: null,
        }
      : (options.materializeRuntimeImpl || materializeLifecycleSupervisorRuntime)({ sourceScript, dir });
  } catch (error) {
    throw lifecycleClientError(`failed to prepare lifecycle supervisor runtime: ${error instanceof Error ? error.message : String(error)}`, filesystemFallbackDetails(error), error);
  }

  const stalePid = readPidFile(pidPath);
  if (stalePid && !isProcessAlive(stalePid)) {
    tryUnlink(pidPath);
    tryUnlink(lockPath);
    if (process.platform !== 'win32') {
      tryUnlink(sock);
    }
  }

  const script = runtime.script;
  if (!existsSync(script)) {
    throw new Error(`lifecycle supervisor script missing: ${script}`);
  }

  const bootEnvPath = writeBootEnv(dir, options.bootEnv || {});
  try {
    let aclNormalization = null;
    const normalizeAclImpl = options.normalizeLifecycleTreeImpl
      || (options.spawnNodeOutsideJobImpl ? null : normalizeLifecycleTreeOutsideJob);
    if (normalizeAclImpl) {
      aclNormalization = await normalizeAclImpl(dir, runtime.runtimeRoot, {
        platform: options.platform || process.platform,
        systemRoot: options.systemRoot,
        nodeExecutable: options.nodeExecutable || whichNode(),
        icaclsExecutable: options.icaclsExecutable,
        commandInterpreter: options.commandInterpreter,
        userIdentity: options.userIdentity,
        spawnOutsideJobImpl: options.normalizeSpawnOutsideJobImpl,
        probeOutsideJobImpl: options.normalizeProbeOutsideJobImpl,
        existsImpl: options.existsImpl,
        sleepImpl: options.normalizeSleepImpl,
        waitMs: options.normalizeWaitMs,
        env: options.env || process.env,
      });
    }
    const scriptArgs = [
      '--lifecycle-supervisor',
      `--lifecycle-dir=${dir}`,
      `--sock=${sock}`,
      `--boot-env=${bootEnvPath}`,
      ...(runtime.fingerprint ? [`--runtime-fingerprint=${runtime.fingerprint}`] : []),
    ];
    if (process.env.CURSOR_BRIDGE_ENSURE_MODULE) {
      scriptArgs.push(`--ensure-module=${process.env.CURSOR_BRIDGE_ENSURE_MODULE}`);
    }
    if (process.env.CURSOR_BRIDGE_SUPERVISOR_IDLE_MS) {
      scriptArgs.push(`--idle-ms=${process.env.CURSOR_BRIDGE_SUPERVISOR_IDLE_MS}`);
    }

    // Also set env for non-WMI spawn paths (detached inherit this object).
    const childEnv = {
      ...process.env,
      ...(options.env || {}),
      CURSOR_BRIDGE_ROLE: 'supervisor',
      CURSOR_BRIDGE_LIFECYCLE_DIR: dir,
      CURSOR_BRIDGE_SUPERVISOR_SOCK: sock,
    };

    // A lifecycle directory created by a Codex sandbox can inherit AppContainer-only ACLs.
    // WMI launches the Supervisor outside that sandbox and returns Win32 error 8 when such a
    // directory is used as CurrentDirectory, even though every launch argument is absolute.
    // Bootstrap from the Node executable directory on Windows; keep the historical runtime cwd
    // elsewhere and preserve an explicit caller override.
    const spawnCwd = resolveSupervisorSpawnCwd({
      requestedCwd: options.cwd,
      runtimeRoot: runtime.runtimeRoot,
      nodeExecutable: whichNode(),
    });
    const spawned = (options.spawnNodeOutsideJobImpl || spawnNodeOutsideJob)(script, scriptArgs, {
      cwd: spawnCwd,
      env: childEnv,
    });
    if (!spawned.ok) {
      throw lifecycleClientError(`failed to spawn lifecycle supervisor: ${spawned.error || spawned.method}`, {
        errorKind: spawned.errorKind || 'unknown',
        degradedReason: spawned.degradedReason || null,
        errorCode: spawned.errorCode ?? null,
        returnValue: spawned.returnValue ?? null,
        canAttachFallback: spawned.canAttachFallback === true,
        commandLine: spawned.commandLine || null,
        spawnCwd: spawned.spawnCwd || spawnCwd || null,
        stderr: spawned.stderr || null,
        attempts: spawned.attempts ?? null,
      });
    }

    const deadline = Date.now() + createWaitMs;
    while (Date.now() < deadline) {
      socket = await tryConnect(sock);
      if (socket) {
        const pid = readPidFile(pidPath) || spawned.pid;
        return {
          socket,
          sock,
          dir,
          supervisorPid: pid,
          reusedSupervisor: false,
          createdSupervisor: true,
          spawnMethod: spawned.method,
          spawnPid: spawned.pid,
          supervisorSpawnCwd: spawned.spawnCwd || spawnCwd || null,
          lifecycleAclNormalizationMethod: aclNormalization && aclNormalization.method || null,
          degraded: !!spawned.degraded,
          unsafe: !!spawned.unsafe,
          runtimeFingerprint: runtime.fingerprint,
          runtimeScript: script,
          targetRuntimeFingerprint: runtime.fingerprint,
          runtimeUpgradeDeferred: false,
        };
      }
      await sleep(100);
    }
    throw new Error(`spawned supervisor (${spawned.method} pid=${spawned.pid}) but IPC not ready within ${createWaitMs}ms sock=${sock}`);
  } finally {
    // Best-effort cleanup on success (supervisor already deleted), spawn failure, or IPC timeout.
    tryUnlink(bootEnvPath);
  }
}

/**
 * Ask the singleton supervisor to ensure Cursor. Public diagnostic fields are always attached.
 */
export async function ensureCursorViaSupervisor(options = {}) {
  const adapterPid = process.pid;
  const reason = options.reason || 'ensure';
  const conn = await ensureSupervisorConnected(options);
  try {
    const waitMs = Number(options.waitMs || 30000);
    const response = await request(conn.socket, {
      type: 'ensure',
      waitMs,
      reason,
      adapterPid,
      runtimeMode: options.runtimeMode || null,
      projectPath: Object.hasOwn(options, 'projectPath') ? options.projectPath : null,
    }, Math.max(waitMs + 15000, 60000));

    if (response.type === 'error') {
      return {
        ok: false,
        status: 'supervisor-error',
        message: response.error || 'supervisor error',
        adapterPid,
        supervisorPid: conn.supervisorPid,
        reusedSupervisor: conn.reusedSupervisor,
        createdSupervisor: conn.createdSupervisor,
        launchReason: 'supervisor-error',
        spawnMethod: conn.spawnMethod,
        supervisorSpawnCwd: conn.supervisorSpawnCwd || null,
        lifecycleAclNormalizationMethod: conn.lifecycleAclNormalizationMethod || null,
        runtimeFingerprint: conn.runtimeFingerprint || null,
        runtimeScript: conn.runtimeScript || null,
        runtimeUpgradeDeferred: conn.runtimeUpgradeDeferred === true,
      };
    }

    return {
      ok: !!response.ok,
      status: response.status,
      message: response.message,
      port: response.port,
      exe: response.exe,
      cursorPid: response.cursorPid || null,
      runtimeMode: response.runtimeMode || options.runtimeMode || null,
      projectPath: response.projectPath || options.projectPath || null,
      targetId: response.targetId || null,
      workspaceAction: response.workspaceAction || null,
      presentation: response.presentation || null,
      windowGuard: response.windowGuard || null,
      startupWindowGuard: response.startupWindowGuard || null,
      adapterPid,
      supervisorPid: response.supervisorPid || conn.supervisorPid,
      reusedSupervisor: conn.reusedSupervisor,
      createdSupervisor: conn.createdSupervisor,
      launchReason: conn.createdSupervisor
        ? (response.status === 'launched' ? 'created-supervisor-and-spawned-cursor' : 'created-supervisor')
        : (response.launchReason || (response.status === 'launched' ? 'reused-supervisor-spawned-cursor' : 'reused-supervisor')),
      spawnMethod: conn.spawnMethod,
      supervisorSpawnCwd: conn.supervisorSpawnCwd || null,
      lifecycleAclNormalizationMethod: conn.lifecycleAclNormalizationMethod || null,
      ensureCount: response.ensureCount,
      runtimeFingerprint: response.runtimeFingerprint || conn.runtimeFingerprint || null,
      runtimeScript: response.runtimeScript || conn.runtimeScript || null,
      runtimeUpgradeDeferred: conn.runtimeUpgradeDeferred === true,
    };
  } finally {
    try { conn.socket.end(); } catch {}
    try { conn.socket.destroy(); } catch {}
  }
}

export async function pingSupervisor(options = {}) {
  const conn = await ensureSupervisorConnected(options);
  try {
    const response = await request(conn.socket, { type: 'ping' }, 5000);
    return {
      ...response,
      reusedSupervisor: conn.reusedSupervisor,
      createdSupervisor: conn.createdSupervisor,
      spawnMethod: conn.spawnMethod,
      supervisorSpawnCwd: conn.supervisorSpawnCwd || null,
      lifecycleAclNormalizationMethod: conn.lifecycleAclNormalizationMethod || null,
      adapterPid: process.pid,
      runtimeFingerprint: response.runtimeFingerprint || conn.runtimeFingerprint || null,
      runtimeScript: response.runtimeScript || conn.runtimeScript || null,
      runtimeUpgradeDeferred: conn.runtimeUpgradeDeferred === true,
    };
  } finally {
    try { conn.socket.end(); } catch {}
    try { conn.socket.destroy(); } catch {}
  }
}
