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
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] private static extern bool RedrawWindow(IntPtr hWnd, IntPtr updateRect, IntPtr updateRegion, uint flags);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);

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
        bool restored = ShowWindowAsync(hWnd, 9);
        bool redrawn = RedrawWindow(hWnd, IntPtr.Zero, IntPtr.Zero, 0x00000585);
        SetForegroundWindow(hWnd);
        if (restored || redrawn) changed++;
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
  looksLikePluginRuntimePath: () => looksLikePluginRuntimePath,
  normalizeCodexThreadCwd: () => normalizeCodexThreadCwd,
  normalizeCursorExeCandidate: () => normalizeCursorExeCandidate,
  resolveCodexThreadProjectPath: () => resolveCodexThreadProjectPath,
  resolveProjectPath: () => resolveProjectPath,
  selectNewCdpTarget: () => selectNewCdpTarget,
  targetTitleMatchesProject: () => targetTitleMatchesProject,
  waitForCdp: () => waitForCdp
});
import { spawn as spawn2, execSync } from "child_process";
import { existsSync } from "fs";
import { createRequire as createNodeRequire } from "node:module";
import { homedir as homedir3 } from "node:os";
import { basename as basename2, extname, join as join3, resolve as resolve2, win32 as winPath, posix as posixPath } from "node:path";
import http from "http";
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
  const execSyncImpl = options.execSyncImpl || execSync;
  const existsImpl = options.existsImpl || existsSync;
  const queries = [
    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe" /ve',
    'reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe" /ve',
    'reg query "HKCU\\Software\\Classes\\cursor\\shell\\open\\command" /ve',
    'reg query "HKLM\\Software\\Classes\\cursor\\shell\\open\\command" /ve',
    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor (User)" /v DisplayIcon',
    'reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor" /v DisplayIcon'
  ];
  for (const q of queries) {
    try {
      const out = execSyncImpl(q, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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
    const fromReg = cursorFromRegistry({ execSyncImpl: options.execSyncImpl, existsImpl });
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
function cursorRunning() {
  try {
    if (IS_WIN) {
      return /Cursor\.exe/i.test(execSync('tasklist /fi "imagename eq Cursor.exe" /nh', {
        encoding: "utf8",
        windowsHide: true
      }));
    }
    if (IS_MAC) {
      execSync("pgrep -f 'Cursor.app/Contents/MacOS/Cursor'", { stdio: "ignore" });
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
async function ensureCursorRunningLocal(options = {}) {
  const waitMs = Number(options.waitMs || 3e4);
  const runtimeMode = options.runtimeMode || "normal";
  const effectiveRuntimeMode = normalizeCursorRuntimeMode(runtimeMode);
  const cdpUpImpl = options.cdpUpImpl || cdpUp;
  const cdpIsCursorImpl = options.cdpIsCursorImpl || cdpIsCursor;
  const cursorRunningImpl = options.cursorRunningImpl || cursorRunning;
  const findCursorExeDetailsImpl = options.findCursorExeDetailsImpl || findCursorExeDetails;
  const projectPath = Object.hasOwn(options, "projectPath") ? options.projectPath ? resolve2(String(options.projectPath)) : null : resolveProjectPath();
  if (await cdpUpImpl()) {
    const isCursor = await cdpIsCursorImpl();
    if (isCursor) {
      const cursorPid2 = findCursorPidByPort(CDP_PORT);
      const windowGuard2 = effectiveRuntimeMode === "minimal" && cursorPid2 ? startMinimalWindowGuard(cursorPid2) : null;
      const presentation2 = effectiveRuntimeMode === "minimal" ? setCursorWindowPresentation({ action: "hide", port: CDP_PORT, pid: cursorPid2 }) : null;
      const currentTargets = await listCdpPageTargets();
      const projectKey = normalizeProjectKey(projectPath);
      let targetId2 = projectKey ? PROJECT_TARGETS.get(projectKey) || null : currentTargets[0] && currentTargets[0].id || null;
      let workspaceAction = projectPath ? "reused-project-target" : "reused-last-workspace";
      const cachedTarget = targetId2 ? currentTargets.find((target2) => target2.id === targetId2) : null;
      if (targetId2 && (!cachedTarget || projectPath && !targetTitleMatchesProject(cachedTarget.title, projectPath))) {
        PROJECT_TARGETS.delete(projectKey);
        targetId2 = null;
      }
      if (projectPath && !targetId2) {
        const existingTarget = currentTargets.find((target2) => targetTitleMatchesProject(target2.title, projectPath));
        if (existingTarget) {
          targetId2 = existingTarget.id;
          PROJECT_TARGETS.set(projectKey, targetId2);
          workspaceAction = "recovered-project-target";
        }
      }
      if (projectPath && existsSync(projectPath) && !targetId2) {
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
            nextStep: "\u8BF7\u786E\u8BA4 Cursor \u5DF2\u5B89\u88C5\u5E76\u767B\u5F55\u3002\u82E5\u4F7F\u7528\u4FBF\u643A\u7248\u6216\u81EA\u5B9A\u4E49\u76EE\u5F55\uFF0C\u8BF7\u8BBE\u7F6E CURSOR_EXE \u540E\u91CD\u65B0\u6267\u884C\u540C\u4E00\u53E5\u521D\u59CB\u5316\u547D\u4EE4\u3002",
            message: `CCE \u5DF2\u8FDE\u63A5 Cursor\uFF0C\u4F46\u8FD8\u4E0D\u80FD\u6253\u5F00\u5DE5\u4F5C\u533A ${projectPath}\uFF0C\u56E0\u4E3A\u6CA1\u6709\u627E\u5230 Cursor \u7A0B\u5E8F\u3002`
          };
        }
        const beforeTargetIds = new Set(currentTargets.map((target2) => target2.id));
        const opener = spawn2(exe2, ["--new-window", projectPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: effectiveRuntimeMode === "minimal"
        });
        opener.unref();
        workspaceAction = "opened-new-window";
        const openedTarget2 = await waitForNewCdpTarget(beforeTargetIds, 12e3, projectPath);
        if (!openedTarget2) {
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
            nextStep: "\u8BF7\u7B49\u5F85 Cursor \u5B8C\u6210\u6253\u5F00\u9879\u76EE\uFF0C\u7136\u540E\u91CD\u65B0\u6267\u884C\u540C\u4E00\u53E5\u521D\u59CB\u5316\u547D\u4EE4\u3002",
            message: `Cursor \u5DF2\u6253\u5F00\u9879\u76EE\uFF0C\u4F46 CCE \u8FD8\u6CA1\u6709\u786E\u8BA4\u5DE5\u4F5C\u533A ${projectPath} \u5DF2\u51C6\u5907\u597D\uFF1B\u4E3A\u907F\u514D\u641C\u7D22\u9519\u9879\u76EE\uFF0C\u672C\u6B21\u521D\u59CB\u5316\u5DF2\u5B89\u5168\u505C\u6B62\u3002`
          };
        }
        targetId2 = openedTarget2.id;
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
        message: `CDP ${CDP_PORT} \u5DF2\u54CD\u5E94\u4E14\u662F Cursor\uFF1B\u76EE\u6807\u5DE5\u4F5C\u533A\u5DF2\u7ED1\u5B9A\u5230 CDP target ${targetId2 || "default"}\u3002`
      };
    }
    return {
      ok: false,
      status: "port-not-cursor",
      port: CDP_PORT,
      needsAction: "free_cce_port",
      retryable: true,
      nextStep: `\u672C\u673A\u7AEF\u53E3 ${CDP_PORT} \u6B63\u88AB\u5176\u4ED6\u7A0B\u5E8F\u4F7F\u7528\u3002\u5173\u95ED\u5360\u7528\u5B83\u7684\u7A0B\u5E8F\u540E\uFF0C\u91CD\u65B0\u6267\u884C\u540C\u4E00\u53E5\u521D\u59CB\u5316\u547D\u4EE4\u3002`,
      message: `CCE \u73B0\u5728\u65E0\u6CD5\u8FDE\u63A5 Cursor\uFF0C\u56E0\u4E3A\u6240\u9700\u7684\u672C\u673A\u7AEF\u53E3 ${CDP_PORT} \u6B63\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528\u3002`
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
      nextStep: projectPath ? `\u4FDD\u5B58\u624B\u5934\u5185\u5BB9\u5E76\u6B63\u5E38\u9000\u51FA Cursor \u4E00\u6B21\uFF0C\u7136\u540E\u518D\u6B21\u8BF4\u201C\u521D\u59CB\u5316 CCE \u5DE5\u4F5C\u533A\u4E3A ${projectPath}\u201D\u3002` : "\u4FDD\u5B58\u624B\u5934\u5185\u5BB9\u5E76\u6B63\u5E38\u9000\u51FA Cursor \u4E00\u6B21\uFF0C\u7136\u540E\u91CD\u8BD5\u521A\u624D\u7684 CCE \u64CD\u4F5C\u3002",
      message: "Cursor \u5DF2\u7ECF\u63D0\u524D\u6253\u5F00\uFF0CCCE \u65E0\u6CD5\u5728\u8FD0\u884C\u4E2D\u4E3A\u5B83\u8865\u4E0A\u8FDE\u63A5\u80FD\u529B\u3002\u4E3A\u4FDD\u62A4\u672A\u4FDD\u5B58\u5185\u5BB9\uFF0CCursor Bridge \u4E0D\u4F1A\u5F3A\u5236\u5173\u95ED\u5B83\u3002"
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
      nextStep: "\u8BF7\u5148\u5B89\u88C5\u5E76\u767B\u5F55 Cursor\u3002\u82E5\u4F7F\u7528\u4FBF\u643A\u7248\u6216\u81EA\u5B9A\u4E49\u76EE\u5F55\uFF0C\u8BF7\u8BBE\u7F6E CURSOR_EXE \u540E\u91CD\u65B0\u6267\u884C\u540C\u4E00\u53E5\u521D\u59CB\u5316\u547D\u4EE4\u3002",
      message: "\u6CA1\u6709\u627E\u5230 Cursor\u3002\u6807\u51C6 Windows \u4E0E macOS \u5B89\u88C5\u4F1A\u81EA\u52A8\u8BC6\u522B\uFF0C\u901A\u5E38\u4E0D\u9700\u8981\u586B\u5199\u7A0B\u5E8F\u8DEF\u5F84\u3002"
    };
  }
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--remote-allow-origins=${CDP_ORIGIN}`];
  if (effectiveRuntimeMode === "minimal") {
    args.push(
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows"
    );
  }
  if (projectPath && existsSync(projectPath)) args.push(projectPath);
  const child = spawn2(exe, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: effectiveRuntimeMode === "minimal"
  });
  child.unref();
  const startupWindowGuard = effectiveRuntimeMode === "minimal" ? startMinimalWindowGuard(child.pid) : null;
  const up = await waitForCdp(waitMs);
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
      nextStep: "\u8BF7\u7A0D\u7B49\u7247\u523B\uFF0C\u7136\u540E\u91CD\u65B0\u6267\u884C\u540C\u4E00\u53E5\u521D\u59CB\u5316\u547D\u4EE4\u3002",
      message: "Cursor \u5DF2\u7ECF\u542F\u52A8\uFF0C\u4F46 CCE \u8FD8\u6CA1\u51C6\u5907\u597D\uFF1B\u65E0\u9700\u4FEE\u6539\u4EFB\u4F55\u7AEF\u53E3\u8BBE\u7F6E\u3002"
    };
  }
  const cursorPid = findCursorPidByPort(CDP_PORT) || child.pid || null;
  const openedTarget = await waitForNewCdpTarget(/* @__PURE__ */ new Set(), 12e3, projectPath);
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
      nextStep: "\u8BF7\u7B49\u5F85 Cursor \u5B8C\u6210\u6253\u5F00\u9879\u76EE\uFF0C\u7136\u540E\u91CD\u65B0\u6267\u884C\u540C\u4E00\u53E5\u521D\u59CB\u5316\u547D\u4EE4\u3002",
      message: `Cursor \u5DF2\u542F\u52A8\uFF0C\u4F46 CCE \u8FD8\u6CA1\u6709\u786E\u8BA4\u5DE5\u4F5C\u533A ${projectPath} \u5DF2\u51C6\u5907\u597D\uFF1B\u4E3A\u907F\u514D\u641C\u7D22\u9519\u9879\u76EE\uFF0C\u672C\u6B21\u521D\u59CB\u5316\u5DF2\u5B89\u5168\u505C\u6B62\u3002`
    };
  }
  if (projectPath && targetId) PROJECT_TARGETS.set(normalizeProjectKey(projectPath), targetId);
  const windowGuard = effectiveRuntimeMode === "minimal" && cursorPid ? startMinimalWindowGuard(cursorPid) : null;
  const target = projectPath ? `\u6253\u5F00 ${projectPath}` : "\u6062\u590D\u4E0A\u6B21\u5DE5\u4F5C\u533A";
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
    workspaceAction: projectPath ? "launched-project" : "launched-last-workspace",
    message: `\u5DF2\u542F\u52A8 Cursor\uFF08${exe}\uFF0C${target}\uFF09\uFF0CCDP ${CDP_PORT} \u5C31\u7EEA\u3002`
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
  return fresh.find((target) => targetTitleMatchesProject(target.title, projectPath)) || fresh[0] || null;
}
async function waitForNewCdpTarget(beforeTargetIds, maxMs = 12e3, projectPath = "") {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const target = selectNewCdpTarget(beforeTargetIds, await listCdpPageTargets(), projectPath);
    if (target) return target;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  return null;
}
var CDP_PORT, CDP_ORIGIN, CDP_HOST, PROJECT_TARGETS, CODEX_THREAD_PROJECTS, loadModule, IS_WIN, IS_MAC;
var init_cursor_ensure_core = __esm({
  "cursor-ensure-core.mjs"() {
    init_cursor_runtime();
    CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
    CDP_ORIGIN = `http://localhost:${CDP_PORT}`;
    CDP_HOST = "127.0.0.1";
    PROJECT_TARGETS = /* @__PURE__ */ new Map();
    CODEX_THREAD_PROJECTS = /* @__PURE__ */ new Map();
    loadModule = createNodeRequire(import.meta.url);
    IS_WIN = process.platform === "win32";
    IS_MAC = process.platform === "darwin";
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
import { pathToFileURL } from "node:url";

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
  writeSupervisorDiag(logPath, "start", { dir, sock, reason: "startSupervisor" });
  if (!acquireOrExit(lockPath, logPath)) {
    return { started: false, reason: "lock-held" };
  }
  if (process.platform !== "win32" && existsSync2(sock)) {
    tryRemove(sock);
  }
  const ensureLocal = await loadEnsure(ensureModule);
  let ensureInflight = null;
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
    if (ensureInflight) return ensureInflight;
    ensureInflight = (async () => {
      ensureCount += 1;
      const waitMs = Number(request.waitMs || 3e4);
      const result = await ensureLocal({
        waitMs,
        runtimeMode: request.runtimeMode || "normal",
        projectPath: Object.hasOwn(request, "projectPath") ? request.projectPath : null
      });
      lastEnsure = {
        ...result,
        ensureCount,
        at: (/* @__PURE__ */ new Date()).toISOString(),
        requestReason: request.reason || null,
        requestAdapterPid: request.adapterPid || null,
        requestRuntimeMode: request.runtimeMode || "normal",
        requestProjectPath: request.projectPath || null
      };
      writeSupervisorDiag(logPath, "ensure-result", {
        ok: !!result.ok,
        status: result.status,
        reason: request.reason || null,
        adapterPid: request.adapterPid || null,
        ensureCount
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
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        Promise.resolve().then(() => handleLine(socket, line, { runEnsure, ensureCount: () => ensureCount, lastEnsure: () => lastEnsure, clients })).catch((error) => {
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
        ensureCount: ctx.ensureCount()
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
        lastEnsure: ctx.lastEnsure()
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
        ...result
      })}
`);
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
