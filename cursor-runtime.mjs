import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const CURSOR_RUNTIME_MODES = Object.freeze(['normal', 'minimal']);

export function normalizeCursorRuntimeMode(value, fallback = 'normal') {
  const normalized = String(value || '').trim().toLowerCase();
  return CURSOR_RUNTIME_MODES.includes(normalized) ? normalized : fallback;
}

export function resolveCursorRuntimeFile(value = process.env.CURSOR_BRIDGE_RUNTIME_FILE) {
  const configured = String(value || '').trim();
  if (configured) return resolve(configured);
  const configRoot = process.platform === 'win32' && process.env.APPDATA
    ? process.env.APPDATA
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configRoot, 'cursor-bridge', 'runtime.json');
}

export function readPersistedCursorRuntimeMode(filePath) {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const candidate = typeof parsed === 'string' ? parsed : parsed && parsed.mode;
    const normalized = normalizeCursorRuntimeMode(candidate, '');
    return CURSOR_RUNTIME_MODES.includes(normalized) ? normalized : null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    console.error(`[cursor-bridge] ignoring unreadable runtime file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function writePersistedCursorRuntimeMode(filePath, mode) {
  if (!filePath) throw new Error('persistent cursor_runtime storage is disabled for this server');
  const normalized = normalizeCursorRuntimeMode(mode, '');
  if (!CURSOR_RUNTIME_MODES.includes(normalized)) throw new Error(`unsupported Cursor runtime mode: ${mode}`);
  const target = resolve(filePath);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, mode: normalized }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`failed to persist cursor_runtime at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return target;
}

export function parseNetstatListeningPid(output, port) {
  const expectedPort = Number(port);
  if (!Number.isInteger(expectedPort) || expectedPort <= 0) return null;
  for (const line of String(output || '').split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || String(columns[0]).toUpperCase() !== 'TCP') continue;
    const local = columns[1] || '';
    const state = String(columns[3] || '').toUpperCase();
    const pid = Number(columns[4]);
    const portMatch = local.match(/:(\d+)$/);
    if (state === 'LISTENING' && portMatch && Number(portMatch[1]) === expectedPort && Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }
  return null;
}

export function findCursorPidByPort(port, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return null;
  const run = options.execFileSyncImpl || execFileSync;
  try {
    const output = run('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseNetstatListeningPid(output, port);
  } catch {
    return null;
  }
}

const WINDOW_CONTROL_TYPE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CursorBridgeWindowControl {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

  public static int Apply(int expectedProcessId, bool show) {
    int changed = 0;
    EnumWindows((hWnd, lParam) => {
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      if (processId != (uint)expectedProcessId || GetWindowTextLengthW(hWnd) <= 0) return true;
      StringBuilder className = new StringBuilder(256);
      GetClassNameW(hWnd, className, className.Capacity);
      if (!String.Equals(className.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal)) return true;
      bool visible = IsWindowVisible(hWnd);
      if (show && !visible) { if (ShowWindowAsync(hWnd, 9)) changed++; }
      if (!show && visible) { if (ShowWindowAsync(hWnd, 0)) changed++; }
      return true;
    }, IntPtr.Zero);
    return changed;
  }
}
`;

function powershellWindowScript(options) {
  const targetPid = Number(options.pid);
  const loop = options.loop === true;
  const show = options.action === 'show' ? '$true' : '$false';
  const iterations = Number(options.iterations || 1);
  const intervalMs = Number(options.intervalMs || 100);
  const apply = loop
    ? `for ($i = 0; $i -lt ${iterations}; $i++) { [void][CursorBridgeWindowControl]::Apply(${targetPid}, $false); Start-Sleep -Milliseconds ${intervalMs} }`
    : `$changed = [CursorBridgeWindowControl]::Apply(${targetPid}, ${show}); [Console]::Out.Write($changed)`;
  return `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${WINDOW_CONTROL_TYPE}\n'@\n${apply}`;
}

function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

export function setCursorWindowPresentation(options = {}) {
  const platform = options.platform || process.platform;
  const action = String(options.action || '').trim().toLowerCase();
  if (!['hide', 'show'].includes(action)) throw new Error(`unsupported Cursor window action: ${options.action}`);
  if (platform !== 'win32') {
    return { supported: false, applied: false, action, reason: `window control is not implemented for ${platform}` };
  }
  const port = Number(options.port || 9223);
  const pid = Number(options.pid || findCursorPidByPort(port, options));
  if (!Number.isInteger(pid) || pid <= 0) {
    return { supported: true, applied: false, action, port, reason: `no listening Cursor PID found on CDP ${port}` };
  }
  const run = options.execFileSyncImpl || execFileSync;
  try {
    const script = powershellWindowScript({ pid, action });
    const output = run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodePowerShell(script),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Number(options.timeoutMs || 15000),
    });
    const changedWindows = Number(String(output || '').trim() || 0);
    return { supported: true, applied: true, action, port, pid, changedWindows };
  } catch (error) {
    return {
      supported: true,
      applied: false,
      action,
      port,
      pid,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function startMinimalWindowGuard(pid, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return { started: false, reason: 'unsupported-platform' };
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return { started: false, reason: 'invalid-pid' };
  const intervalMs = Math.max(50, Math.min(1000, Number(options.intervalMs || 100)));
  const durationMs = Math.max(intervalMs, Math.min(120000, Number(options.durationMs || 45000)));
  const iterations = Math.ceil(durationMs / intervalMs);
  const spawnImpl = options.spawnImpl || spawn;
  try {
    const script = powershellWindowScript({
      pid: targetPid,
      loop: true,
      iterations,
      intervalMs,
    });
    const child = spawnImpl('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodePowerShell(script),
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.unref === 'function') child.unref();
    return { started: true, pid: child && child.pid || null, targetPid, durationMs, intervalMs };
  } catch (error) {
    return { started: false, targetPid, reason: error instanceof Error ? error.message : String(error) };
  }
}
