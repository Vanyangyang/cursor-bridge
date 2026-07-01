#!/usr/bin/env node
/**
 * launch-cursor.mjs — 把 Cursor 带 CDP 调试口的启动收编进 MCP server。
 *
 * 让 cursor-bridge 在 Cursor 没带调试口运行时自动拉起（带 CDP），于是 cursor_search 冷启动也能用。
 *
 * 关键点：
 *   - 必须带 --remote-debugging-port=9223 + --remote-allow-origins（Chromium 111+/Electron 否则 CDP WS 403）。
 *     端口用 9223（避开 9222 等常见 Electron 调试口，避免端口冲突——2026-06-08 实测撞过）。
 *   - 启动时带项目路径，让 Cursor 打开本项目（语义搜索需对本项目建索引）。
 *   - ⚠️ Cursor 是用户日常 IDE（非专用 bridge），单实例锁下「在跑但没带 flag」时【绝不主动 kill】
 *     （会打断用户工作 + 丢未保存内容），只返回 running-no-debug 指引，由用户决定是否重启。
 *   - detached + unref：拉起的 Cursor 脱离 MCP server 独立存活。
 *
 * 用法：node launch-cursor.mjs   （或被 server 自愈钩子 import { ensureCursorRunning }）
 */
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import http from 'http';

const CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const CDP_ORIGIN = `http://localhost:${CDP_PORT}`;
// 探测连接目标用字面 IP，不用 'localhost'——Windows 上常优先解析到 ::1，但 Chromium 只监听 IPv4 127.0.0.1（2026-07 实测 ECONNREFUSED）。
// CDP_ORIGIN 仍保留 localhost 字符串：它是 --remote-allow-origins 的值，需跟 server.mjs 发的 WS Origin 头一致，与探测连接无关。
const CDP_HOST = '127.0.0.1';
// 项目根：env 优先（推荐显式设 CURSOR_PROJECT_PATH），否则用 MCP 客户端启动时的工作目录（= 用户当前项目）。
// 不从本文件位置上推目录——发布为 npm 包后文件在 node_modules/npx 缓存里，上推会指向错目录。
const PROJECT_PATH = process.env.CURSOR_PROJECT_PATH || process.cwd();

// 注册表探测：从 cursor:// 协议处理器 + Uninstall DisplayIcon 解析 Cursor.exe，
// 任何安装位置（C 盘默认 / 任意盘自定义）都能自动找到，不依赖写死路径。仅 Windows。
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
      const m = out.match(/([A-Za-z]:\\[^"\r\n]*?Cursor\.exe)/i);   // 抓 X:\...\Cursor.exe（带不带引号都行）
      if (m && existsSync(m[1])) return m[1];
    } catch {}
  }
  return null;
}

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Windows 默认安装位置兜底（注册表查不到时）
const WIN_FALLBACKS = [
  `${process.env.LOCALAPPDATA || ''}\\Programs\\cursor\\Cursor.exe`,
  'C:\\Program Files\\cursor\\Cursor.exe',
];
// macOS 默认 Cursor.app 位置（直接 spawn app 内的二进制，flag 才能可靠传给 Electron）
const MAC_CANDIDATES = [
  '/Applications/Cursor.app/Contents/MacOS/Cursor',
  `${process.env.HOME || ''}/Applications/Cursor.app/Contents/MacOS/Cursor`,
];

function findCursorExe() {
  if (process.env.CURSOR_EXE && existsSync(process.env.CURSOR_EXE)) return process.env.CURSOR_EXE;  // 最高优先级覆盖（任意平台）
  if (IS_WIN) {
    const fromReg = cursorFromRegistry();   // 注册表探测：任何安装位置都能找到
    if (fromReg) return fromReg;
    for (const p of WIN_FALLBACKS) { try { if (existsSync(p)) return p; } catch {} }
    return null;
  }
  if (IS_MAC) {
    for (const p of MAC_CANDIDATES) { try { if (existsSync(p)) return p; } catch {} }
    return null;
  }
  return null;   // Linux 等：用 CURSOR_EXE 指定可执行文件路径
}
function cdpUp(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: '/json/version' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve(false); });
  });
}
// 验证 9223 上确实是 Cursor（不是别的 Electron 应用）——避免端口被别的 IDE 占用时误判。
// 用【路径段包围】的 cursor 目录 + app 路径特征判定（Cursor 安装目录名恒为 cursor：…/cursor/resources/app…），
// 并先排除已知别家 IDE（windsurf 等）。不用裸子串 `cursor`——它会把 url/title 含该字样的别家 target 误判（2026-06-08 review #3）。
function cdpIsCursor(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: '/json/list' }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          if (/[\/\\](windsurf)[\/\\]/i.test(d)) return resolve(false);   // 别家 IDE 占口，明确否定
          resolve(/[\/\\]cursor[\/\\](resources|app)|cursor\.exe|vscode-app[^"]*[\/\\]cursor[\/\\]/i.test(d));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve(false); });
  });
}
function cursorRunning() {
  try {
    if (IS_WIN) return /Cursor\.exe/i.test(execSync('tasklist /fi "imagename eq Cursor.exe" /nh', { encoding: 'utf8', windowsHide: true }));
    if (IS_MAC) { execSync("pgrep -f 'Cursor.app/Contents/MacOS/Cursor'", { stdio: 'ignore' }); return true; }  // pgrep 命中=退出码0；无则抛错→false
    return false;
  } catch { return false; }
}
async function waitForCdp(maxMs = 30000, stepMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) { if (await cdpUp()) return true; await new Promise((r) => setTimeout(r, stepMs)); }
  return false;
}

/**
 * 确保 Cursor 带 CDP 调试口在运行。幂等。
 * status: 'already' | 'launched' | 'running-no-debug'（在跑但没 flag，需用户手动退）| 'port-not-cursor'（9223 被别的 IDE 占）| 'no-exe' | 'timeout'
 */
export async function ensureCursorRunning({ waitMs = 30000 } = {}) {
  if (await cdpUp()) {
    const isCursor = await cdpIsCursor();
    if (isCursor) return { ok: true, status: 'already', port: CDP_PORT, message: `CDP ${CDP_PORT} 已响应且是 Cursor。` };
    return { ok: false, status: 'port-not-cursor', port: CDP_PORT, message: `CDP ${CDP_PORT} 被【非 Cursor】的 IDE 占用。换端口或排查。` };
  }
  if (cursorRunning()) {
    return { ok: false, status: 'running-no-debug', port: CDP_PORT,
      message: `Cursor 正在运行但没带 --remote-debugging-port=${CDP_PORT}（单实例锁会忽略 flag）。请先彻底退出 Cursor（Windows：全部窗口+托盘；macOS：Cmd+Q），cursor-bridge 会在下次调用时自动带 flag 拉起；或手动带 flag 重启。注意：不主动 kill 以免丢未保存内容。` };
  }
  const exe = findCursorExe();
  if (!exe) return { ok: false, status: 'no-exe', port: CDP_PORT, message: `找不到 Cursor 可执行文件（Windows：注册表/默认位置；macOS：/Applications/Cursor.app 都没命中）。设环境变量 CURSOR_EXE 指定完整路径。` };

  const args = [`--remote-debugging-port=${CDP_PORT}`, `--remote-allow-origins=${CDP_ORIGIN}`];
  if (PROJECT_PATH && existsSync(PROJECT_PATH)) args.push(PROJECT_PATH);   // 打开本项目让 Cursor 建索引
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const up = await waitForCdp(waitMs);
  if (!up) return { ok: false, status: 'timeout', exe, port: CDP_PORT, message: `已启动 Cursor（${exe}），但 ${waitMs}ms 内 CDP ${CDP_PORT} 未就绪，稍后重试。` };
  return { ok: true, status: 'launched', exe, port: CDP_PORT, message: `已启动 Cursor（${exe}，打开 ${PROJECT_PATH}），CDP ${CDP_PORT} 就绪。` };
}

// 仅在「直接 node launch-cursor.mjs」时自执行。文件名守卫不可省：被 esbuild 打进 server 单文件后，
// import.meta.url 和 process.argv[1] 对所有内联模块都指向同一个 bundle，光靠 === 会让本块误判为入口
// → 往 stdout 打 JSON 污染 MCP 协议流 + process.exit 杀掉 server。
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href
  && import.meta.url.endsWith('launch-cursor.mjs');
if (isMain) {
  ensureCursorRunning()
    .then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error('LAUNCH_FAIL: ' + (e && e.message || e)); process.exit(1); });
}
