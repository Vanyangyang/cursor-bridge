import { createRequire } from 'module'; const require = createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// cursor-runtime.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync as mkdirSync2, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, dirname, join as join2, resolve } from "node:path";
function normalizeCursorRuntimeMode(value, fallback = "normal") {
  const normalized = String(value || "").trim().toLowerCase();
  return CURSOR_RUNTIME_MODES.includes(normalized) ? normalized : fallback;
}
function resolveCursorRuntimeFile(value = process.env.CURSOR_BRIDGE_RUNTIME_FILE) {
  const configured = String(value || "").trim();
  if (configured) return resolve(configured);
  const configRoot = process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || join2(homedir2(), ".config");
  return join2(configRoot, "cursor-bridge", "runtime.json");
}
function parseNetstatListeningPid(output, port) {
  const expectedPort = Number(port);
  if (!Number.isInteger(expectedPort) || expectedPort <= 0) return null;
  for (const line of String(output || "").split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || String(columns[0]).toUpperCase() !== "TCP") continue;
    const local = columns[1] || "";
    const state = String(columns[3] || "").toUpperCase();
    const pid = Number(columns[4]);
    const portMatch = local.match(/:(\d+)$/);
    if (state === "LISTENING" && portMatch && Number(portMatch[1]) === expectedPort && Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }
  return null;
}
function findCursorPidByPort(port, options = {}) {
  if ((options.platform || process.platform) !== "win32") return null;
  const run = options.execFileSyncImpl || execFileSync;
  try {
    const output = run("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return parseNetstatListeningPid(output, port);
  } catch {
    return null;
  }
}
function powershellWindowScript(options) {
  const targetPid = Number(options.pid);
  const loop = options.loop === true;
  const lifetime = options.lifetime === true;
  const show = options.action === "show" ? "$true" : "$false";
  const iterations = Number(options.iterations || 1);
  const intervalMs = Number(options.intervalMs || 100);
  const showFlagPath = String(options.showFlagPath || "").replace(/'/g, "''");
  const hideIfAllowed = `if (-not (Test-Path -LiteralPath '${showFlagPath}')) { [void][CursorBridgeWindowControl]::Apply(${targetPid}, $false) }`;
  const mutexName = `Local\\CursorBridgeMinimalGuard-${targetPid}`;
  const lifetimeLoop = [
    "$createdNew = $false",
    `$guardMutex = [System.Threading.Mutex]::new($true, '${mutexName}', [ref]$createdNew)`,
    "if (-not $createdNew) { $guardMutex.Dispose(); exit 0 }",
    "try {",
    "  while ($true) {",
    `    $target = Get-Process -Id ${targetPid} -ErrorAction SilentlyContinue`,
    "    if ($null -eq $target -or $target.ProcessName -ine 'Cursor') { break }",
    `    ${hideIfAllowed}`,
    `    Start-Sleep -Milliseconds ${intervalMs}`,
    "  }",
    "} finally {",
    "  try { $guardMutex.ReleaseMutex() } catch {}",
    "  $guardMutex.Dispose()",
    `  Remove-Item -LiteralPath '${showFlagPath}' -Force -ErrorAction SilentlyContinue`,
    "}"
  ].join("\n");
  const apply = lifetime ? lifetimeLoop : loop ? `for ($i = 0; $i -lt ${iterations}; $i++) { ${hideIfAllowed}; Start-Sleep -Milliseconds ${intervalMs} }` : `$changed = [CursorBridgeWindowControl]::Apply(${targetPid}, ${show}); [Console]::Out.Write($changed)`;
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOW_CONTROL_TYPE}
'@
${apply}`;
}
function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}
function setCursorWindowPresentation(options = {}) {
  const platform = options.platform || process.platform;
  const action = String(options.action || "").trim().toLowerCase();
  if (!["hide", "show"].includes(action)) throw new Error(`unsupported Cursor window action: ${options.action}`);
  if (platform !== "win32") {
    return { supported: false, applied: false, action, reason: `window control is not implemented for ${platform}` };
  }
  const port = Number(options.port || 9223);
  const pid = Number(options.pid || findCursorPidByPort(port, options));
  if (!Number.isInteger(pid) || pid <= 0) {
    return { supported: true, applied: false, action, port, reason: `no listening Cursor PID found on CDP ${port}` };
  }
  const showFlagPath = resolve(options.showFlagPath || join2(dirname(resolveCursorRuntimeFile()), `show-${pid}.flag`));
  try {
    if (action === "show") {
      mkdirSync2(dirname(showFlagPath), { recursive: true });
      writeFileSync(showFlagPath, `${pid}
`, { encoding: "utf8", mode: 384 });
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
      reason: `failed to update minimal-window override: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const run = options.execFileSyncImpl || execFileSync;
  try {
    const script = powershellWindowScript({ pid, action });
    const output = run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(script)
    ], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Number(options.timeoutMs || 15e3)
    });
    const changedWindows = Number(String(output || "").trim() || 0);
    return { supported: true, applied: true, action, port, pid, changedWindows, showFlagPath };
  } catch (error) {
    if (action === "show") rmSync(showFlagPath, { force: true });
    return {
      supported: true,
      applied: false,
      action,
      port,
      pid,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
function startMinimalWindowGuard(pid, options = {}) {
  if ((options.platform || process.platform) !== "win32") return { started: false, reason: "unsupported-platform" };
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return { started: false, reason: "invalid-pid" };
  const intervalMs = Math.max(50, Math.min(1e3, Number(options.intervalMs || 100)));
  const lifetime = options.durationMs == null;
  const durationMs = lifetime ? null : Math.max(intervalMs, Math.min(12e4, Number(options.durationMs)));
  const iterations = lifetime ? null : Math.ceil(durationMs / intervalMs);
  const showFlagPath = resolve(options.showFlagPath || join2(dirname(resolveCursorRuntimeFile()), `show-${targetPid}.flag`));
  const spawnImpl = options.spawnImpl || spawn;
  try {
    const script = powershellWindowScript({
      pid: targetPid,
      loop: !lifetime,
      lifetime,
      iterations,
      intervalMs,
      showFlagPath
    });
    const child = spawnImpl("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(script)
    ], { detached: !lifetime, stdio: "ignore", windowsHide: true });
    if (child && typeof child.once === "function") child.once("error", () => {
    });
    if (!lifetime && child && typeof child.unref === "function") child.unref();
    return {
      started: true,
      pid: child && child.pid || null,
      targetPid,
      lifetime,
      retainedBySupervisor: lifetime,
      durationMs,
      intervalMs,
      showFlagPath
    };
  } catch (error) {
    return { started: false, targetPid, reason: error instanceof Error ? error.message : String(error) };
  }
}
var CURSOR_RUNTIME_MODES, WINDOW_CONTROL_TYPE;
var init_cursor_runtime = __esm({
  "cursor-runtime.mjs"() {
    CURSOR_RUNTIME_MODES = Object.freeze(["normal", "minimal"]);
    WINDOW_CONTROL_TYPE = String.raw`
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
        // An already-visible Cursor window is user-owned. Resizing or redrawing
        // it dismisses active Electron menus and popovers, so presentation
        // recovery must be a strict no-op unless SW_HIDE actually hid it.
        if (visible) return true;
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
  }
});

// cursor-ensure-core.mjs
var cursor_ensure_core_exports = {};
__export(cursor_ensure_core_exports, {
  CDP_HOST: () => CDP_HOST,
  CDP_ORIGIN: () => CDP_ORIGIN,
  CDP_PORT: () => CDP_PORT,
  cdpIsCursor: () => cdpIsCursor,
  cdpUp: () => cdpUp,
  cursorRunning: () => cursorRunning,
  ensureCursorRunningLocal: () => ensureCursorRunningLocal,
  findCursorExe: () => findCursorExe,
  findCursorExeDetails: () => findCursorExeDetails,
  isAgentsWindowTitle: () => isAgentsWindowTitle,
  looksLikePluginRuntimePath: () => looksLikePluginRuntimePath,
  normalizeCodexThreadCwd: () => normalizeCodexThreadCwd,
  normalizeCursorExeCandidate: () => normalizeCursorExeCandidate,
  resolveCodexThreadProjectPath: () => resolveCodexThreadProjectPath,
  resolveCursorLaunchCdpPort: () => resolveCursorLaunchCdpPort,
  resolveProjectPath: () => resolveProjectPath,
  selectAgentsWindowTarget: () => selectAgentsWindowTarget,
  selectNewCdpTarget: () => selectNewCdpTarget,
  selectReusableProjectTarget: () => selectReusableProjectTarget,
  targetCanServeProject: () => targetCanServeProject,
  targetTitleMatchesProject: () => targetTitleMatchesProject,
  waitForCdp: () => waitForCdp
});
import { spawn as spawn2, execFileSync as execFileSync2 } from "child_process";
import { existsSync } from "fs";
import { createRequire as createNodeRequire } from "node:module";
import { homedir as homedir3 } from "node:os";
import { basename as basename2, extname, join as join3, resolve as resolve2, win32 as winPath, posix as posixPath } from "node:path";
import http from "http";
function resolveCursorLaunchCdpPort(port = process.env.CURSOR_BRIDGE_CDP_PORT) {
  const parsed = Number(port == null || String(port).trim() === "" ? 9223 : port);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return 9223;
  return parsed;
}
function looksLikePluginRuntimePath(candidate) {
  const p = String(candidate || "").replace(/\//g, "\\").toLowerCase();
  return p.includes("\\.codex\\.tmp\\marketplaces\\") || p.includes("\\.codex\\plugins\\cache\\") || p.includes("\\.claude\\plugins\\cache\\") || p.includes("\\appdata\\local\\npm-cache\\_npx\\");
}
function normalizeCodexThreadCwd(value) {
  const raw = String(value || "").trim();
  if (/^\\\\\?\\UNC\\/i.test(raw)) return `\\\\${raw.slice(8)}`;
  if (/^\\\\\?\\[a-zA-Z]:\\/.test(raw)) return raw.slice(4);
  return raw;
}
function resolveCodexThreadProjectPath(options = {}) {
  const threadId = String(options.threadId ?? process.env.CODEX_THREAD_ID ?? "").trim();
  if (!threadId) return null;
  if (CODEX_THREAD_PROJECTS.has(threadId) && options.useCache !== false) {
    return CODEX_THREAD_PROJECTS.get(threadId);
  }
  let database = null;
  try {
    const lookupThreadCwd = options.lookupThreadCwd || ((id) => {
      const { DatabaseSync } = (options.requireImpl || loadModule)("node:sqlite");
      const databasePath = options.databasePath || join3(homedir3(), ".codex", "state_5.sqlite");
      database = new DatabaseSync(databasePath, { readOnly: true });
      return database.prepare("SELECT cwd FROM threads WHERE id = ?").get(id)?.cwd || null;
    });
    const candidate = normalizeCodexThreadCwd(lookupThreadCwd(threadId));
    const existsImpl = options.existsImpl || existsSync;
    const resolved = candidate && !looksLikePluginRuntimePath(candidate) && existsImpl(candidate) ? resolve2(candidate) : null;
    if (options.useCache !== false) CODEX_THREAD_PROJECTS.set(threadId, resolved);
    return resolved;
  } catch {
    if (options.useCache !== false) CODEX_THREAD_PROJECTS.set(threadId, null);
    return null;
  } finally {
    try {
      database?.close();
    } catch {
    }
  }
}
function resolveProjectPath(value = process.env.CURSOR_PROJECT_PATH, options = {}) {
  const explicit = String(value || "").trim();
  if (explicit) return resolve2(explicit);
  const persisted = String(options.persistedProjectPath || "").trim();
  if (persisted) return resolve2(normalizeCodexThreadCwd(persisted));
  const threadProjectPath = options.threadProjectPath === void 0 ? resolveCodexThreadProjectPath(options) : options.threadProjectPath;
  if (threadProjectPath) return resolve2(normalizeCodexThreadCwd(threadProjectPath));
  const cwd = options.cwd ?? process.cwd();
  if (!cwd || looksLikePluginRuntimePath(cwd)) return null;
  return resolve2(cwd);
}
function cursorFromRegistry(options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync2;
  const legacyExecSyncImpl = options.execSyncImpl;
  const existsImpl = options.existsImpl || existsSync;
  const queries = [
    ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe", "/ve"],
    ["HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe", "/ve"],
    ["HKCU\\Software\\Classes\\cursor\\shell\\open\\command", "/ve"],
    ["HKLM\\Software\\Classes\\cursor\\shell\\open\\command", "/ve"],
    ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor (User)", "/v", "DisplayIcon"],
    ["HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor", "/v", "DisplayIcon"]
  ];
  for (const [key, ...valueArgs] of queries) {
    try {
      const runOptions = {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      };
      const out = legacyExecSyncImpl && !options.execFileSyncImpl ? legacyExecSyncImpl(`reg query "${key}" ${valueArgs.join(" ")}`, runOptions) : execFileSyncImpl("reg.exe", ["query", key, ...valueArgs], runOptions);
      const m = out.match(/([A-Za-z]:\\[^"\r\n]*?Cursor\.exe)/i);
      if (m && existsImpl(m[1])) return m[1];
    } catch {
    }
  }
  return null;
}
function normalizeCursorExeCandidate(value, options = {}) {
  const platform = options.platform || process.platform;
  const existsImpl = options.existsImpl || existsSync;
  const raw = String(value || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!raw) return null;
  let candidates;
  if (platform === "win32") {
    const normalized = raw.replace(/\//g, "\\");
    candidates = /\.exe$/i.test(normalized) ? [normalized] : [winPath.join(normalized, "Cursor.exe")];
  } else if (platform === "darwin") {
    const normalized = raw.replace(/\\/g, "/").replace(/\/$/, "");
    candidates = /\.app$/i.test(normalized) ? [posixPath.join(normalized, "Contents", "MacOS", "Cursor")] : /\/Contents\/MacOS$/i.test(normalized) ? [posixPath.join(normalized, "Cursor")] : [normalized];
  } else {
    candidates = [raw];
  }
  for (const candidate of candidates) {
    try {
      if (existsImpl(candidate)) return candidate;
    } catch {
    }
  }
  return null;
}
function findCursorExeDetails(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const existsImpl = options.existsImpl || existsSync;
  const override = normalizeCursorExeCandidate(env.CURSOR_EXE, { platform, existsImpl });
  if (override) return { path: override, source: "CURSOR_EXE", platform };
  if (platform === "win32") {
    const fromReg = cursorFromRegistry({
      execFileSyncImpl: options.execFileSyncImpl,
      execSyncImpl: options.execSyncImpl,
      existsImpl
    });
    if (fromReg) return { path: fromReg, source: "windows_registry", platform };
    const localAppData = env.LOCALAPPDATA || join3(homedir3(), "AppData", "Local");
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || env.PROGRAMFILES_X86 || "";
    const candidates = [
      localAppData && winPath.join(localAppData, "Programs", "Cursor", "Cursor.exe"),
      programFiles && winPath.join(programFiles, "Cursor", "Cursor.exe"),
      programFilesX86 && winPath.join(programFilesX86, "Cursor", "Cursor.exe")
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (existsImpl(candidate)) return { path: candidate, source: "windows_standard_location", platform };
      } catch {
      }
    }
    return null;
  }
  if (platform === "darwin") {
    const userHome = env.HOME || homedir3();
    const candidates = [
      "/Applications/Cursor.app/Contents/MacOS/Cursor",
      userHome && posixPath.join(userHome, "Applications", "Cursor.app", "Contents", "MacOS", "Cursor")
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (existsImpl(candidate)) return { path: candidate, source: "macos_standard_location", platform };
      } catch {
      }
    }
    return null;
  }
  return null;
}
function findCursorExe(options = {}) {
  return findCursorExeDetails(options)?.path || null;
}
function cdpUp(timeoutMs = 1500) {
  return new Promise((resolve3) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: "/json/version" }, (res) => {
      res.resume();
      resolve3(res.statusCode === 200);
    });
    req.on("error", () => resolve3(false));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy();
      } catch {
      }
      resolve3(false);
    });
  });
}
function cdpIsCursor(timeoutMs = 1500) {
  return new Promise((resolve3) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: "/json/list" }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          if (/[\/\\](windsurf)[\/\\]/i.test(d)) return resolve3(false);
          resolve3(/[\/\\]cursor[\/\\](resources|app)|cursor\.exe|vscode-app[^"]*[\/\\]cursor[\/\\]/i.test(d));
        } catch {
          resolve3(false);
        }
      });
    });
    req.on("error", () => resolve3(false));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy();
      } catch {
      }
      resolve3(false);
    });
  });
}
function cursorRunning(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.execFileSyncImpl || execFileSync2;
  try {
    if (platform === "win32") {
      return /Cursor\.exe/i.test(run("tasklist.exe", ["/fi", "imagename eq Cursor.exe", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }));
    }
    if (platform === "darwin") {
      run("pgrep", ["-f", "Cursor.app/Contents/MacOS/Cursor"], { stdio: "ignore" });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
async function waitForCdp(maxMs = 3e4, stepMs = 1e3) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await cdpUp()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
async function spawnDetachedSafely(spawnImpl, file, args, spawnOptions) {
  let child;
  try {
    child = spawnImpl(file, args, spawnOptions);
  } catch (error) {
    return {
      ok: false,
      child: null,
      error,
      errorCode: error && typeof error === "object" && error.code != null ? String(error.code) : null
    };
  }
  if (child && typeof child.once === "function") {
    const startup = await new Promise((resolvePromise) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        child.off?.("spawn", onSpawn);
        child.off?.("error", onError);
        resolvePromise(result);
      };
      const onSpawn = () => finish({ ok: true });
      const onError = (error) => finish({ ok: false, error });
      child.once("spawn", onSpawn);
      child.once("error", onError);
      if (Number.isInteger(child.pid) && child.pid > 0) queueMicrotask(onSpawn);
    });
    if (!startup.ok) {
      return {
        ok: false,
        child,
        error: startup.error,
        errorCode: startup.error && typeof startup.error === "object" && startup.error.code != null ? String(startup.error.code) : null
      };
    }
    child.once("error", () => {
    });
  }
  if (child && typeof child.unref === "function") child.unref();
  return { ok: true, child };
}
function attachedPresentation(runtimeMode, port) {
  if (runtimeMode !== "minimal") return null;
  return {
    supported: true,
    applied: false,
    action: "hide",
    port,
    reason: "attached lifecycle cannot start the PowerShell window guard under the current process policy"
  };
}
async function ensureCursorRunningLocal(options = {}) {
  const waitMs = Number(options.waitMs || 3e4);
  const runtimeMode = options.runtimeMode || "normal";
  const effectiveRuntimeMode = normalizeCursorRuntimeMode(runtimeMode);
  const cdpUpImpl = options.cdpUpImpl || cdpUp;
  const cdpIsCursorImpl = options.cdpIsCursorImpl || cdpIsCursor;
  const cursorRunningImpl = options.cursorRunningImpl || cursorRunning;
  const findCursorExeDetailsImpl = options.findCursorExeDetailsImpl || findCursorExeDetails;
  const projectPath = Object.hasOwn(options, "projectPath") ? options.projectPath ? resolve2(String(options.projectPath)) : null : resolveProjectPath();
  const listCdpPageTargetsImpl = options.listCdpPageTargetsImpl || listCdpPageTargets;
  const spawnImpl = options.spawnImpl || spawn2;
  const sleepImpl = options.sleepImpl || ((ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)));
  const waitForCdpImpl = options.waitForCdpImpl || waitForCdp;
  const findCursorPidByPortImpl = options.findCursorPidByPortImpl || findCursorPidByPort;
  const allowSpawn = options.allowSpawn !== false;
  const allowProcessControl = options.allowProcessControl !== false;
  if (await cdpUpImpl()) {
    const isCursor = await cdpIsCursorImpl();
    if (isCursor) {
      const cursorPid2 = allowProcessControl ? findCursorPidByPortImpl(CDP_PORT) : null;
      const windowGuard2 = allowProcessControl && effectiveRuntimeMode === "minimal" && cursorPid2 ? startMinimalWindowGuard(cursorPid2) : null;
      const presentation2 = effectiveRuntimeMode === "minimal" ? allowProcessControl ? setCursorWindowPresentation({ action: "hide", port: CDP_PORT, pid: cursorPid2 }) : attachedPresentation(effectiveRuntimeMode, CDP_PORT) : null;
      let currentTargets = await listCdpPageTargetsImpl();
      const projectKey = normalizeProjectKey(projectPath);
      let targetId2 = projectKey ? PROJECT_TARGETS.get(projectKey) || null : currentTargets[0] && currentTargets[0].id || null;
      let workspaceAction = projectPath ? "reused-project-target" : "reused-last-workspace";
      const cachedTarget = targetId2 ? currentTargets.find((target2) => target2.id === targetId2) : null;
      if (targetId2 && (!cachedTarget || projectPath && !targetCanServeProject(cachedTarget.title, projectPath))) {
        PROJECT_TARGETS.delete(projectKey);
        targetId2 = null;
      } else if (targetId2 && cachedTarget && isAgentsWindowTitle(cachedTarget.title)) {
        workspaceAction = "reused-agents-window";
      }
      if (projectPath && !targetId2) {
        const existingTarget = selectReusableProjectTarget(currentTargets, projectPath);
        if (existingTarget) {
          targetId2 = existingTarget.id;
          PROJECT_TARGETS.set(projectKey, targetId2);
          workspaceAction = isAgentsWindowTitle(existingTarget.title) ? "reused-agents-window" : "recovered-project-target";
        }
      }
      if (projectPath && existsSync(projectPath) && !targetId2) {
        if (!allowSpawn) {
          return {
            ok: false,
            status: "workspace-not-ready",
            port: CDP_PORT,
            cursorPid: cursorPid2,
            runtimeMode: effectiveRuntimeMode,
            projectPath,
            presentation: presentation2,
            windowGuard: windowGuard2,
            needsAction: "open_workspace_in_cursor",
            retryable: true,
            nextStep: `Open workspace ${projectPath} in the existing Cursor Agents Window, then retry the same operation.`,
            message: `CCE connected to Cursor, but the current workspace target for ${projectPath} is not ready and the current lifecycle cannot open a new window.`
          };
        }
        const cursorExecutable2 = findCursorExeDetailsImpl();
        const exe2 = cursorExecutable2 && cursorExecutable2.path;
        if (!exe2) {
          return {
            ok: false,
            status: "workspace-not-ready",
            port: CDP_PORT,
            cursorPid: cursorPid2,
            runtimeMode: effectiveRuntimeMode,
            projectPath,
            presentation: presentation2,
            windowGuard: windowGuard2,
            needsAction: "install_or_locate_cursor",
            retryable: true,
            nextStep: "Confirm that Cursor is installed and signed in. For a portable or custom installation, set CURSOR_EXE and run the same initialization command again.",
            message: `CCE connected to Cursor but cannot open workspace ${projectPath} because the Cursor executable was not found.`
          };
        }
        const settleAttempts = Math.max(1, Number(options.targetSettleAttempts ?? 8));
        const settleDelayMs = Math.max(0, Number(options.targetSettleDelayMs ?? 250));
        for (let attempt = 0; attempt < settleAttempts && !targetId2; attempt++) {
          if (attempt > 0 && settleDelayMs > 0) await sleepImpl(settleDelayMs);
          currentTargets = await listCdpPageTargetsImpl();
          const reusable = selectReusableProjectTarget(currentTargets, projectPath);
          if (reusable) {
            targetId2 = reusable.id;
            PROJECT_TARGETS.set(projectKey, targetId2);
            workspaceAction = isAgentsWindowTitle(reusable.title) ? "reused-agents-window" : "recovered-project-target";
          }
        }
        if (targetId2) {
          return {
            ok: true,
            status: "already",
            port: CDP_PORT,
            cursorPid: cursorPid2,
            runtimeMode: effectiveRuntimeMode,
            projectPath,
            presentation: presentation2,
            windowGuard: windowGuard2,
            targetId: targetId2,
            workspaceAction,
            message: workspaceAction === "reused-agents-window" ? `CDP ${CDP_PORT} responded as Cursor; Agents Window ${targetId2} was reused without opening another IDE window.` : `CDP ${CDP_PORT} responded as Cursor; the target workspace is bound to CDP target ${targetId2}.`
          };
        }
        const reused = await spawnDetachedSafely(spawnImpl, exe2, ["--reuse-window", projectPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: effectiveRuntimeMode === "minimal"
        });
        if (!reused.ok) {
          return {
            ok: false,
            status: "spawn-blocked",
            port: CDP_PORT,
            cursorPid: cursorPid2,
            runtimeMode: effectiveRuntimeMode,
            projectPath,
            presentation: presentation2,
            windowGuard: windowGuard2,
            errorCode: reused.errorCode,
            needsAction: "open_workspace_in_cursor",
            retryable: true,
            nextStep: `Open workspace ${projectPath} in Cursor, then retry the same operation.`,
            message: `Cursor Bridge could not reuse the existing Cursor window for the workspace: ${reused.error instanceof Error ? reused.error.message : String(reused.error)}`
          };
        }
        workspaceAction = "reused-window-for-project";
        const reusedTarget = await waitForProjectCdpTarget(12e3, projectPath, listCdpPageTargetsImpl, sleepImpl);
        if (!reusedTarget) {
          return {
            ok: false,
            status: "workspace-not-ready",
            port: CDP_PORT,
            cursorPid: cursorPid2,
            runtimeMode: effectiveRuntimeMode,
            projectPath,
            presentation: presentation2,
            windowGuard: windowGuard2,
            workspaceAction,
            cursorExecutable: exe2,
            cursorExecutableSource: cursorExecutable2.source,
            needsAction: "retry_initialization",
            retryable: true,
            nextStep: "Wait for Cursor to finish opening the project, then run the same initialization command again.",
            message: `Cursor opened the project, but CCE has not confirmed that workspace ${projectPath} is ready. Initialization stopped safely to avoid searching the wrong project.`
          };
        }
        targetId2 = reusedTarget.id;
        PROJECT_TARGETS.set(projectKey, targetId2);
      }
      return {
        ok: true,
        status: "already",
        port: CDP_PORT,
        cursorPid: cursorPid2,
        runtimeMode: effectiveRuntimeMode,
        projectPath,
        presentation: presentation2,
        windowGuard: windowGuard2,
        targetId: targetId2,
        workspaceAction,
        message: workspaceAction === "reused-agents-window" ? `CDP ${CDP_PORT} responded as Cursor; Agents Window ${targetId2} was reused without opening another IDE window.` : `CDP ${CDP_PORT} responded as Cursor; the target workspace is bound to CDP target ${targetId2 || "default"}.`
      };
    }
    return {
      ok: false,
      status: "port-not-cursor",
      port: CDP_PORT,
      needsAction: "free_cce_port",
      retryable: true,
      nextStep: `Local port ${CDP_PORT} is in use by another program. Close that program, then run the same initialization command again.`,
      message: `CCE cannot connect to Cursor because required local port ${CDP_PORT} is occupied by another program.`
    };
  }
  if (!allowSpawn) {
    return {
      ok: false,
      status: "external-launch-required",
      port: CDP_PORT,
      cursorPid: null,
      runtimeMode: effectiveRuntimeMode,
      projectPath,
      presentation: attachedPresentation(effectiveRuntimeMode, CDP_PORT),
      needsAction: "launch_cursor_with_cdp",
      retryable: true,
      nextStep: `Start Cursor with its remote debugging connection on port ${CDP_PORT}, open ${projectPath || "the target workspace"}, then retry the same operation.`,
      message: `Cursor is not reachable on the configured CDP port ${CDP_PORT}, and the current lifecycle policy cannot launch it.`
    };
  }
  if (cursorRunningImpl()) {
    const cursorExecutable2 = findCursorExeDetailsImpl();
    return {
      ok: false,
      status: "running-no-debug",
      port: CDP_PORT,
      cursorExecutable: cursorExecutable2 && cursorExecutable2.path || null,
      cursorExecutableSource: cursorExecutable2 && cursorExecutable2.source || null,
      needsAction: "close_cursor_and_retry",
      retryable: true,
      nextStep: projectPath ? `Save your work, exit Cursor normally once, then initialize CCE for workspace ${projectPath} again.` : "Save your work, exit Cursor normally once, then retry the previous CCE operation.",
      message: "Cursor was already running, so CCE cannot add the required connection capability in place. Cursor Bridge will not force-close it, protecting unsaved work."
    };
  }
  const cursorExecutable = findCursorExeDetailsImpl();
  const exe = cursorExecutable && cursorExecutable.path;
  if (!exe) {
    return {
      ok: false,
      status: "no-exe",
      port: CDP_PORT,
      needsAction: "install_or_locate_cursor",
      retryable: true,
      nextStep: "Install and sign in to Cursor first. For a portable or custom installation, set CURSOR_EXE and run the same initialization command again.",
      message: "Cursor was not found. Standard Windows and macOS installations are detected automatically and normally do not require an explicit executable path."
    };
  }
  const launchPort = resolveCursorLaunchCdpPort(CDP_PORT);
  const args = [`--remote-debugging-port=${launchPort}`, `--remote-allow-origins=http://localhost:${launchPort}`];
  if (effectiveRuntimeMode === "minimal") {
    args.push(
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows"
    );
  }
  const launched = await spawnDetachedSafely(spawnImpl, exe, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: effectiveRuntimeMode === "minimal"
  });
  if (!launched.ok) {
    return {
      ok: false,
      status: "spawn-blocked",
      exe,
      port: CDP_PORT,
      cursorPid: null,
      runtimeMode: effectiveRuntimeMode,
      projectPath,
      errorCode: launched.errorCode,
      needsAction: "launch_cursor_manually",
      retryable: true,
      nextStep: `Start Cursor with its remote debugging connection on port ${CDP_PORT}, then retry the same operation.`,
      message: `Cursor Bridge could not launch Cursor: ${launched.error instanceof Error ? launched.error.message : String(launched.error)}`
    };
  }
  const child = launched.child;
  const startupWindowGuard = effectiveRuntimeMode === "minimal" ? startMinimalWindowGuard(child && child.pid) : null;
  const up = await waitForCdpImpl(waitMs);
  if (!up) {
    return {
      ok: false,
      status: "timeout",
      exe,
      port: CDP_PORT,
      cursorPid: child.pid || null,
      runtimeMode: effectiveRuntimeMode,
      projectPath,
      windowGuard: startupWindowGuard,
      cursorExecutable: exe,
      cursorExecutableSource: cursorExecutable.source,
      needsAction: "retry_initialization",
      retryable: true,
      nextStep: "Wait a moment, then run the same initialization command again.",
      message: "Cursor started, but CCE is not ready yet. No port setting needs to be changed."
    };
  }
  const cursorPid = findCursorPidByPortImpl(CDP_PORT) || child.pid || null;
  const openedTarget = await waitForNewCdpTarget(/* @__PURE__ */ new Set(), 12e3, projectPath, listCdpPageTargetsImpl);
  const targetId = openedTarget && openedTarget.id || null;
  if (projectPath && !targetId) {
    return {
      ok: false,
      status: "workspace-not-ready",
      exe,
      port: CDP_PORT,
      cursorPid,
      runtimeMode: effectiveRuntimeMode,
      projectPath,
      windowGuard: startupWindowGuard,
      cursorExecutable: exe,
      cursorExecutableSource: cursorExecutable.source,
      needsAction: "retry_initialization",
      retryable: true,
      nextStep: "Wait for Cursor to finish opening the project, then run the same initialization command again.",
      message: `Cursor started, but CCE has not confirmed that workspace ${projectPath} is ready. Initialization stopped safely to avoid searching the wrong project.`
    };
  }
  if (projectPath && targetId) PROJECT_TARGETS.set(normalizeProjectKey(projectPath), targetId);
  const windowGuard = effectiveRuntimeMode === "minimal" && cursorPid ? startMinimalWindowGuard(cursorPid) : null;
  const launchedIntoAgents = !!(projectPath && openedTarget && isAgentsWindowTitle(openedTarget.title));
  const target = launchedIntoAgents ? `restoring one Agents Window for ${projectPath}` : projectPath ? `opening ${projectPath}` : "restoring the previous workspace";
  const presentation = effectiveRuntimeMode === "minimal" ? setCursorWindowPresentation({ action: "hide", port: CDP_PORT, pid: cursorPid }) : null;
  return {
    ok: true,
    status: "launched",
    exe,
    port: CDP_PORT,
    cursorPid,
    runtimeMode: effectiveRuntimeMode,
    projectPath,
    presentation,
    windowGuard,
    startupWindowGuard,
    cursorExecutable: exe,
    cursorExecutableSource: cursorExecutable.source,
    targetId,
    workspaceAction: launchedIntoAgents ? "launched-agents-window" : projectPath ? "launched-project" : "launched-last-workspace",
    message: `Cursor started (${exe}, ${target}); CDP ${CDP_PORT} is ready.`
  };
}
function normalizeProjectKey(projectPath) {
  return projectPath ? resolve2(String(projectPath)).replace(/\\/g, "/").toLowerCase() : "";
}
function targetTitleMatchesProject(title, projectPath) {
  const name = basename2(String(projectPath || "")).trim().toLowerCase();
  if (!name) return false;
  const extension = extname(name);
  const candidates = [...new Set([name, extension ? name.slice(0, -extension.length) : name].filter(Boolean))];
  const normalizedTitle = String(title || "").trim().toLowerCase();
  return candidates.some((candidate) => normalizedTitle === candidate || normalizedTitle.startsWith(candidate + " - ") || normalizedTitle.includes(" - " + candidate + " - "));
}
function isAgentsWindowTitle(title) {
  const normalized = String(title || "").trim().toLowerCase();
  return normalized === "cursor agents" || normalized.startsWith("cursor agents - ");
}
function targetCanServeProject(title, projectPath) {
  if (!projectPath) return true;
  return targetTitleMatchesProject(title, projectPath) || isAgentsWindowTitle(title);
}
function selectAgentsWindowTarget(targets) {
  return (Array.isArray(targets) ? targets : []).find((target) => target && target.id && isAgentsWindowTitle(target.title)) || null;
}
function selectReusableProjectTarget(targets, projectPath) {
  const pages = Array.isArray(targets) ? targets : [];
  return pages.find((target) => target && target.id && targetTitleMatchesProject(target.title, projectPath)) || selectAgentsWindowTarget(pages) || null;
}
async function listCdpPageTargets(timeoutMs = 1500) {
  return new Promise((done) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: "/json/list" }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const targets = JSON.parse(data);
          done(Array.isArray(targets) ? targets.filter((target) => target && target.type === "page" && target.id) : []);
        } catch {
          done([]);
        }
      });
    });
    req.on("error", () => done([]));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy();
      } catch {
      }
      done([]);
    });
  });
}
function selectNewCdpTarget(beforeTargetIds, targets, projectPath = "") {
  const before = beforeTargetIds instanceof Set ? beforeTargetIds : new Set(beforeTargetIds || []);
  const fresh = (targets || []).filter((target) => target && target.id && !before.has(target.id));
  if (projectPath) return selectReusableProjectTarget(fresh, projectPath);
  return fresh[0] || null;
}
async function waitForNewCdpTarget(beforeTargetIds, maxMs = 12e3, projectPath = "", listImpl = listCdpPageTargets) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const target = selectNewCdpTarget(beforeTargetIds, await listImpl(), projectPath);
    if (target) return target;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  return null;
}
async function waitForProjectCdpTarget(maxMs, projectPath, listImpl = listCdpPageTargets, sleepImpl = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const target = selectReusableProjectTarget(await listImpl(), projectPath);
    if (target) return target;
    await sleepImpl(300);
  }
  return null;
}
var CDP_PORT, CDP_ORIGIN, CDP_HOST, PROJECT_TARGETS, CODEX_THREAD_PROJECTS, loadModule;
var init_cursor_ensure_core = __esm({
  "cursor-ensure-core.mjs"() {
    init_cursor_runtime();
    CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
    CDP_ORIGIN = `http://localhost:${CDP_PORT}`;
    CDP_HOST = "127.0.0.1";
    PROJECT_TARGETS = /* @__PURE__ */ new Map();
    CODEX_THREAD_PROJECTS = /* @__PURE__ */ new Map();
    loadModule = createNodeRequire(import.meta.url);
  }
});

// cursor-lifecycle-supervisor.mjs
import net from "node:net";
import {
  writeFileSync as writeFileSync2,
  unlinkSync,
  existsSync as existsSync2,
  openSync,
  closeSync,
  readFileSync as readFileSync2,
  appendFileSync,
  renameSync as renameSync2,
  statSync
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// lifecycle-paths.mjs
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
function defaultLifecycleDir() {
  if (process.env.CURSOR_BRIDGE_LIFECYCLE_DIR) return process.env.CURSOR_BRIDGE_LIFECYCLE_DIR;
  if (process.platform === "win32") {
    const root2 = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(root2, "cursor-bridge", "lifecycle");
  }
  const root = process.env.XDG_RUNTIME_DIR || process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(root, "cursor-bridge", "lifecycle");
}
function ensureLifecycleDir(dir = defaultLifecycleDir()) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
function lifecycleEndpointTag(dir) {
  return createHash("sha256").update(String(dir), "utf8").digest("hex").slice(0, 24);
}
function supervisorSockPath(dir = defaultLifecycleDir()) {
  if (process.env.CURSOR_BRIDGE_SUPERVISOR_SOCK) return process.env.CURSOR_BRIDGE_SUPERVISOR_SOCK;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\cursor-bridge-lifecycle-${lifecycleEndpointTag(dir)}`;
  }
  return join(dir, "supervisor.sock");
}
function supervisorPidPath(dir = defaultLifecycleDir()) {
  return join(dir, "supervisor.pid");
}
function supervisorLockPath(dir = defaultLifecycleDir()) {
  return join(dir, "supervisor.lock");
}
function supervisorLogPath(dir = defaultLifecycleDir()) {
  return join(dir, "supervisor.log");
}

// cursor-lifecycle-supervisor.mjs
var LOG_MAX_BYTES = 256 * 1024;
function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--lifecycle-supervisor") continue;
    if (a.startsWith("--lifecycle-dir=")) out.dir = a.slice("--lifecycle-dir=".length);
    else if (a === "--lifecycle-dir") out.dir = argv[++i];
    else if (a.startsWith("--sock=")) out.sock = a.slice("--sock=".length);
    else if (a === "--sock") out.sock = argv[++i];
    else if (a.startsWith("--boot-env=")) out.bootEnv = a.slice("--boot-env=".length);
    else if (a === "--boot-env") out.bootEnv = argv[++i];
    else if (a.startsWith("--ensure-module=")) out.ensureModule = a.slice("--ensure-module=".length);
    else if (a === "--ensure-module") out.ensureModule = argv[++i];
    else if (a.startsWith("--idle-ms=")) out.idleMs = Number(a.slice("--idle-ms=".length));
    else if (a === "--idle-ms") out.idleMs = Number(argv[++i]);
    else if (a.startsWith("--runtime-fingerprint=")) out.runtimeFingerprint = a.slice("--runtime-fingerprint=".length);
    else if (a === "--runtime-fingerprint") out.runtimeFingerprint = argv[++i];
  }
  return out;
}
function tryRemove(path) {
  try {
    if (path && existsSync2(path)) unlinkSync(path);
  } catch {
  }
}
function applyBootEnv(bootEnvPath) {
  if (!bootEnvPath || !existsSync2(bootEnvPath)) return { applied: false, deleted: false };
  try {
    const parsed = JSON.parse(readFileSync2(bootEnvPath, "utf8"));
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (value == null) continue;
        if (process.env[key] == null || process.env[key] === "") {
          process.env[key] = String(value);
        }
      }
    }
    tryRemove(bootEnvPath);
    return { applied: true, deleted: !existsSync2(bootEnvPath) };
  } catch (error) {
    console.error("[cursor-lifecycle-supervisor] boot-env read failed:", error instanceof Error ? error.message : error);
    return { applied: false, deleted: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function rotateLogIfNeeded(logPath) {
  try {
    if (!existsSync2(logPath)) return;
    const size = statSync(logPath).size;
    if (size < LOG_MAX_BYTES) return;
    const rotated = `${logPath}.1`;
    tryRemove(rotated);
    renameSync2(logPath, rotated);
  } catch {
  }
}
function writeSupervisorDiag(logPath, event, fields = {}) {
  if (!logPath || !event) return;
  try {
    rotateLogIfNeeded(logPath);
    const safe = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      event: String(event),
      supervisorPid: process.pid
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
    appendFileSync(logPath, `${JSON.stringify(safe)}
`, { encoding: "utf8" });
  } catch {
  }
}
function log(...args) {
  console.error("[cursor-lifecycle-supervisor]", ...args);
}
async function loadEnsure(ensureModule) {
  const override = ensureModule || process.env.CURSOR_BRIDGE_ENSURE_MODULE;
  if (override) {
    const mod = await import(pathToFileURL(override).href);
    if (typeof mod.ensureCursorRunningLocal !== "function") {
      throw new Error(`ensure module missing ensureCursorRunningLocal: ${override}`);
    }
    return mod.ensureCursorRunningLocal;
  }
  const { ensureCursorRunningLocal: ensureCursorRunningLocal2 } = await Promise.resolve().then(() => (init_cursor_ensure_core(), cursor_ensure_core_exports));
  return ensureCursorRunningLocal2;
}
function writePid(pidPath) {
  writeFileSync2(pidPath, `${process.pid}
`, { encoding: "utf8" });
}
function acquireOrExit(lockPath, diagLog) {
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    writeFileSync2(lockPath, `${process.pid}
`, { encoding: "utf8" });
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      try {
        const existing = Number(String(readFileSync2(lockPath, "utf8")).trim());
        if (existing && existing !== process.pid) {
          try {
            process.kill(existing, 0);
            log(`another supervisor holds lock pid=${existing}; exiting`);
            writeSupervisorDiag(diagLog, "fatal", { reason: "lock-held", error: `pid=${existing}` });
            return false;
          } catch {
            tryRemove(lockPath);
            return acquireOrExit(lockPath, diagLog);
          }
        }
      } catch {
      }
      log("lock busy; exiting");
      writeSupervisorDiag(diagLog, "fatal", { reason: "lock-busy" });
      return false;
    }
    throw error;
  }
}
async function startSupervisor(options = {}) {
  const cli = parseArgs(options.argv || process.argv.slice(2));
  if (cli.bootEnv || options.bootEnv) applyBootEnv(cli.bootEnv || options.bootEnv);
  const dir = ensureLifecycleDir(options.dir || cli.dir || defaultLifecycleDir());
  const sock = options.sock || cli.sock || process.env.CURSOR_BRIDGE_SUPERVISOR_SOCK || supervisorSockPath(dir);
  const pidPath = options.pidPath || supervisorPidPath(dir);
  const lockPath = options.lockPath || supervisorLockPath(dir);
  const logPath = options.logPath || supervisorLogPath(dir);
  const idleMs = Number(
    options.idleMs ?? cli.idleMs ?? process.env.CURSOR_BRIDGE_SUPERVISOR_IDLE_MS ?? 5 * 60 * 1e3
  );
  const ensureModule = options.ensureModule || cli.ensureModule || process.env.CURSOR_BRIDGE_ENSURE_MODULE;
  const runtimeFingerprint = String(options.runtimeFingerprint || cli.runtimeFingerprint || "unknown");
  const runtimeScript = fileURLToPath(import.meta.url);
  writeSupervisorDiag(logPath, "start", { dir, sock, reason: "startSupervisor" });
  if (!acquireOrExit(lockPath, logPath)) {
    return { started: false, reason: "lock-held" };
  }
  if (process.platform !== "win32" && existsSync2(sock)) {
    tryRemove(sock);
  }
  const ensureLocal = await loadEnsure(ensureModule);
  const ensureInflight = /* @__PURE__ */ new Map();
  let ensureTail = Promise.resolve();
  let ensureCount = 0;
  let lastEnsure = null;
  const clients = /* @__PURE__ */ new Set();
  let idleTimer = null;
  let shuttingDown = false;
  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (lastEnsure && lastEnsure.ok && lastEnsure.runtimeMode === "minimal") {
      writeSupervisorDiag(logPath, "idle-suppressed", {
        reason: "minimal-runtime-owns-window-guard",
        clients: clients.size,
        ensureCount
      });
      return;
    }
    if (!(idleMs > 0)) return;
    idleTimer = setTimeout(() => {
      if (clients.size > 0 || shuttingDown) return;
      log(`idle ${idleMs}ms with 0 clients; exiting without stopping Cursor`);
      writeSupervisorDiag(logPath, "idle", { reason: `idle-${idleMs}ms`, clients: 0, ensureCount });
      shutdown(0);
    }, idleMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };
  const runEnsure = async (request = {}) => {
    const requestRuntimeMode = request.runtimeMode || "normal";
    const requestProjectPath = Object.hasOwn(request, "projectPath") ? request.projectPath : null;
    const ensureKey = JSON.stringify([requestRuntimeMode, requestProjectPath]);
    if (ensureInflight.has(ensureKey)) return ensureInflight.get(ensureKey);
    const task = ensureTail.then(async () => {
      ensureCount += 1;
      const waitMs = Number(request.waitMs || 3e4);
      const result = await ensureLocal({
        waitMs,
        runtimeMode: requestRuntimeMode,
        projectPath: requestProjectPath
      });
      lastEnsure = {
        ...result,
        ensureCount,
        at: (/* @__PURE__ */ new Date()).toISOString(),
        requestReason: request.reason || null,
        requestAdapterPid: request.adapterPid || null,
        requestRuntimeMode,
        requestProjectPath
      };
      writeSupervisorDiag(logPath, "ensure-result", {
        ok: !!result.ok,
        status: result.status,
        reason: request.reason || null,
        adapterPid: request.adapterPid || null,
        ensureCount
      });
      return lastEnsure;
    });
    ensureInflight.set(ensureKey, task);
    ensureTail = task.catch(() => {
    });
    try {
      return await task;
    } finally {
      if (ensureInflight.get(ensureKey) === task) ensureInflight.delete(ensureKey);
    }
  };
  const server = net.createServer((socket) => {
    clients.add(socket);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        Promise.resolve().then(() => handleLine(socket, line, {
          runEnsure,
          ensureCount: () => ensureCount,
          lastEnsure: () => lastEnsure,
          clients,
          isEnsureInflight: () => Boolean(ensureInflight),
          shutdown,
          runtimeFingerprint,
          runtimeScript
        })).catch((error) => {
          try {
            socket.write(`${JSON.stringify({
              type: "error",
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })}
`);
          } catch {
          }
        });
      }
    });
    socket.on("close", () => {
      clients.delete(socket);
      scheduleIdle();
    });
    socket.on("error", () => {
      clients.delete(socket);
      scheduleIdle();
    });
  });
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeSupervisorDiag(logPath, "cleanup", { reason: "shutdown", code, clients: clients.size, ensureCount });
    try {
      server.close();
    } catch {
    }
    tryRemove(pidPath);
    tryRemove(lockPath);
    if (process.platform !== "win32") tryRemove(sock);
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  await new Promise((resolve3, reject) => {
    server.once("error", reject);
    server.listen(sock, () => {
      server.removeListener("error", reject);
      resolve3();
    });
  });
  writePid(pidPath);
  log(`listening sock=${sock} pid=${process.pid} dir=${dir}`);
  writeSupervisorDiag(logPath, "listen", { sock, dir, reason: "listening" });
  scheduleIdle();
  return { started: true, sock, pid: process.pid, dir, server, shutdown, logPath };
}
async function handleLine(socket, line, ctx) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    socket.write(`${JSON.stringify({ type: "error", ok: false, error: "invalid-json" })}
`);
    return;
  }
  const id = msg.id;
  try {
    if (msg.type === "ping") {
      socket.write(`${JSON.stringify({
        type: "pong",
        id,
        ok: true,
        supervisorPid: process.pid,
        clients: ctx.clients.size,
        ensureCount: ctx.ensureCount(),
        runtimeFingerprint: ctx.runtimeFingerprint,
        runtimeScript: ctx.runtimeScript
      })}
`);
      return;
    }
    if (msg.type === "status") {
      socket.write(`${JSON.stringify({
        type: "status-result",
        id,
        ok: true,
        supervisorPid: process.pid,
        clients: ctx.clients.size,
        ensureCount: ctx.ensureCount(),
        lastEnsure: ctx.lastEnsure(),
        runtimeFingerprint: ctx.runtimeFingerprint,
        runtimeScript: ctx.runtimeScript
      })}
`);
      return;
    }
    if (msg.type === "ensure") {
      const result = await ctx.runEnsure(msg);
      socket.write(`${JSON.stringify({
        type: "ensure-result",
        id,
        supervisorPid: process.pid,
        reusedSupervisor: true,
        launchReason: result.status === "launched" ? "supervisor-spawned-cursor" : result.status === "already" ? "supervisor-cursor-already" : `supervisor-${result.status}`,
        ...result,
        runtimeFingerprint: ctx.runtimeFingerprint,
        runtimeScript: ctx.runtimeScript
      })}
`);
      return;
    }
    if (msg.type === "shutdown_if_idle") {
      if (msg.confirmation !== "ROLL_CURSOR_LIFECYCLE_SUPERVISOR") {
        socket.write(`${JSON.stringify({ type: "error", id, ok: false, error: "invalid-shutdown-confirmation" })}
`);
        return;
      }
      const busy = ctx.isEnsureInflight() || ctx.clients.size > 1;
      socket.write(`${JSON.stringify({
        type: "shutdown-result",
        id,
        ok: true,
        restarting: !busy,
        busy,
        runtimeFingerprint: ctx.runtimeFingerprint,
        targetRuntimeFingerprint: msg.targetRuntimeFingerprint || null
      })}
`);
      if (!busy) setTimeout(() => ctx.shutdown(0), 25);
      return;
    }
    socket.write(`${JSON.stringify({ type: "error", id, ok: false, error: `unknown-type:${msg.type}` })}
`);
  } catch (error) {
    socket.write(`${JSON.stringify({
      type: "error",
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })}
`);
  }
}
var isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href || process.argv.includes("--lifecycle-supervisor") || process.env.CURSOR_BRIDGE_ROLE === "supervisor";
if (isMain) {
  startSupervisor().catch((error) => {
    log("fatal", error);
    try {
      const dir = ensureLifecycleDir(process.env.CURSOR_BRIDGE_LIFECYCLE_DIR || defaultLifecycleDir());
      writeSupervisorDiag(supervisorLogPath(dir), "fatal", {
        reason: "start-failed",
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
    }
    process.exit(1);
  });
}
export {
  applyBootEnv,
  startSupervisor,
  writeSupervisorDiag
};
