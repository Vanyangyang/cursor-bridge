/**
 * Adapter-side client for the user-level Cursor lifecycle supervisor.
 * Creates the singleton on first use (job-breakaway on Windows), then reuses IPC.
 */
import net from 'node:net';
import { existsSync, readFileSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  defaultLifecycleDir,
  ensureLifecycleDir,
  supervisorSockPath,
  supervisorPidPath,
  supervisorLockPath,
} from './lifecycle-paths.mjs';
import { spawnNodeOutsideJob } from './win-job-breakaway.mjs';

const DEFAULT_CREATE_WAIT_MS = 20000;

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
    candidates.push(join(entryDir, 'cursor-lifecycle-supervisor.mjs'));
  }
  candidates.push(
    join(here, 'cursor-lifecycle-supervisor.mjs'),
    join(here, 'dist', 'cursor-lifecycle-supervisor.mjs'),
  );
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(here, 'cursor-lifecycle-supervisor.mjs');
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
  const dir = ensureLifecycleDir(options.dir || defaultLifecycleDir());
  const sock = options.sock || supervisorSockPath(dir);
  const pidPath = options.pidPath || supervisorPidPath(dir);
  const lockPath = options.lockPath || supervisorLockPath(dir);
  const createWaitMs = Number(options.createWaitMs || DEFAULT_CREATE_WAIT_MS);

  let socket = await tryConnect(sock);
  if (socket) {
    const pid = readPidFile(pidPath);
    return {
      socket,
      sock,
      dir,
      supervisorPid: pid,
      reusedSupervisor: true,
      createdSupervisor: false,
      spawnMethod: null,
    };
  }

  const stalePid = readPidFile(pidPath);
  if (stalePid && !isProcessAlive(stalePid)) {
    tryUnlink(pidPath);
    tryUnlink(lockPath);
    if (process.platform !== 'win32') {
      tryUnlink(sock);
    }
  }

  const script = options.supervisorScript || resolveSupervisorScript();
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

    const spawned = spawnNodeOutsideJob(script, scriptArgs, {
      cwd: options.cwd || dirname(script),
      env: childEnv,
    });
    if (!spawned.ok) {
      throw new Error(`failed to spawn lifecycle supervisor: ${spawned.error || spawned.method}`);
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
          degraded: !!spawned.degraded,
          unsafe: !!spawned.unsafe,
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
      ensureCount: response.ensureCount,
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
      adapterPid: process.pid,
    };
  } finally {
    try { conn.socket.end(); } catch {}
    try { conn.socket.destroy(); } catch {}
  }
}
