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
  resolveProjectPath: () => resolveProjectPath,
  waitForCdp: () => waitForCdp
});
import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import http from "http";
function looksLikePluginRuntimePath(candidate) {
  const p = String(candidate || "").replace(/\//g, "\\").toLowerCase();
  return p.includes("\\.codex\\.tmp\\marketplaces\\") || p.includes("\\.codex\\plugins\\cache\\") || p.includes("\\.claude\\plugins\\cache\\") || p.includes("\\appdata\\local\\npm-cache\\_npx\\");
}
function resolveProjectPath() {
  const explicit = process.env.CURSOR_PROJECT_PATH;
  if (explicit) return explicit;
  const cwd = process.cwd();
  if (!cwd || looksLikePluginRuntimePath(cwd)) return null;
  return cwd;
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
  return new Promise((resolve) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: "/json/version" }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy();
      } catch {
      }
      resolve(false);
    });
  });
}
function cdpIsCursor(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: "/json/list" }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          if (/[\/\\](windsurf)[\/\\]/i.test(d)) return resolve(false);
          resolve(/[\/\\]cursor[\/\\](resources|app)|cursor\.exe|vscode-app[^"]*[\/\\]cursor[\/\\]/i.test(d));
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy();
      } catch {
      }
      resolve(false);
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
async function ensureCursorRunningLocal({ waitMs = 3e4 } = {}) {
  if (await cdpUp()) {
    const isCursor = await cdpIsCursor();
    if (isCursor) {
      return { ok: true, status: "already", port: CDP_PORT, message: `CDP ${CDP_PORT} \u5DF2\u54CD\u5E94\u4E14\u662F Cursor\u3002` };
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
      message: `Cursor \u6B63\u5728\u8FD0\u884C\u4F46\u6CA1\u5E26 --remote-debugging-port=${CDP_PORT}\uFF08\u5355\u5B9E\u4F8B\u9501\u4F1A\u5FFD\u7565 flag\uFF09\u3002\u8BF7\u5148\u5F7B\u5E95\u9000\u51FA Cursor\uFF08Windows\uFF1A\u5168\u90E8\u7A97\u53E3+\u6258\u76D8\uFF1BmacOS\uFF1ACmd+Q\uFF09\uFF0Ccursor-bridge \u4F1A\u5728\u4E0B\u6B21\u8C03\u7528\u65F6\u81EA\u52A8\u5E26 flag \u62C9\u8D77\uFF1B\u6216\u624B\u52A8\u5E26 flag \u91CD\u542F\u3002\u6CE8\u610F\uFF1A\u4E0D\u4E3B\u52A8 kill \u4EE5\u514D\u4E22\u672A\u4FDD\u5B58\u5185\u5BB9\u3002`
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
  const projectPath = resolveProjectPath();
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--remote-allow-origins=${CDP_ORIGIN}`];
  if (projectPath && existsSync(projectPath)) args.push(projectPath);
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  const up = await waitForCdp(waitMs);
  if (!up) {
    return {
      ok: false,
      status: "timeout",
      exe,
      port: CDP_PORT,
      message: `\u5DF2\u542F\u52A8 Cursor\uFF08${exe}\uFF09\uFF0C\u4F46 ${waitMs}ms \u5185 CDP ${CDP_PORT} \u672A\u5C31\u7EEA\uFF0C\u7A0D\u540E\u91CD\u8BD5\u3002`
    };
  }
  const target = projectPath ? `\u6253\u5F00 ${projectPath}` : "\u6062\u590D\u4E0A\u6B21\u5DE5\u4F5C\u533A";
  return {
    ok: true,
    status: "launched",
    exe,
    port: CDP_PORT,
    message: `\u5DF2\u542F\u52A8 Cursor\uFF08${exe}\uFF0C${target}\uFF09\uFF0CCDP ${CDP_PORT} \u5C31\u7EEA\u3002`
  };
}
var CDP_PORT, CDP_ORIGIN, CDP_HOST, IS_WIN, IS_MAC, WIN_FALLBACKS, MAC_CANDIDATES;
var init_cursor_ensure_core = __esm({
  "cursor-ensure-core.mjs"() {
    CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
    CDP_ORIGIN = `http://localhost:${CDP_PORT}`;
    CDP_HOST = "127.0.0.1";
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
  writeFileSync,
  unlinkSync,
  existsSync as existsSync2,
  openSync,
  closeSync,
  readFileSync,
  appendFileSync,
  renameSync,
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
    const parsed = JSON.parse(readFileSync(bootEnvPath, "utf8"));
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
    renameSync(logPath, rotated);
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
  writeFileSync(pidPath, `${process.pid}
`, { encoding: "utf8" });
}
function acquireOrExit(lockPath, diagLog) {
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    writeFileSync(lockPath, `${process.pid}
`, { encoding: "utf8" });
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      try {
        const existing = Number(String(readFileSync(lockPath, "utf8")).trim());
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
      const result = await ensureLocal({ waitMs });
      lastEnsure = {
        ...result,
        ensureCount,
        at: (/* @__PURE__ */ new Date()).toISOString(),
        requestReason: request.reason || null,
        requestAdapterPid: request.adapterPid || null
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => {
      server.removeListener("error", reject);
      resolve();
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
