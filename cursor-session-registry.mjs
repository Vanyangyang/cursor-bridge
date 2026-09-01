import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const CURSOR_SESSION_REGISTRY_VERSION = 1;
export const CURSOR_SESSION_MODES = Object.freeze(['isolated', 'create', 'continue']);

function sessionRegistryError(code, message, cause) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function normalizeCursorSessionMode(value, fallback = 'isolated') {
  const normalized = String(value || fallback).trim().toLowerCase().replace(/-/g, '_');
  return CURSOR_SESSION_MODES.includes(normalized) ? normalized : '';
}

export function createCursorSessionId() {
  return `cursor-session-${randomUUID()}`;
}

export function resolveCursorSessionRegistryFile(value, env = process.env) {
  if (value === undefined) value = env.CURSOR_BRIDGE_SESSION_FILE;
  const configured = String(value || '').trim();
  if (configured) return resolve(configured);
  const configRoot = process.platform === 'win32' && env.APPDATA
    ? env.APPDATA
    : env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configRoot, 'cursor-bridge', 'sessions-v1.json');
}

export function emptyCursorSessionRegistry() {
  return { version: CURSOR_SESSION_REGISTRY_VERSION, sessions: {}, updatedAt: null };
}

export function readCursorSessionRegistry(filePath) {
  if (!filePath) return emptyCursorSessionRegistry();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || parsed.version !== CURSOR_SESSION_REGISTRY_VERSION) {
      throw sessionRegistryError(
        'SESSION_SCHEMA_UNSUPPORTED',
        `expected version ${CURSOR_SESSION_REGISTRY_VERSION}, received ${parsed && parsed.version}`,
      );
    }
    if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
      throw sessionRegistryError('SESSION_REGISTRY_INVALID', 'sessions must be an object');
    }
    return {
      version: CURSOR_SESSION_REGISTRY_VERSION,
      sessions: { ...parsed.sessions },
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyCursorSessionRegistry();
    if (error && /^SESSION_/.test(String(error.code || ''))) throw error;
    throw sessionRegistryError(
      'SESSION_REGISTRY_INVALID',
      `failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

function writeCursorSessionRegistry(filePath, state, now = new Date().toISOString()) {
  if (!filePath) throw sessionRegistryError('SESSION_STORAGE_DISABLED', 'persistent session storage is disabled');
  const target = resolve(filePath);
  const normalized = {
    version: CURSOR_SESSION_REGISTRY_VERSION,
    sessions: state && state.sessions && typeof state.sessions === 'object' ? state.sessions : {},
    updatedAt: now,
  };
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw sessionRegistryError(
      'SESSION_REGISTRY_WRITE_FAILED',
      `failed to persist ${target}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  return normalized;
}

function acquireRegistryLock(filePath, options = {}) {
  const lockPath = `${resolve(filePath)}.lock`;
  const waitMs = Number(options.waitMs || 2000);
  const staleMs = Number(options.staleMs || 30000);
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const handle = openSync(lockPath, 'wx', 0o600);
      closeSync(handle);
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw sessionRegistryError('SESSION_REGISTRY_LOCK_FAILED', error instanceof Error ? error.message : String(error), error);
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw sessionRegistryError('SESSION_REGISTRY_BUSY', 'another Cursor Bridge process is updating the session registry');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function updateCursorSessionRegistry(filePath, mutator, options = {}) {
  if (!filePath) throw sessionRegistryError('SESSION_STORAGE_DISABLED', 'persistent session storage is disabled');
  const release = acquireRegistryLock(filePath, options);
  try {
    const state = readCursorSessionRegistry(filePath);
    const result = mutator(state);
    writeCursorSessionRegistry(filePath, state, options.now || new Date().toISOString());
    return result;
  } finally {
    release();
  }
}
