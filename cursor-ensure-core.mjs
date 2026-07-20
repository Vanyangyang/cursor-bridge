#!/usr/bin/env node
/**
 * cursor-ensure-core.mjs — Cursor CDP ensure logic (no IPC / no supervisor).
 * Owned by the lifecycle supervisor on multi-adapter hosts; adapters should not
 * call this directly except via CURSOR_BRIDGE_INLINE_ENSURE=1 or tests.
 */
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import http from 'http';

export const CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
export const CDP_ORIGIN = `http://localhost:${CDP_PORT}`;
// Probe with literal IPv4 — Windows often resolves localhost to ::1 while Chromium listens on 127.0.0.1.
export const CDP_HOST = '127.0.0.1';

export function looksLikePluginRuntimePath(candidate) {
  const p = String(candidate || '').replace(/\//g, '\\').toLowerCase();
  return p.includes('\\.codex\\.tmp\\marketplaces\\') ||
    p.includes('\\.codex\\plugins\\cache\\') ||
    p.includes('\\.claude\\plugins\\cache\\') ||
    p.includes('\\appdata\\local\\npm-cache\\_npx\\');
}

export function resolveProjectPath() {
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
export async function ensureCursorRunningLocal({ waitMs = 30000 } = {}) {
  if (await cdpUp()) {
    const isCursor = await cdpIsCursor();
    if (isCursor) {
      return { ok: true, status: 'already', port: CDP_PORT, message: `CDP ${CDP_PORT} 已响应且是 Cursor。` };
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
      message: `Cursor 正在运行但没带 --remote-debugging-port=${CDP_PORT}（单实例锁会忽略 flag）。请先彻底退出 Cursor（Windows：全部窗口+托盘；macOS：Cmd+Q），cursor-bridge 会在下次调用时自动带 flag 拉起；或手动带 flag 重启。注意：不主动 kill 以免丢未保存内容。`,
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

  const projectPath = resolveProjectPath();
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--remote-allow-origins=${CDP_ORIGIN}`];
  if (projectPath && existsSync(projectPath)) args.push(projectPath);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const up = await waitForCdp(waitMs);
  if (!up) {
    return {
      ok: false,
      status: 'timeout',
      exe,
      port: CDP_PORT,
      message: `已启动 Cursor（${exe}），但 ${waitMs}ms 内 CDP ${CDP_PORT} 未就绪，稍后重试。`,
    };
  }
  const target = projectPath ? `打开 ${projectPath}` : '恢复上次工作区';
  return {
    ok: true,
    status: 'launched',
    exe,
    port: CDP_PORT,
    message: `已启动 Cursor（${exe}，${target}），CDP ${CDP_PORT} 就绪。`,
  };
}
