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
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve, win32 as win32Path } from 'node:path';
import {
  defaultLifecycleDir,
  ensureLifecycleDir,
  supervisorSockPath,
  supervisorPidPath,
  supervisorLockPath,
} from './lifecycle-paths.mjs';
import { spawnNodeOutsideJob, spawnOutsideJob, whichNode } from './win-job-breakaway.mjs';

const DEFAULT_CREATE_WAIT_MS = 20000;

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

export function resolvePluginLocalLifecycleDir(sourceScript) {
  const scriptDir = dirname(resolve(sourceScript));
  const pluginRoot = basename(scriptDir).toLowerCase() === 'dist' ? dirname(scriptDir) : scriptDir;
  return join(pluginRoot, '.cursor-bridge-lifecycle');
}

export function inspectWindowsAppContainerPath(target, options = {}) {
  const platform = options.platform || process.platform;
  const requested = win32Path.normalize(win32Path.resolve(String(target || '')));
  if (platform !== 'win32') {
    return { redirected: false, requested, physical: null };
  }
  try {
    const realpathImpl = options.realpathImpl || realpathSync.native || realpathSync;
    const physical = win32Path.normalize(win32Path.resolve(String(realpathImpl(target))));
    const physicalLower = physical.toLowerCase();
    const redirected = requested.toLowerCase() !== physicalLower
      && physicalLower.includes('\\appdata\\local\\packages\\')
      && physicalLower.includes('\\localcache\\local\\');
    return { redirected, requested, physical };
  } catch {
    return { redirected: false, requested, physical: null };
  }
}

export function probeOutsideJobCwd(cwd, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { ok: true, method: 'not-required', spawnCwd: cwd };
  const env = options.env || process.env;
  const systemRoot = String(options.systemRoot || env.SystemRoot || env.WINDIR || 'C:\\Windows');
  const commandInterpreter = options.commandInterpreter || win32Path.join(systemRoot, 'System32', 'cmd.exe');
  if (!(options.existsImpl || existsSync)(commandInterpreter)) {
    return {
      ok: false,
      method: 'failed',
      errorKind: 'configuration',
      degradedReason: 'lifecycle-probe-command-missing',
      errorCode: 'ENOENT',
      canAttachFallback: false,
      spawnCwd: cwd,
    };
  }
  const spawnImpl = options.spawnOutsideJobImpl || spawnOutsideJob;
  return spawnImpl(commandInterpreter, ['/d', '/c', 'exit', '0'], { cwd, env });
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
  const platform = options.platform || process.platform;
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
      lifecycleStorageMode: options._lifecycleStorageMode || 'shared',
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

  const canProbeFallback = platform === 'win32'
    && options._disablePluginLocalFallback !== true
    && !options.dir
    && !options.sock
    && !options.pidPath
    && !options.lockPath
    && (!options.spawnNodeOutsideJobImpl || options.lifecycleCwdProbeImpl);
  const runProbe = canProbeFallback
    ? (options.lifecycleCwdProbeImpl || ((target) => probeOutsideJobCwd(target, {
        platform,
        systemRoot: options.systemRoot,
        commandInterpreter: options.commandInterpreter,
        spawnOutsideJobImpl: options.probeSpawnOutsideJobImpl,
        existsImpl: options.existsImpl,
        env: options.env || process.env,
      })))
    : null;
  const connectPluginLocalFallback = async ({ sharedFailure = null } = {}) => {
    const fallbackDir = options.pluginLocalLifecycleDir || resolvePluginLocalLifecycleDir(sourceScript);
    ensureLifecycleDir(fallbackDir);
    const fallbackProbe = runProbe ? runProbe(fallbackDir) : { ok: true, method: 'not-required' };
    if (!fallbackProbe || fallbackProbe.ok !== true) {
      throw lifecycleClientError(`shared lifecycle storage cannot host the persistent Supervisor and plugin-local fallback is also unavailable: ${fallbackDir}`, {
        errorKind: fallbackProbe?.errorKind || sharedFailure?.errorKind || 'unknown',
        degradedReason: fallbackProbe?.degradedReason || 'plugin-local-lifecycle-unavailable',
        errorCode: fallbackProbe && (fallbackProbe.errorCode ?? fallbackProbe.returnValue) || null,
        canAttachFallback: true,
        spawnCwd: fallbackDir,
      });
    }
    return ensureSupervisorConnected({
      ...options,
      dir: fallbackDir,
      sock: undefined,
      pidPath: undefined,
      lockPath: undefined,
      _disablePluginLocalFallback: true,
      _lifecycleStorageMode: 'plugin-cache-fallback',
    });
  };
  if (canProbeFallback) {
    ensureLifecycleDir(dir);
    const sharedProbe = runProbe(dir);
    const sharedCode = sharedProbe && (sharedProbe.errorCode ?? sharedProbe.returnValue);
    if (sharedProbe && sharedProbe.ok !== true
      && (sharedCode === 8 || sharedProbe.degradedReason === 'wmi-unknown-8')) {
      return connectPluginLocalFallback({ sharedFailure: sharedProbe });
    }
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

  const runtimePath = inspectWindowsAppContainerPath(runtime.script, {
    platform,
    realpathImpl: options.realpathImpl,
  });
  if (canProbeFallback && runtimePath.redirected) {
    return connectPluginLocalFallback({
      sharedFailure: {
        errorKind: 'policy-blocked',
        degradedReason: 'appcontainer-path-redirected',
      },
    });
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
          lifecycleStorageMode: options._lifecycleStorageMode || 'shared',
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
    if (canProbeFallback && !isProcessAlive(spawned.pid)) {
      return connectPluginLocalFallback({
        sharedFailure: {
          errorKind: 'supervisor-start-failed',
          degradedReason: 'supervisor-exited-before-ipc',
        },
      });
    }
    throw lifecycleClientError(`spawned supervisor (${spawned.method} pid=${spawned.pid}) but IPC not ready within ${createWaitMs}ms sock=${sock}`, {
      errorKind: 'supervisor-unresponsive',
      degradedReason: 'supervisor-ipc-timeout',
      canAttachFallback: true,
      spawnCwd: spawned.spawnCwd || spawnCwd || null,
    });
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
        lifecycleStorageMode: conn.lifecycleStorageMode || 'shared',
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
      lifecycleStorageMode: conn.lifecycleStorageMode || 'shared',
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
      lifecycleStorageMode: conn.lifecycleStorageMode || 'shared',
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
