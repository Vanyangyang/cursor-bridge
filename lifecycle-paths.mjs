/**
 * Shared filesystem / IPC endpoints for the user-level Cursor lifecycle supervisor.
 * Override with CURSOR_BRIDGE_LIFECYCLE_DIR / CURSOR_BRIDGE_SUPERVISOR_SOCK for tests.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function defaultLifecycleDir() {
  if (process.env.CURSOR_BRIDGE_LIFECYCLE_DIR) return process.env.CURSOR_BRIDGE_LIFECYCLE_DIR;
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(root, 'cursor-bridge', 'lifecycle');
  }
  const root = process.env.XDG_RUNTIME_DIR || process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(root, 'cursor-bridge', 'lifecycle');
}

export function ensureLifecycleDir(dir = defaultLifecycleDir()) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Stable cryptographic tag for a lifecycle directory.
 * Used as the Windows named-pipe suffix so dirs that share a long prefix never collide.
 */
export function lifecycleEndpointTag(dir) {
  return createHash('sha256').update(String(dir), 'utf8').digest('hex').slice(0, 24);
}

export function supervisorSockPath(dir = defaultLifecycleDir()) {
  if (process.env.CURSOR_BRIDGE_SUPERVISOR_SOCK) return process.env.CURSOR_BRIDGE_SUPERVISOR_SOCK;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cursor-bridge-lifecycle-${lifecycleEndpointTag(dir)}`;
  }
  return join(dir, 'supervisor.sock');
}

export function supervisorPidPath(dir = defaultLifecycleDir()) {
  return join(dir, 'supervisor.pid');
}

export function supervisorLockPath(dir = defaultLifecycleDir()) {
  return join(dir, 'supervisor.lock');
}

export function supervisorLogPath(dir = defaultLifecycleDir()) {
  return join(dir, 'supervisor.log');
}
