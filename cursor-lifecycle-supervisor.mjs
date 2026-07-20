/**
 * User-level Cursor lifecycle supervisor (singleton).
 *
 * Owns ensureCursorRunningLocal serialization and keeps Cursor alive across
 * adapter disconnects. Disconnecting MCP stdio clients never stops Cursor. The
 * supervisor itself may idle-exit after CURSOR_BRIDGE_SUPERVISOR_IDLE_MS with
 * zero clients; Cursor stays up.
 *
 * Windows note: the supervisor may be started via Win32_Process.Create (job
 * breakaway), which does not inherit the adapter env. Pass --lifecycle-dir and
 * optional --boot-env JSON file instead of relying on process.env alone.
 */
import net from 'node:net';
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  appendFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  defaultLifecycleDir,
  ensureLifecycleDir,
  supervisorSockPath,
  supervisorPidPath,
  supervisorLockPath,
  supervisorLogPath,
} from './lifecycle-paths.mjs';

const LOG_MAX_BYTES = 256 * 1024;

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lifecycle-supervisor') continue;
    if (a.startsWith('--lifecycle-dir=')) out.dir = a.slice('--lifecycle-dir='.length);
    else if (a === '--lifecycle-dir') out.dir = argv[++i];
    else if (a.startsWith('--sock=')) out.sock = a.slice('--sock='.length);
    else if (a === '--sock') out.sock = argv[++i];
    else if (a.startsWith('--boot-env=')) out.bootEnv = a.slice('--boot-env='.length);
    else if (a === '--boot-env') out.bootEnv = argv[++i];
    else if (a.startsWith('--ensure-module=')) out.ensureModule = a.slice('--ensure-module='.length);
    else if (a === '--ensure-module') out.ensureModule = argv[++i];
    else if (a.startsWith('--idle-ms=')) out.idleMs = Number(a.slice('--idle-ms='.length));
    else if (a === '--idle-ms') out.idleMs = Number(argv[++i]);
  }
  return out;
}

function tryRemove(path) {
  try { if (path && existsSync(path)) unlinkSync(path); } catch {}
}

/**
 * Apply boot-env JSON, then delete the file immediately after a successful read.
 * Secrets/prompts must never linger on disk longer than needed.
 */
export function applyBootEnv(bootEnvPath) {
  if (!bootEnvPath || !existsSync(bootEnvPath)) return { applied: false, deleted: false };
  try {
    const parsed = JSON.parse(readFileSync(bootEnvPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        if (value == null) continue;
        if (process.env[key] == null || process.env[key] === '') {
          process.env[key] = String(value);
        }
      }
    }
    tryRemove(bootEnvPath);
    return { applied: true, deleted: !existsSync(bootEnvPath) };
  } catch (error) {
    console.error('[cursor-lifecycle-supervisor] boot-env read failed:', error instanceof Error ? error.message : error);
    return { applied: false, deleted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function rotateLogIfNeeded(logPath) {
  try {
    if (!existsSync(logPath)) return;
    const size = statSync(logPath).size;
    if (size < LOG_MAX_BYTES) return;
    const rotated = `${logPath}.1`;
    tryRemove(rotated);
    renameSync(logPath, rotated);
  } catch {}
}

/**
 * Lightweight durable diagnostics for WMI-spawned supervisors (often no visible stderr).
 * Never logs prompts, secrets, or full environment dumps.
 */
export function writeSupervisorDiag(logPath, event, fields = {}) {
  if (!logPath || !event) return;
  try {
    rotateLogIfNeeded(logPath);
    const safe = {
      ts: new Date().toISOString(),
      event: String(event),
      supervisorPid: process.pid,
    };
    if (fields.adapterPid != null) safe.adapterPid = fields.adapterPid;
    if (fields.reason != null) safe.reason = String(fields.reason).slice(0, 200);
    if (fields.status != null) safe.status = String(fields.status);
    if (fields.ok != null) safe.ok = !!fields.ok;
    if (fields.clients != null) safe.clients = Number(fields.clients);
    if (fields.ensureCount != null) safe.ensureCount = Number(fields.ensureCount);
    if (fields.sock != null) safe.sock = String(fields.sock).slice(0, 260);
    if (fields.dir != null) safe.dir = String(fields.dir).slice(0, 260);
    if (fields.error != null) safe.error = String(fields.error).slice(0, 400);
    if (fields.code != null) safe.code = fields.code;
    appendFileSync(logPath, `${JSON.stringify(safe)}\n`, { encoding: 'utf8' });
  } catch {}
}

function log(...args) {
  console.error('[cursor-lifecycle-supervisor]', ...args);
}

async function loadEnsure(ensureModule) {
  const override = ensureModule || process.env.CURSOR_BRIDGE_ENSURE_MODULE;
  if (override) {
    const mod = await import(pathToFileURL(override).href);
    if (typeof mod.ensureCursorRunningLocal !== 'function') {
      throw new Error(`ensure module missing ensureCursorRunningLocal: ${override}`);
    }
    return mod.ensureCursorRunningLocal;
  }
  const { ensureCursorRunningLocal } = await import('./cursor-ensure-core.mjs');
  return ensureCursorRunningLocal;
}

function writePid(pidPath) {
  writeFileSync(pidPath, `${process.pid}\n`, { encoding: 'utf8' });
}

function acquireOrExit(lockPath, diagLog) {
  try {
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8' });
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      try {
        const existing = Number(String(readFileSync(lockPath, 'utf8')).trim());
        if (existing && existing !== process.pid) {
          try {
            process.kill(existing, 0);
            log(`another supervisor holds lock pid=${existing}; exiting`);
            writeSupervisorDiag(diagLog, 'fatal', { reason: 'lock-held', error: `pid=${existing}` });
            return false;
          } catch {
            tryRemove(lockPath);
            return acquireOrExit(lockPath, diagLog);
          }
        }
      } catch {}
      log('lock busy; exiting');
      writeSupervisorDiag(diagLog, 'fatal', { reason: 'lock-busy' });
      return false;
    }
    throw error;
  }
}

export async function startSupervisor(options = {}) {
  const cli = parseArgs(options.argv || process.argv.slice(2));
  if (cli.bootEnv || options.bootEnv) applyBootEnv(cli.bootEnv || options.bootEnv);

  const dir = ensureLifecycleDir(options.dir || cli.dir || defaultLifecycleDir());
  const sock = options.sock || cli.sock || process.env.CURSOR_BRIDGE_SUPERVISOR_SOCK || supervisorSockPath(dir);
  const pidPath = options.pidPath || supervisorPidPath(dir);
  const lockPath = options.lockPath || supervisorLockPath(dir);
  const logPath = options.logPath || supervisorLogPath(dir);
  const idleMs = Number(
    options.idleMs
    ?? cli.idleMs
    ?? process.env.CURSOR_BRIDGE_SUPERVISOR_IDLE_MS
    ?? 5 * 60 * 1000,
  );
  const ensureModule = options.ensureModule || cli.ensureModule || process.env.CURSOR_BRIDGE_ENSURE_MODULE;

  writeSupervisorDiag(logPath, 'start', { dir, sock, reason: 'startSupervisor' });

  if (!acquireOrExit(lockPath, logPath)) {
    return { started: false, reason: 'lock-held' };
  }

  if (process.platform !== 'win32' && existsSync(sock)) {
    tryRemove(sock);
  }

  const ensureLocal = await loadEnsure(ensureModule);
  let ensureInflight = null;
  let ensureCount = 0;
  let lastEnsure = null;
  const clients = new Set();
  let idleTimer = null;
  let shuttingDown = false;

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!(idleMs > 0)) return;
    idleTimer = setTimeout(() => {
      if (clients.size > 0 || shuttingDown) return;
      log(`idle ${idleMs}ms with 0 clients; exiting without stopping Cursor`);
      writeSupervisorDiag(logPath, 'idle', { reason: `idle-${idleMs}ms`, clients: 0, ensureCount });
      shutdown(0);
    }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  const runEnsure = async (request = {}) => {
    if (ensureInflight) return ensureInflight;
    ensureInflight = (async () => {
      ensureCount += 1;
      const waitMs = Number(request.waitMs || 30000);
      const result = await ensureLocal({ waitMs });
      lastEnsure = {
        ...result,
        ensureCount,
        at: new Date().toISOString(),
        requestReason: request.reason || null,
        requestAdapterPid: request.adapterPid || null,
      };
      writeSupervisorDiag(logPath, 'ensure-result', {
        ok: !!result.ok,
        status: result.status,
        reason: request.reason || null,
        adapterPid: request.adapterPid || null,
        ensureCount,
      });
      return lastEnsure;
    })();
    try {
      return await ensureInflight;
    } finally {
      ensureInflight = null;
    }
  };

  const server = net.createServer((socket) => {
    clients.add(socket);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        Promise.resolve()
          .then(() => handleLine(socket, line, { runEnsure, ensureCount: () => ensureCount, lastEnsure: () => lastEnsure, clients }))
          .catch((error) => {
            try {
              socket.write(`${JSON.stringify({
                type: 'error',
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })}\n`);
            } catch {}
          });
      }
    });
    socket.on('close', () => {
      clients.delete(socket);
      scheduleIdle();
    });
    socket.on('error', () => {
      clients.delete(socket);
      scheduleIdle();
    });
  });

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeSupervisorDiag(logPath, 'cleanup', { reason: 'shutdown', code, clients: clients.size, ensureCount });
    try { server.close(); } catch {}
    tryRemove(pidPath);
    tryRemove(lockPath);
    if (process.platform !== 'win32') tryRemove(sock);
    process.exit(code);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  writePid(pidPath);
  log(`listening sock=${sock} pid=${process.pid} dir=${dir}`);
  writeSupervisorDiag(logPath, 'listen', { sock, dir, reason: 'listening' });
  scheduleIdle();
  return { started: true, sock, pid: process.pid, dir, server, shutdown, logPath };
}

async function handleLine(socket, line, ctx) {
  let msg;
  try { msg = JSON.parse(line); }
  catch {
    socket.write(`${JSON.stringify({ type: 'error', ok: false, error: 'invalid-json' })}\n`);
    return;
  }
  const id = msg.id;
  try {
    if (msg.type === 'ping') {
      socket.write(`${JSON.stringify({
        type: 'pong',
        id,
        ok: true,
        supervisorPid: process.pid,
        clients: ctx.clients.size,
        ensureCount: ctx.ensureCount(),
      })}\n`);
      return;
    }
    if (msg.type === 'status') {
      socket.write(`${JSON.stringify({
        type: 'status-result',
        id,
        ok: true,
        supervisorPid: process.pid,
        clients: ctx.clients.size,
        ensureCount: ctx.ensureCount(),
        lastEnsure: ctx.lastEnsure(),
      })}\n`);
      return;
    }
    if (msg.type === 'ensure') {
      const result = await ctx.runEnsure(msg);
      socket.write(`${JSON.stringify({
        type: 'ensure-result',
        id,
        supervisorPid: process.pid,
        reusedSupervisor: true,
        launchReason: result.status === 'launched'
          ? 'supervisor-spawned-cursor'
          : (result.status === 'already' ? 'supervisor-cursor-already' : `supervisor-${result.status}`),
        ...result,
      })}\n`);
      return;
    }
    socket.write(`${JSON.stringify({ type: 'error', id, ok: false, error: `unknown-type:${msg.type}` })}\n`);
  } catch (error) {
    socket.write(`${JSON.stringify({
      type: 'error',
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href
  || process.argv.includes('--lifecycle-supervisor')
  || process.env.CURSOR_BRIDGE_ROLE === 'supervisor';

if (isMain) {
  startSupervisor().catch((error) => {
    log('fatal', error);
    try {
      const dir = ensureLifecycleDir(process.env.CURSOR_BRIDGE_LIFECYCLE_DIR || defaultLifecycleDir());
      writeSupervisorDiag(supervisorLogPath(dir), 'fatal', {
        reason: 'start-failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {}
    process.exit(1);
  });
}
