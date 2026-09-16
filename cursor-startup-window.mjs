import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function cursorWindowStatePath(options = {}) {
  const env = options.env || process.env;
  const home = options.home || homedir();
  const platform = options.platform || process.platform;
  let dataDir;
  if (env.VSCODE_PORTABLE) dataDir = join(env.VSCODE_PORTABLE, 'user-data');
  else if (env.VSCODE_APPDATA) dataDir = join(env.VSCODE_APPDATA, 'Cursor');
  else if (platform === 'win32') dataDir = join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor');
  else if (platform === 'darwin') dataDir = join(home, 'Library', 'Application Support', 'Cursor');
  else dataDir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor');
  return join(dataDir, 'User', 'globalStorage', 'storage.json');
}

export function bridgeWindowStatePath(options = {}) {
  const env = options.env || process.env;
  if (env.CURSOR_BRIDGE_WINDOW_STATE_FILE) return resolve(env.CURSOR_BRIDGE_WINDOW_STATE_FILE);
  const root = (options.platform || process.platform) === 'win32' && env.APPDATA
    ? env.APPDATA : env.XDG_CONFIG_HOME || join(options.home || homedir(), '.config');
  return join(root, 'cursor-bridge', 'last-window.json');
}

function nativeWindowState(options) {
  try {
    return JSON.parse((options.readFileSyncImpl || readFileSync)(options.file || cursorWindowStatePath(options), 'utf8'))?.windowsState?.lastActiveWindow || null;
  } catch { return null; }
}

function stateSignature(last) {
  return createHash('sha256').update(JSON.stringify(last)).digest('hex');
}

// Cursor 3.20.21 can fail to save on shutdown (ENOPRO). Use the supervised
// close observation only while Cursor's saved last-window record is unchanged.
// A newly saved native record takes precedence, including external Cursor use.
export function readCursorStartupWindow(options = {}) {
  const file = options.file || cursorWindowStatePath(options);
  const last = nativeWindowState(options);
  try {
    const observed = JSON.parse((options.readFileSyncImpl || readFileSync)(options.bridgeFile || bridgeWindowStatePath(options), 'utf8'));
    if (observed.version === 1 && observed.cursorStatePath === resolve(file)
      && observed.nativeSignature === stateSignature(last)
      && ['agents_v2', 'legacy'].includes(observed.uiFlavor)) {
      return { uiFlavor: observed.uiFlavor, source: 'bridge-last-closed-window' };
    }
  } catch { /* No valid supervised observation for this profile. */ }
  if (last?.uiState && typeof last.uiState === 'object' && !Array.isArray(last.uiState)) {
    return { uiFlavor: last.uiState.glassMode === true ? 'agents_v2' : 'legacy', source: 'cursor-last-active-window' };
  }
  return { uiFlavor: 'agents_v2', source: 'default-agents-window' };
}

export function recordCursorClosedWindow(uiFlavor, options = {}) {
  if (!['agents_v2', 'legacy'].includes(uiFlavor)) return;
  const file = options.bridgeFile || bridgeWindowStatePath(options);
  const value = { version: 1, uiFlavor, cursorStatePath: resolve(options.file || cursorWindowStatePath(options)),
    nativeSignature: stateSignature(nativeWindowState(options)), closedAt: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

export function cursorStartupWindowArgs(startupWindow, projectPath) {
  if (startupWindow.uiFlavor !== 'legacy') return ['--glass'];
  // A concrete folder opens the intended IDE directly instead of first restoring
  // another window and then handing the workspace to a second CLI invocation.
  return ['--classic', ...(projectPath ? [projectPath] : ['--new-window'])];
}
