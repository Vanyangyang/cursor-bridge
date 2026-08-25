#!/usr/bin/env node
/**
 * cursor-ensure-core.mjs — Cursor CDP ensure logic (no IPC / no supervisor).
 * Owned by the lifecycle supervisor on multi-adapter hosts; adapters should not
 * call this directly except via CURSOR_BRIDGE_INLINE_ENSURE=1 or tests.
 */
import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire as createNodeRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, win32 as winPath, posix as posixPath } from 'node:path';
import http from 'http';
import {
  findCursorPidByPort,
  normalizeCursorRuntimeMode,
  setCursorWindowPresentation,
  startMinimalWindowGuard,
} from './cursor-runtime.mjs';

export function resolveCursorLaunchCdpPort(port = process.env.CURSOR_BRIDGE_CDP_PORT) {
  const parsed = Number(port == null || String(port).trim() === '' ? 9223 : port);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return 9223;
  return parsed;
}

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
  const persisted = String(options.persistedProjectPath || '').trim();
  if (persisted) return resolve(normalizeCodexThreadCwd(persisted));
  const threadProjectPath = options.threadProjectPath === undefined
    ? resolveCodexThreadProjectPath(options)
    : options.threadProjectPath;
  if (threadProjectPath) return resolve(normalizeCodexThreadCwd(threadProjectPath));
  const cwd = options.cwd ?? process.cwd();
  if (!cwd || looksLikePluginRuntimePath(cwd)) return null;
  return resolve(cwd);
}

function cursorFromRegistry(options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const legacyExecSyncImpl = options.execSyncImpl;
  const existsImpl = options.existsImpl || existsSync;
  const queries = [
    ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe', '/ve'],
    ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe', '/ve'],
    ['HKCU\\Software\\Classes\\cursor\\shell\\open\\command', '/ve'],
    ['HKLM\\Software\\Classes\\cursor\\shell\\open\\command', '/ve'],
    ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor (User)', '/v', 'DisplayIcon'],
    ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor', '/v', 'DisplayIcon'],
  ];
  for (const [key, ...valueArgs] of queries) {
    try {
      const runOptions = {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      };
      // Preserve the old test/integration injection name without putting the
      // production path back through a command shell.
      const out = legacyExecSyncImpl && !options.execFileSyncImpl
        ? legacyExecSyncImpl(`reg query "${key}" ${valueArgs.join(' ')}`, runOptions)
        : execFileSyncImpl('reg.exe', ['query', key, ...valueArgs], runOptions);
      const m = out.match(/([A-Za-z]:\\[^"\r\n]*?Cursor\.exe)/i);
      if (m && existsImpl(m[1])) return m[1];
    } catch {}
  }
  return null;
}

export function normalizeCursorExeCandidate(value, options = {}) {
  const platform = options.platform || process.platform;
  const existsImpl = options.existsImpl || existsSync;
  const raw = String(value || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!raw) return null;
  let candidates;
  if (platform === 'win32') {
    const normalized = raw.replace(/\//g, '\\');
    candidates = /\.exe$/i.test(normalized)
      ? [normalized]
      : [winPath.join(normalized, 'Cursor.exe')];
  } else if (platform === 'darwin') {
    const normalized = raw.replace(/\\/g, '/').replace(/\/$/, '');
    candidates = /\.app$/i.test(normalized)
      ? [posixPath.join(normalized, 'Contents', 'MacOS', 'Cursor')]
      : /\/Contents\/MacOS$/i.test(normalized)
        ? [posixPath.join(normalized, 'Cursor')]
        : [normalized];
  } else {
    candidates = [raw];
  }
  for (const candidate of candidates) {
    try { if (existsImpl(candidate)) return candidate; } catch {}
  }
  return null;
}

export function findCursorExeDetails(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const existsImpl = options.existsImpl || existsSync;
  const override = normalizeCursorExeCandidate(env.CURSOR_EXE, { platform, existsImpl });
  if (override) return { path: override, source: 'CURSOR_EXE', platform };

  if (platform === 'win32') {
    const fromReg = cursorFromRegistry({
      execFileSyncImpl: options.execFileSyncImpl,
      execSyncImpl: options.execSyncImpl,
      existsImpl,
    });
    if (fromReg) return { path: fromReg, source: 'windows_registry', platform };
    const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || env.PROGRAMFILES_X86 || '';
    const candidates = [
      localAppData && winPath.join(localAppData, 'Programs', 'Cursor', 'Cursor.exe'),
      programFiles && winPath.join(programFiles, 'Cursor', 'Cursor.exe'),
      programFilesX86 && winPath.join(programFilesX86, 'Cursor', 'Cursor.exe'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (existsImpl(candidate)) return { path: candidate, source: 'windows_standard_location', platform };
      } catch {}
    }
    return null;
  }

  if (platform === 'darwin') {
    const userHome = env.HOME || homedir();
    const candidates = [
      '/Applications/Cursor.app/Contents/MacOS/Cursor',
      userHome && posixPath.join(userHome, 'Applications', 'Cursor.app', 'Contents', 'MacOS', 'Cursor'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (existsImpl(candidate)) return { path: candidate, source: 'macos_standard_location', platform };
      } catch {}
    }
    return null;
  }
  return null;
}

export function findCursorExe(options = {}) {
  return findCursorExeDetails(options)?.path || null;
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

export function cursorRunning(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.execFileSyncImpl || execFileSync;
  try {
    if (platform === 'win32') {
      return /Cursor\.exe/i.test(run('tasklist.exe', ['/fi', 'imagename eq Cursor.exe', '/nh'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
    }
    if (platform === 'darwin') {
      run('pgrep', ['-f', 'Cursor.app/Contents/MacOS/Cursor'], { stdio: 'ignore' });
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
  const cdpUpImpl = options.cdpUpImpl || cdpUp;
  const cdpIsCursorImpl = options.cdpIsCursorImpl || cdpIsCursor;
  const cursorRunningImpl = options.cursorRunningImpl || cursorRunning;
  const findCursorExeDetailsImpl = options.findCursorExeDetailsImpl || findCursorExeDetails;
  const projectPath = Object.hasOwn(options, 'projectPath')
    ? (options.projectPath ? resolve(String(options.projectPath)) : null)
    : resolveProjectPath();
  const listCdpPageTargetsImpl = options.listCdpPageTargetsImpl || listCdpPageTargets;
  const spawnImpl = options.spawnImpl || spawn;
  if (await cdpUpImpl()) {
    const isCursor = await cdpIsCursorImpl();
    if (isCursor) {
      const cursorPid = findCursorPidByPort(CDP_PORT);
      const windowGuard = effectiveRuntimeMode === 'minimal' && cursorPid
        ? startMinimalWindowGuard(cursorPid)
        : null;
      const presentation = effectiveRuntimeMode === 'minimal'
        ? setCursorWindowPresentation({ action: 'hide', port: CDP_PORT, pid: cursorPid })
        : null;
      const currentTargets = await listCdpPageTargetsImpl();
      const projectKey = normalizeProjectKey(projectPath);
      let targetId = projectKey ? PROJECT_TARGETS.get(projectKey) || null : (currentTargets[0] && currentTargets[0].id || null);
      let workspaceAction = projectPath ? 'reused-project-target' : 'reused-last-workspace';
      const cachedTarget = targetId ? currentTargets.find((target) => target.id === targetId) : null;
      if (targetId && (!cachedTarget || (projectPath && !targetCanServeProject(cachedTarget.title, projectPath)))) {
        PROJECT_TARGETS.delete(projectKey);
        targetId = null;
      } else if (targetId && cachedTarget && isAgentsWindowTitle(cachedTarget.title)) {
        workspaceAction = 'reused-agents-window';
      }
      if (projectPath && !targetId) {
        const existingTarget = currentTargets.find((target) => targetTitleMatchesProject(target.title, projectPath));
        if (existingTarget) {
          targetId = existingTarget.id;
          PROJECT_TARGETS.set(projectKey, targetId);
          workspaceAction = 'recovered-project-target';
        }
      }
      if (projectPath && !targetId) {
        const agentsTarget = selectAgentsWindowTarget(currentTargets);
        if (agentsTarget) {
          targetId = agentsTarget.id;
          PROJECT_TARGETS.set(projectKey, targetId);
          workspaceAction = 'reused-agents-window';
        }
      }
      if (projectPath && existsSync(projectPath) && !targetId) {
        const cursorExecutable = findCursorExeDetailsImpl();
        const exe = cursorExecutable && cursorExecutable.path;
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
            needsAction: 'install_or_locate_cursor',
            retryable: true,
            nextStep: 'Confirm that Cursor is installed and signed in. For a portable or custom installation, set CURSOR_EXE and run the same initialization command again.',
            message: `CCE connected to Cursor but cannot open workspace ${projectPath} because the Cursor executable was not found.`,
          };
        }
        const beforeTargetIds = new Set(currentTargets.map((target) => target.id));
        const opener = spawnImpl(exe, ['--new-window', projectPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: effectiveRuntimeMode === 'minimal',
        });
        opener.unref();
        workspaceAction = 'opened-new-window';
        const openedTarget = await waitForNewCdpTarget(beforeTargetIds, 12000, projectPath, listCdpPageTargetsImpl);
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
            cursorExecutable: exe,
            cursorExecutableSource: cursorExecutable.source,
            needsAction: 'retry_initialization',
            retryable: true,
            nextStep: 'Wait for Cursor to finish opening the project, then run the same initialization command again.',
            message: `Cursor opened the project, but CCE has not confirmed that workspace ${projectPath} is ready. Initialization stopped safely to avoid searching the wrong project.`,
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
        message: workspaceAction === 'reused-agents-window'
          ? `CDP ${CDP_PORT} responded as Cursor; Agents Window ${targetId} was reused without opening another IDE window.`
          : `CDP ${CDP_PORT} responded as Cursor; the target workspace is bound to CDP target ${targetId || 'default'}.`,
      };
    }
    return {
      ok: false,
      status: 'port-not-cursor',
      port: CDP_PORT,
      needsAction: 'free_cce_port',
      retryable: true,
      nextStep: `Local port ${CDP_PORT} is in use by another program. Close that program, then run the same initialization command again.`,
      message: `CCE cannot connect to Cursor because required local port ${CDP_PORT} is occupied by another program.`,
    };
  }
  if (cursorRunningImpl()) {
    const cursorExecutable = findCursorExeDetailsImpl();
    return {
      ok: false,
      status: 'running-no-debug',
      port: CDP_PORT,
      cursorExecutable: cursorExecutable && cursorExecutable.path || null,
      cursorExecutableSource: cursorExecutable && cursorExecutable.source || null,
      needsAction: 'close_cursor_and_retry',
      retryable: true,
      nextStep: projectPath
        ? `Save your work, exit Cursor normally once, then initialize CCE for workspace ${projectPath} again.`
        : 'Save your work, exit Cursor normally once, then retry the previous CCE operation.',
      message: 'Cursor was already running, so CCE cannot add the required connection capability in place. Cursor Bridge will not force-close it, protecting unsaved work.',
    };
  }
  const cursorExecutable = findCursorExeDetailsImpl();
  const exe = cursorExecutable && cursorExecutable.path;
  if (!exe) {
    return {
      ok: false,
      status: 'no-exe',
      port: CDP_PORT,
      needsAction: 'install_or_locate_cursor',
      retryable: true,
      nextStep: 'Install and sign in to Cursor first. For a portable or custom installation, set CURSOR_EXE and run the same initialization command again.',
      message: 'Cursor was not found. Standard Windows and macOS installations are detected automatically and normally do not require an explicit executable path.',
    };
  }

  const launchPort = resolveCursorLaunchCdpPort(CDP_PORT);
  const args = [`--remote-debugging-port=${launchPort}`, `--remote-allow-origins=http://localhost:${launchPort}`];
  if (effectiveRuntimeMode === 'minimal') {
    args.push(
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    );
  }
  if (projectPath && existsSync(projectPath)) args.push(projectPath);
  const child = spawnImpl(exe, args, {
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
      cursorExecutable: exe,
      cursorExecutableSource: cursorExecutable.source,
      needsAction: 'retry_initialization',
      retryable: true,
      nextStep: 'Wait a moment, then run the same initialization command again.',
      message: 'Cursor started, but CCE is not ready yet. No port setting needs to be changed.',
    };
  }
  const cursorPid = findCursorPidByPort(CDP_PORT) || child.pid || null;
  const openedTarget = await waitForNewCdpTarget(new Set(), 12000, projectPath, listCdpPageTargetsImpl);
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
      cursorExecutable: exe,
      cursorExecutableSource: cursorExecutable.source,
      needsAction: 'retry_initialization',
      retryable: true,
      nextStep: 'Wait for Cursor to finish opening the project, then run the same initialization command again.',
      message: `Cursor started, but CCE has not confirmed that workspace ${projectPath} is ready. Initialization stopped safely to avoid searching the wrong project.`,
    };
  }
  if (projectPath && targetId) PROJECT_TARGETS.set(normalizeProjectKey(projectPath), targetId);
  const windowGuard = effectiveRuntimeMode === 'minimal' && cursorPid
    ? startMinimalWindowGuard(cursorPid)
    : null;
  const target = projectPath ? `opening ${projectPath}` : 'restoring the previous workspace';
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
    cursorExecutable: exe,
    cursorExecutableSource: cursorExecutable.source,
    targetId,
    workspaceAction: projectPath ? 'launched-project' : 'launched-last-workspace',
    message: `Cursor started (${exe}, ${target}); CDP ${CDP_PORT} is ready.`,
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

export function isAgentsWindowTitle(title) {
  const normalized = String(title || '').trim().toLowerCase();
  return normalized === 'cursor agents' || normalized.startsWith('cursor agents - ');
}

export function targetCanServeProject(title, projectPath) {
  if (!projectPath) return true;
  return targetTitleMatchesProject(title, projectPath) || isAgentsWindowTitle(title);
}

export function selectAgentsWindowTarget(targets) {
  return (Array.isArray(targets) ? targets : []).find((target) => target && target.id && isAgentsWindowTitle(target.title)) || null;
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

async function waitForNewCdpTarget(beforeTargetIds, maxMs = 12000, projectPath = '', listImpl = listCdpPageTargets) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const target = selectNewCdpTarget(beforeTargetIds, await listImpl(), projectPath);
    if (target) return target;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  return null;
}
