#!/usr/bin/env node
/**
 * cursor-ensure-core.mjs — Cursor CDP ensure logic (no IPC / no supervisor).
 * Owned by the lifecycle supervisor on multi-adapter hosts; adapters should not
 * call this directly except via CURSOR_BRIDGE_INLINE_ENSURE=1 or tests.
 */
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire as createNodeRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import http from 'http';
import {
  findCursorPidByPort,
  normalizeCursorRuntimeMode,
  setCursorWindowPresentation,
  startMinimalWindowGuard,
} from './cursor-runtime.mjs';

export const CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
export const CDP_ORIGIN = `http://localhost:${CDP_PORT}`;
// Probe with literal IPv4 — Windows often resolves localhost to ::1 while Chromium listens on 127.0.0.1.
export const CDP_HOST = '127.0.0.1';
const PROJECT_TARGETS = new Map();
const CODEX_THREAD_PROJECTS = new Map();
const loadModule = createNodeRequire(import.meta.url);

export function looksLikePluginRuntimePath(candidate) {
  const p = String(candidate || '').replace(/\//g, '\\').toLowerCase();
  return p.includes('\\.codex\\.tmp\\marketplaces\\') ||
    p.includes('\\.codex\\plugins\\cache\\') ||
    p.includes('\\.claude\\plugins\\cache\\') ||
    p.includes('\\appdata\\local\\npm-cache\\_npx\\');
}

export function normalizeCodexThreadCwd(value) {
  const raw = String(value || '').trim();
  if (/^\\\\\?\\UNC\\/i.test(raw)) return `\\\\${raw.slice(8)}`;
  if (/^\\\\\?\\[a-zA-Z]:\\/.test(raw)) return raw.slice(4);
  return raw;
}

export function resolveCodexThreadProjectPath(options = {}) {
  const threadId = String(options.threadId ?? process.env.CODEX_THREAD_ID ?? '').trim();
  if (!threadId) return null;
  if (CODEX_THREAD_PROJECTS.has(threadId) && options.useCache !== false) {
    return CODEX_THREAD_PROJECTS.get(threadId);
  }
  let database = null;
  try {
    const lookupThreadCwd = options.lookupThreadCwd || ((id) => {
      const { DatabaseSync } = (options.requireImpl || loadModule)('node:sqlite');
      const databasePath = options.databasePath || join(homedir(), '.codex', 'state_5.sqlite');
      database = new DatabaseSync(databasePath, { readOnly: true });
      return database.prepare('SELECT cwd FROM threads WHERE id = ?').get(id)?.cwd || null;
    });
    const candidate = normalizeCodexThreadCwd(lookupThreadCwd(threadId));
    const existsImpl = options.existsImpl || existsSync;
    const resolved = candidate && !looksLikePluginRuntimePath(candidate) && existsImpl(candidate)
      ? resolve(candidate)
      : null;
    if (options.useCache !== false) CODEX_THREAD_PROJECTS.set(threadId, resolved);
    return resolved;
  } catch {
    if (options.useCache !== false) CODEX_THREAD_PROJECTS.set(threadId, null);
    return null;
  } finally {
    try { database?.close(); } catch {}
  }
}

export function resolveProjectPath(value = process.env.CURSOR_PROJECT_PATH, options = {}) {
  const explicit = String(value || '').trim();
  if (explicit) return resolve(explicit);
  const threadProjectPath = options.threadProjectPath === undefined
    ? resolveCodexThreadProjectPath(options)
    : options.threadProjectPath;
  if (threadProjectPath) return resolve(normalizeCodexThreadCwd(threadProjectPath));
  const cwd = options.cwd ?? process.cwd();
  if (!cwd || looksLikePluginRuntimePath(cwd)) return null;
  return resolve(cwd);
}

function cursorFromRegistry() {
  const queries = [
    'reg query "HKCU\\Software\\Classes\\cursor\\shell\\open\\command" /ve',
    'reg query "HKLM\\Software\\Classes\\cursor\\shell\\open\\command" /ve',
    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor (User)" /v DisplayIcon',
    'reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor" /v DisplayIcon',
  ];
  for (const q of queries) {
    try {
      const out = execSync(q, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/([A-Za-z]:\\[^"\r\n]*?Cursor\.exe)/i);
      if (m && existsSync(m[1])) return m[1];
    } catch {}
  }
  return null;
}

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const WIN_FALLBACKS = [
  `${process.env.LOCALAPPDATA || ''}\\Programs\\cursor\\Cursor.exe`,
  'C:\\Program Files\\cursor\\Cursor.exe',
];
const MAC_CANDIDATES = [
  '/Applications/Cursor.app/Contents/MacOS/Cursor',
  `${process.env.HOME || ''}/Applications/Cursor.app/Contents/MacOS/Cursor`,
];

export function findCursorExe() {
  if (process.env.CURSOR_EXE && existsSync(process.env.CURSOR_EXE)) return process.env.CURSOR_EXE;
  if (IS_WIN) {
    const fromReg = cursorFromRegistry();
    if (fromReg) return fromReg;
    for (const p of WIN_FALLBACKS) { try { if (existsSync(p)) return p; } catch {} }
    return null;
  }
  if (IS_MAC) {
    for (const p of MAC_CANDIDATES) { try { if (existsSync(p)) return p; } catch {} }
    return null;
  }
  return null;
}

export function cdpUp(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: '/json/version' }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve(false); });
  });
}

export function cdpIsCursor(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: '/json/list' }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          if (/[\/\\](windsurf)[\/\\]/i.test(d)) return resolve(false);
          resolve(/[\/\\]cursor[\/\\](resources|app)|cursor\.exe|vscode-app[^"]*[\/\\]cursor[\/\\]/i.test(d));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve(false); });
  });
}

export function cursorRunning() {
  try {
    if (IS_WIN) {
      return /Cursor\.exe/i.test(execSync('tasklist /fi "imagename eq Cursor.exe" /nh', {
        encoding: 'utf8',
        windowsHide: true,
      }));
    }
    if (IS_MAC) {
      execSync("pgrep -f 'Cursor.app/Contents/MacOS/Cursor'", { stdio: 'ignore' });
      return true;
    }
    return false;
  } catch { return false; }
}

export async function waitForCdp(maxMs = 30000, stepMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await cdpUp()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/**
 * Ensure Cursor is listening with CDP. Idempotent. Never kills a running Cursor.
 * status: 'already' | 'launched' | 'running-no-debug' | 'port-not-cursor' | 'no-exe' | 'timeout'
 */
export async function ensureCursorRunningLocal(options = {}) {
  const waitMs = Number(options.waitMs || 30000);
  const runtimeMode = options.runtimeMode || 'normal';
  const effectiveRuntimeMode = normalizeCursorRuntimeMode(runtimeMode);
  const projectPath = Object.hasOwn(options, 'projectPath')
    ? (options.projectPath ? resolve(String(options.projectPath)) : null)
    : resolveProjectPath();
  if (await cdpUp()) {
    const isCursor = await cdpIsCursor();
    if (isCursor) {
      const cursorPid = findCursorPidByPort(CDP_PORT);
      const windowGuard = effectiveRuntimeMode === 'minimal' && cursorPid
        ? startMinimalWindowGuard(cursorPid)
        : null;
      const presentation = effectiveRuntimeMode === 'minimal'
        ? setCursorWindowPresentation({ action: 'hide', port: CDP_PORT, pid: cursorPid })
        : null;
      const currentTargets = await listCdpPageTargets();
      const projectKey = normalizeProjectKey(projectPath);
      let targetId = projectKey ? PROJECT_TARGETS.get(projectKey) || null : (currentTargets[0] && currentTargets[0].id || null);
      let workspaceAction = projectPath ? 'reused-project-target' : 'reused-last-workspace';
      if (targetId && !currentTargets.some((target) => target.id === targetId)) {
        PROJECT_TARGETS.delete(projectKey);
        targetId = null;
      }
      if (projectPath && !targetId) {
        const existingTarget = currentTargets.find((target) => targetTitleMatchesProject(target.title, projectPath));
        if (existingTarget) {
          targetId = existingTarget.id;
          PROJECT_TARGETS.set(projectKey, targetId);
          workspaceAction = 'recovered-project-target';
        }
      }
      if (projectPath && existsSync(projectPath) && !targetId) {
        const exe = findCursorExe();
        if (!exe) {
          return {
            ok: false,
            status: 'workspace-not-ready',
            port: CDP_PORT,
            cursorPid,
            runtimeMode: effectiveRuntimeMode,
            projectPath,
            presentation,
            windowGuard,
            message: `Cursor 已连接，但目标工作区 ${projectPath} 未打开，且找不到 Cursor 可执行文件用于打开新窗口。`,
          };
        }
        const beforeTargetIds = new Set(currentTargets.map((target) => target.id));
        const opener = spawn(exe, ['--new-window', projectPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: effectiveRuntimeMode === 'minimal',
        });
        opener.unref();
        workspaceAction = 'opened-new-window';
        const openedTarget = await waitForNewCdpTarget(beforeTargetIds, 12000, projectPath);
        if (!openedTarget) {
          return {
            ok: false,
            status: 'workspace-not-ready',
            port: CDP_PORT,
            cursorPid,
            runtimeMode: effectiveRuntimeMode,
            projectPath,
            presentation,
            windowGuard,
            workspaceAction,
            message: `Cursor 已连接，但未捕获目标工作区 ${projectPath} 新建的 CDP target；CCE 已停止，避免在错误索引中检索。`,
          };
        }
        targetId = openedTarget.id;
        PROJECT_TARGETS.set(projectKey, targetId);
      }
      return {
        ok: true,
        status: 'already',
        port: CDP_PORT,
        cursorPid,
        runtimeMode: effectiveRuntimeMode,
        projectPath,
        presentation,
        windowGuard,
        targetId,
        workspaceAction,
        message: `CDP ${CDP_PORT} 已响应且是 Cursor；目标工作区已绑定到 CDP target ${targetId || 'default'}。`,
      };
    }
    return {
      ok: false,
      status: 'port-not-cursor',
      port: CDP_PORT,
      message: `CDP ${CDP_PORT} 被【非 Cursor】的 IDE 占用。换端口或排查。`,
    };
  }
  if (cursorRunning()) {
    return {
      ok: false,
      status: 'running-no-debug',
      port: CDP_PORT,
      message: `Cursor 正在运行但没带 --remote-debugging-port=${CDP_PORT}（可能由 Codex、资源管理器或其他启动器先打开；单实例锁会忽略后续 flag）。请先安全退出这一次 Cursor，cursor-bridge 会在下次启动时预热带 CDP 的实例并持续隐藏窗口。注意：不主动 kill 以免丢未保存内容。`,
    };
  }
  const exe = findCursorExe();
  if (!exe) {
    return {
      ok: false,
      status: 'no-exe',
      port: CDP_PORT,
      message: '找不到 Cursor 可执行文件（Windows：注册表/默认位置；macOS：/Applications/Cursor.app 都没命中）。设环境变量 CURSOR_EXE 指定完整路径。',
    };
  }

  const args = [`--remote-debugging-port=${CDP_PORT}`, `--remote-allow-origins=${CDP_ORIGIN}`];
  if (effectiveRuntimeMode === 'minimal') {
    args.push(
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    );
  }
  if (projectPath && existsSync(projectPath)) args.push(projectPath);
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: effectiveRuntimeMode === 'minimal',
  });
  child.unref();
  const startupWindowGuard = effectiveRuntimeMode === 'minimal'
    ? startMinimalWindowGuard(child.pid)
    : null;

  const up = await waitForCdp(waitMs);
  if (!up) {
    return {
      ok: false,
      status: 'timeout',
      exe,
      port: CDP_PORT,
      cursorPid: child.pid || null,
      runtimeMode: effectiveRuntimeMode,
      projectPath,
      windowGuard: startupWindowGuard,
      message: `已启动 Cursor（${exe}），但 ${waitMs}ms 内 CDP ${CDP_PORT} 未就绪，稍后重试。`,
    };
  }
  const cursorPid = findCursorPidByPort(CDP_PORT) || child.pid || null;
  const openedTarget = await waitForNewCdpTarget(new Set(), 12000, projectPath);
  const targetId = openedTarget && openedTarget.id || null;
  if (projectPath && !targetId) {
    return {
      ok: false,
      status: 'workspace-not-ready',
      exe,
      port: CDP_PORT,
      cursorPid,
      runtimeMode: effectiveRuntimeMode,
      projectPath,
      windowGuard: startupWindowGuard,
      message: `Cursor 已启动，但未捕获目标工作区 ${projectPath} 的 CDP target；CCE 已停止，避免在错误索引中检索。`,
    };
  }
  if (projectPath && targetId) PROJECT_TARGETS.set(normalizeProjectKey(projectPath), targetId);
  const windowGuard = effectiveRuntimeMode === 'minimal' && cursorPid
    ? startMinimalWindowGuard(cursorPid)
    : null;
  const target = projectPath ? `打开 ${projectPath}` : '恢复上次工作区';
  const presentation = effectiveRuntimeMode === 'minimal'
    ? setCursorWindowPresentation({ action: 'hide', port: CDP_PORT, pid: cursorPid })
    : null;
  return {
    ok: true,
    status: 'launched',
    exe,
    port: CDP_PORT,
    cursorPid,
    runtimeMode: effectiveRuntimeMode,
    projectPath,
    presentation,
    windowGuard,
    startupWindowGuard,
    targetId,
    workspaceAction: projectPath ? 'launched-project' : 'launched-last-workspace',
    message: `已启动 Cursor（${exe}，${target}），CDP ${CDP_PORT} 就绪。`,
  };
}

function normalizeProjectKey(projectPath) {
  return projectPath ? resolve(String(projectPath)).replace(/\\/g, '/').toLowerCase() : '';
}

export function targetTitleMatchesProject(title, projectPath) {
  const name = basename(String(projectPath || '')).trim().toLowerCase();
  if (!name) return false;
  const extension = extname(name);
  const candidates = [...new Set([name, extension ? name.slice(0, -extension.length) : name].filter(Boolean))];
  const normalizedTitle = String(title || '').trim().toLowerCase();
  return candidates.some((candidate) =>
    normalizedTitle === candidate
    || normalizedTitle.startsWith(candidate + ' - ')
    || normalizedTitle.includes(' - ' + candidate + ' - '));
}

async function listCdpPageTargets(timeoutMs = 1500) {
  return new Promise((done) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: '/json/list' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          done(Array.isArray(targets) ? targets.filter((target) => target && target.type === 'page' && target.id) : []);
        } catch { done([]); }
      });
    });
    req.on('error', () => done([]));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} done([]); });
  });
}

export function selectNewCdpTarget(beforeTargetIds, targets, projectPath = '') {
  const before = beforeTargetIds instanceof Set ? beforeTargetIds : new Set(beforeTargetIds || []);
  const fresh = (targets || []).filter((target) => target && target.id && !before.has(target.id));
  return fresh.find((target) => targetTitleMatchesProject(target.title, projectPath)) || fresh[0] || null;
}

async function waitForNewCdpTarget(beforeTargetIds, maxMs = 12000, projectPath = '') {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const target = selectNewCdpTarget(beforeTargetIds, await listCdpPageTargets(), projectPath);
    if (target) return target;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  return null;
}
