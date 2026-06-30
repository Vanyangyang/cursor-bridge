#!/usr/bin/env node
/**
 * agents-autopilot — Cursor Agents Window「按住 Enter」引擎（CDP 直驱，沿用 cursor-bridge）。
 *
 * 行为（按 owner 2026-06-08 定，极简）：
 *   纯模拟【按住 Enter】——不填字、不碰输入框、不发「继续」。
 *   仅在【可发送态(无 stop)】按 Enter；发送钮一变 stop 态(agent 生成中)就【立即松开、不再按】
 *   （否则持续 Enter 会按到 stop 钮误终止对话）；回到可发送态再继续按。
 *   【不自动停】：只有手动点 OFF / 关窗（删信号文件）才停。
 *
 * 开关 = 信号文件（默认同目录 .autopilot.on）：存在=运行，删除=停。引擎崩溃也会清掉该文件（便于 UI 同步回 OFF）。
 *
 * 用法：node agents-autopilot.mjs        （前台跑，读信号文件；或由 Tkinter 小窗 spawn）
 * 前提：Cursor 带 --remote-debugging-port=9223 + Agents Window 打开。
 *
 * 可调 env：
 *   AUTOPILOT_FLAG          信号文件路径（默认 ./.autopilot.on）
 *   AUTOPILOT_REPEAT_MS     按住 Enter 的重复间隔 ms（默认 60，模拟 key autorepeat）
 *   CURSOR_BRIDGE_CDP_PORT  CDP 端口（默认 9223）
 */
import { WebSocket } from 'ws';
import http from 'http';
import { existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${PORT}`;
const __dir = dirname(fileURLToPath(import.meta.url));
const FLAG = process.env.AUTOPILOT_FLAG || join(__dir, '.autopilot.on');
const REPEAT_MS = Number(process.env.AUTOPILOT_REPEAT_MS || 60);

// ---------- CDP helpers（含 failAll + per-command 超时，沿用 cursor-bridge 修复版）----------
function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port: PORT, path }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('non-json')); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error(`CDP ${PORT} 无响应`)));
  });
}
function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl, { origin: ORIGIN });
  let id = 0; const pending = new Map();
  const failAll = (msg) => { for (const { rej } of pending.values()) { try { rej(new Error(msg)); } catch {} } pending.clear(); };
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.once('error', rej); });
  ws.on('message', (data) => { let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result); } });
  ws.on('close', () => failAll('CDP ws 已关闭'));
  ws.on('error', (e) => failAll('CDP ws 出错: ' + (e && e.message)));
  const CMD_TIMEOUT = 30000;
  const send = (method, params = {}) => {
    const myId = ++id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (pending.delete(myId)) rej(new Error(`CDP 命令超时 ${method}`)); }, CMD_TIMEOUT);
      pending.set(myId, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      try { ws.send(JSON.stringify({ id: myId, method, params })); } catch (e) { clearTimeout(t); pending.delete(myId); rej(e); }
    });
  };
  return { ready, send, close: () => { try { ws.close(); } catch {} } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJS(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true });
  if (r.exceptionDetails) throw new Error('page exc: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}
const ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };

const EXPR_STOP = `[...document.querySelectorAll('[class*=codicon-stop],[class*=debug-stop],[aria-label*=Stop],[aria-label*=stop],[aria-label*=Cancel]')].filter(e=>e.offsetParent!==null).length`;

async function findAgentsPage() {
  const list = await httpJson('/json/list');
  const t = list.find((x) => x.type === 'page' && /Cursor Agents/i.test(x.title || ''));
  if (!t) throw new Error('未找到 Agents Window（"Cursor Agents" target）。请在 Cursor 打开 Agents Window。');
  return t;
}

async function main() {
  if (!existsSync(FLAG)) { console.error('信号文件不存在(' + FLAG + ')，未开启。创建它即开始。'); process.exit(0); }
  const t = await findAgentsPage();
  const c = makeClient(t.webSocketDebuggerUrl); await c.ready;

  // 纯按住 Enter —— 不填字、不碰输入框。仅可发送态(无 stop)按；变 stop 态立即松开不按（避免误触 stop）。不自动停。
  console.error(`⏬ 开始按住 Enter（仅可发送态；变 stop 态松手避免误触；点 OFF/关窗 才停）。不填字、不管输入框。`);
  let holding = false;   // 当前是否正按着 Enter
  const enterUp = async () => { try { await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER }); } catch {} };
  try {
    while (existsSync(FLAG)) {
      let stop = 0;
      try { stop = await evalJS(c, EXPR_STOP); } catch {}
      if (stop > 0) {
        // 生成中：松开 Enter（若正按着）、停止按键。绝不在 stop 态发 Enter（会误触 stop 钮）。等回到可发送态。
        if (holding) { await enterUp(); holding = false; }
      } else {
        // 可发送态：按住 Enter（首次 keyDown，之后 autoRepeat）
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: holding, ...ENTER });
        holding = true;
      }
      await sleep(REPEAT_MS);
    }
  } finally {
    if (holding) await enterUp();   // 收尾松手（手动停时信号文件已被 UI/用户删除）
    c.close();
  }
  console.error('🔴 已松手停止（手动 OFF / 关窗）。');
}
main().catch((e) => {
  console.error('AUTOPILOT_FAIL: ' + (e && e.message || e));
  try { if (existsSync(FLAG)) unlinkSync(FLAG); } catch {}   // 崩溃也清信号文件，让 Tkinter UI 同步回 OFF
  process.exit(1);
});
