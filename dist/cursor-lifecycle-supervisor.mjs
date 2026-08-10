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
  looksLikePluginRuntimePath: () => looksLikePluginRuntimePath,
  normalizeCodexThreadCwd: () => normalizeCodexThreadCwd,
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
import { basename as basename2, extname, join as join3, resolve as resolve2 } from "node:path";
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
function cursorFromRegistry() {
  const queries = [
    'reg query "HKCU\\Software\\Classes\\cursor\\shell\\open\\command" /ve',
    'reg query "HKLM\\Software\\Classes\\cursor\\shell\\open\\command" /ve',
    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor (User)" /v DisplayIcon',
    'reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor" /v DisplayIcon'
  ];
  for (const q of queries) {
    try {
      const out = execSync(q, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/([A-Za-z]:\\[^"\r\n]*?Cursor\.exe)/i);
      if (m && existsSync(m[1])) return m[1];
    } catch {
    }
  }
  return null;
}
function findCursorExe() {
  if (process.env.CURSOR_EXE && existsSync(process.env.CURSOR_EXE)) return process.env.CURSOR_EXE;
  if (IS_WIN) {
    const fromReg = cursorFromRegistry();
    if (fromReg) return fromReg;
    for (const p of WIN_FALLBACKS) {
      try {
        if (existsSync(p)) return p;
      } catch {
      }
    }
    return null;
  }
  if (IS_MAC) {
    for (const p of MAC_CANDIDATES) {
      try {
        if (existsSync(p)) return p;
      } catch {
      }
    }
    return null;
  }
  return null;
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
  const projectPath = Object.hasOwn(options, "projectPath") ? options.projectPath ? resolve2(String(options.projectPath)) : null : resolveProjectPath();
  if (await cdpUp()) {
    const isCursor = await cdpIsCursor();
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
        const exe2 = findCursorExe();
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
            message: `Cursor \u5DF2\u8FDE\u63A5\uFF0C\u4F46\u76EE\u6807\u5DE5\u4F5C\u533A ${projectPath} \u672A\u6253\u5F00\uFF0C\u4E14\u627E\u4E0D\u5230 Cursor \u53EF\u6267\u884C\u6587\u4EF6\u7528\u4E8E\u6253\u5F00\u65B0\u7A97\u53E3\u3002`
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
            message: `Cursor \u5DF2\u8FDE\u63A5\uFF0C\u4F46\u672A\u6355\u83B7\u76EE\u6807\u5DE5\u4F5C\u533A ${projectPath} \u65B0\u5EFA\u7684 CDP target\uFF1BCCE \u5DF2\u505C\u6B62\uFF0C\u907F\u514D\u5728\u9519\u8BEF\u7D22\u5F15\u4E2D\u68C0\u7D22\u3002`
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
      message: `CDP ${CDP_PORT} \u88AB\u3010\u975E Cursor\u3011\u7684 IDE \u5360\u7528\u3002\u6362\u7AEF\u53E3\u6216\u6392\u67E5\u3002`
    };
  }
  if (cursorRunning()) {
    return {
      ok: false,
      status: "running-no-debug",
      port: CDP_PORT,
      message: `Cursor \u6B63\u5728\u8FD0\u884C\u4F46\u6CA1\u5E26 --remote-debugging-port=${CDP_PORT}\uFF08\u53EF\u80FD\u7531 Codex\u3001\u8D44\u6E90\u7BA1\u7406\u5668\u6216\u5176\u4ED6\u542F\u52A8\u5668\u5148\u6253\u5F00\uFF1B\u5355\u5B9E\u4F8B\u9501\u4F1A\u5FFD\u7565\u540E\u7EED flag\uFF09\u3002\u8BF7\u5148\u5B89\u5168\u9000\u51FA\u8FD9\u4E00\u6B21 Cursor\uFF0Ccursor-bridge \u4F1A\u5728\u4E0B\u6B21\u542F\u52A8\u65F6\u9884\u70ED\u5E26 CDP \u7684\u5B9E\u4F8B\u5E76\u6301\u7EED\u9690\u85CF\u7A97\u53E3\u3002\u6CE8\u610F\uFF1A\u4E0D\u4E3B\u52A8 kill \u4EE5\u514D\u4E22\u672A\u4FDD\u5B58\u5185\u5BB9\u3002`
    };
  }
  const exe = findCursorExe();
  if (!exe) {
    return {
      ok: false,
      status: "no-exe",
      port: CDP_PORT,
      message: "\u627E\u4E0D\u5230 Cursor \u53EF\u6267\u884C\u6587\u4EF6\uFF08Windows\uFF1A\u6CE8\u518C\u8868/\u9ED8\u8BA4\u4F4D\u7F6E\uFF1BmacOS\uFF1A/Applications/Cursor.app \u90FD\u6CA1\u547D\u4E2D\uFF09\u3002\u8BBE\u73AF\u5883\u53D8\u91CF CURSOR_EXE \u6307\u5B9A\u5B8C\u6574\u8DEF\u5F84\u3002"
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
      message: `\u5DF2\u542F\u52A8 Cursor\uFF08${exe}\uFF09\uFF0C\u4F46 ${waitMs}ms \u5185 CDP ${CDP_PORT} \u672A\u5C31\u7EEA\uFF0C\u7A0D\u540E\u91CD\u8BD5\u3002`
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
      message: `Cursor \u5DF2\u542F\u52A8\uFF0C\u4F46\u672A\u6355\u83B7\u76EE\u6807\u5DE5\u4F5C\u533A ${projectPath} \u7684 CDP target\uFF1BCCE \u5DF2\u505C\u6B62\uFF0C\u907F\u514D\u5728\u9519\u8BEF\u7D22\u5F15\u4E2D\u68C0\u7D22\u3002`
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
var CDP_PORT, CDP_ORIGIN, CDP_HOST, PROJECT_TARGETS, CODEX_THREAD_PROJECTS, loadModule, IS_WIN, IS_MAC, WIN_FALLBACKS, MAC_CANDIDATES;
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
    WIN_FALLBACKS = [
      `${process.env.LOCALAPPDATA || ""}\\Programs\\cursor\\Cursor.exe`,
      "C:\\Program Files\\cursor\\Cursor.exe"
    ];
    MAC_CANDIDATES = [
      "/Applications/Cursor.app/Contents/MacOS/Cursor",
      `${process.env.HOME || ""}/Applications/Cursor.app/Contents/MacOS/Cursor`
    ];
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
