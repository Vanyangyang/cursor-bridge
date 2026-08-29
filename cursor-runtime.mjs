import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const CURSOR_RUNTIME_MODES = Object.freeze(['normal', 'minimal']);

export function shouldAutoLaunchCursor(value = process.env.CURSOR_BRIDGE_NO_AUTOLAUNCH) {
  return String(value || '').trim() !== '1';
}

export function cursorStartupBehavior(mode, noAutolaunch = process.env.CURSOR_BRIDGE_NO_AUTOLAUNCH) {
  if (!shouldAutoLaunchCursor(noAutolaunch)) return 'manual_launch_only';
  return normalizeCursorRuntimeMode(mode) === 'minimal'
    ? 'hidden_prewarm_on_adapter_start'
    : 'normal_autolaunch';
}

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
  [StructLayout(LayoutKind.Sequential)]
  private struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll", EntryPoint = "IsWindowArranged")] private static extern bool IsWindowArranged(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] private static extern bool RedrawWindow(IntPtr hWnd, IntPtr updateRect, IntPtr updateRegion, uint flags);

  private const uint SWP_NOSIZE = 0x0001;
  private const uint SWP_NOMOVE = 0x0002;
  private const uint SWP_NOZORDER = 0x0004;
  private const uint SWP_NOACTIVATE = 0x0010;
  private const uint SWP_SHOWWINDOW = 0x0040;
  private const uint SWP_NOOWNERZORDER = 0x0200;
  private const uint SWP_ASYNCWINDOWPOS = 0x4000;
  private const uint SHOW_NO_ACTIVATE_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS;
  private const uint COMPOSITOR_PULSE_FLAGS = SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS;

  private static bool IsArrangedSafely(IntPtr hWnd) {
    try { return IsWindowArranged(hWnd); }
    // Older Windows versions do not export IsWindowArranged. Treat unknown as
    // arranged so the geometry pulse fails closed and cannot disturb placement.
    catch (EntryPointNotFoundException) { return true; }
  }

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
      if (show) {
        // SWP_SHOWWINDOW + SWP_NOACTIVATE preserves minimized/maximized/arranged
        // placement without taking keyboard focus from the requesting app.
        bool restored = SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0, SHOW_NO_ACTIVATE_FLAGS);
        bool pulsed = false;
        RECT rect;
        // RedrawWindow alone does not invalidate Chromium's DirectComposition
        // surface after a long SW_HIDE. A real one-pixel resize does, while the
        // NOACTIVATE/NOZORDER flags preserve the caller's foreground window.
        // Do not resize minimized, maximized, or snapped windows: their placement
        // is user-owned and a native redraw remains the safe fallback.
        if (!IsIconic(hWnd) && !IsZoomed(hWnd) && !IsArrangedSafely(hWnd)
            && GetWindowRect(hWnd, out rect)) {
          int width = rect.Right - rect.Left;
          int height = rect.Bottom - rect.Top;
          if (width > 1 && height > 1) {
            bool expanded = SetWindowPos(hWnd, IntPtr.Zero, 0, 0, width + 1, height, COMPOSITOR_PULSE_FLAGS);
            if (expanded) System.Threading.Thread.Sleep(80);
            bool restoredSize = SetWindowPos(hWnd, IntPtr.Zero, 0, 0, width, height, COMPOSITOR_PULSE_FLAGS);
            pulsed = expanded || restoredSize;
          }
        }
        bool redrawn = RedrawWindow(hWnd, IntPtr.Zero, IntPtr.Zero, 0x00000585);
        if (restored || pulsed || redrawn) changed++;
      }
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
  const lifetime = options.lifetime === true;
  const show = options.action === 'show' ? '$true' : '$false';
  const iterations = Number(options.iterations || 1);
  const intervalMs = Number(options.intervalMs || 100);
  const showFlagPath = String(options.showFlagPath || '').replace(/'/g, "''");
  const hideIfAllowed = `if (-not (Test-Path -LiteralPath '${showFlagPath}')) { [void][CursorBridgeWindowControl]::Apply(${targetPid}, $false) }`;
  const mutexName = `Local\\CursorBridgeMinimalGuard-${targetPid}`;
  const lifetimeLoop = [
    '$createdNew = $false',
    `$guardMutex = [System.Threading.Mutex]::new($true, '${mutexName}', [ref]$createdNew)`,
    'if (-not $createdNew) { $guardMutex.Dispose(); exit 0 }',
    'try {',
    '  while ($true) {',
    `    $target = Get-Process -Id ${targetPid} -ErrorAction SilentlyContinue`,
    "    if ($null -eq $target -or $target.ProcessName -ine 'Cursor') { break }",
    `    ${hideIfAllowed}`,
    `    Start-Sleep -Milliseconds ${intervalMs}`,
    '  }',
    '} finally {',
    '  try { $guardMutex.ReleaseMutex() } catch {}',
    '  $guardMutex.Dispose()',
    `  Remove-Item -LiteralPath '${showFlagPath}' -Force -ErrorAction SilentlyContinue`,
    '}',
  ].join('\n');
  const apply = lifetime
    ? lifetimeLoop
    : loop
      ? `for ($i = 0; $i -lt ${iterations}; $i++) { ${hideIfAllowed}; Start-Sleep -Milliseconds ${intervalMs} }`
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
  const showFlagPath = resolve(options.showFlagPath || join(dirname(resolveCursorRuntimeFile()), `show-${pid}.flag`));
  try {
    if (action === 'show') {
      mkdirSync(dirname(showFlagPath), { recursive: true });
      writeFileSync(showFlagPath, `${pid}\n`, { encoding: 'utf8', mode: 0o600 });
    } else {
      rmSync(showFlagPath, { force: true });
    }
  } catch (error) {
    return {
      supported: true,
      applied: false,
      action,
      port,
      pid,
      reason: `failed to update minimal-window override: ${error instanceof Error ? error.message : String(error)}`,
    };
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
    return { supported: true, applied: true, action, port, pid, changedWindows, showFlagPath };
  } catch (error) {
    if (action === 'show') rmSync(showFlagPath, { force: true });
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
  const lifetime = options.durationMs == null;
  const durationMs = lifetime
    ? null
    : Math.max(intervalMs, Math.min(120000, Number(options.durationMs)));
  const iterations = lifetime ? null : Math.ceil(durationMs / intervalMs);
  const showFlagPath = resolve(options.showFlagPath || join(dirname(resolveCursorRuntimeFile()), `show-${targetPid}.flag`));
  const spawnImpl = options.spawnImpl || spawn;
  try {
    const script = powershellWindowScript({
      pid: targetPid,
      loop: !lifetime,
      lifetime,
      iterations,
      intervalMs,
      showFlagPath,
    });
    const child = spawnImpl('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodePowerShell(script),
    ], { detached: !lifetime, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.once === 'function') child.once('error', () => {});
    if (!lifetime && child && typeof child.unref === 'function') child.unref();
    return {
      started: true,
      pid: child && child.pid || null,
      targetPid,
      lifetime,
      retainedBySupervisor: lifetime,
      durationMs,
      intervalMs,
      showFlagPath,
    };
  } catch (error) {
    return { started: false, targetPid, reason: error instanceof Error ? error.message : String(error) };
  }
}
