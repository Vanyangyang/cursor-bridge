#!/usr/bin/env node
/** 一次性实测：向 Agents Window 发一轮，验证整链（填字 → 点发送 → stop 0→>0）。不循环。
 *  用安全测试内容（非「继续」），避免误推当前 agent 去干活。 */
import { WebSocket } from 'ws';
import http from 'http';
const PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${PORT}`;
const MSG = process.env.TEST_MSG || '（cursor-bridge 自动续跑链路测试，无需回应/无需执行任何操作）';

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port: PORT, path }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('non-json')); } }); });
    req.on('error', reject); req.setTimeout(4000, () => req.destroy(new Error('CDP timeout')));
  });
}
function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl, { origin: ORIGIN });
  let id = 0; const pending = new Map();
  const failAll = (m) => { for (const { rej } of pending.values()) { try { rej(new Error(m)); } catch {} } pending.clear(); };
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.once('error', rej); });
  ws.on('message', (data) => { let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result); } });
  ws.on('close', () => failAll('ws closed')); ws.on('error', (e) => failAll('ws err ' + (e && e.message)));
  const send = (method, params = {}) => { const myId = ++id; return new Promise((res, rej) => { const t = setTimeout(() => { if (pending.delete(myId)) rej(new Error('cmd timeout ' + method)); }, 30000); pending.set(myId, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); try { ws.send(JSON.stringify({ id: myId, method, params })); } catch (e) { clearTimeout(t); pending.delete(myId); rej(e); } }); };
  return { ready, send, close: () => { try { ws.close(); } catch {} } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJS(c, expr) { const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true }); if (r.exceptionDetails) throw new Error('exc: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result && r.result.value; }
async function chord(c, mod, key, code, vk) { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mod, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mod, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); }

const INPUT_SEL = '[contenteditable=true].ui-prompt-input-editor__input, .tiptap.ProseMirror[contenteditable=true]';
const EXPR_STOP = `[...document.querySelectorAll('[class*=codicon-stop],[class*=debug-stop],[aria-label*=Stop],[aria-label*=stop],[aria-label*=Cancel]')].filter(e=>e.offsetParent!==null).length`;
const EXPR_INPUT = `(function(){const i=document.querySelector(${JSON.stringify(INPUT_SEL)});return i?(i.innerText||'').slice(0,50):'NO_INPUT';})()`;

async function waitStop(c, label) { for (let i = 0; i < 12; i++) { await sleep(600); const s = await evalJS(c, EXPR_STOP); if (s > 0) { console.log(`   ✅ ${((i + 1) * 0.6).toFixed(1)}s 后检测到 stop=${s} → agent 开始生成，${label}发送成功！`); return true; } } return false; }

async function main() {
  const list = await httpJson('/json/list');
  const t = list.find((x) => x.type === 'page' && /Cursor Agents/i.test(x.title || ''));
  if (!t) { console.log('❌ 未找到 Agents Window'); return; }
  const c = makeClient(t.webSocketDebuggerUrl); await c.ready;

  const before = await evalJS(c, EXPR_STOP);
  console.log('发送前 stop 数: ' + before);
  if (before > 0) { console.log('⚠️ 当前已在生成(stop>0)，agent 忙，跳过发送测试（避免插队）。'); c.close(); return; }

  const foc = await evalJS(c, `(function(){const i=document.querySelector(${JSON.stringify(INPUT_SEL)});if(!i)return false;i.focus();return true;})()`);
  console.log('focus 真输入框: ' + foc);
  await c.send('Input.insertText', { text: MSG });
  await sleep(350);
  console.log('填字后输入框: "' + (await evalJS(c, EXPR_INPUT)) + '"');

  const clicked = await evalJS(c, `(function(){const b=document.querySelector('.ui-prompt-input-submit-button,[aria-label="Send message"]');if(b){b.click();return true;}return false;})()`);
  console.log('点发送钮(.ui-prompt-input-submit-button): ' + clicked);

  if (await waitStop(c, '点钮')) { c.close(); return; }
  console.log('   点钮未出现 stop，试 Enter 兜底…');
  await evalJS(c, `(function(){const i=document.querySelector(${JSON.stringify(INPUT_SEL)});if(i)i.focus();return 1;})()`);
  await chord(c, 0, 'Enter', 'Enter', 13);
  if (await waitStop(c, 'Enter 兜底')) { c.close(); return; }

  console.log('   ❌ 两种方式都没出现 stop。当前输入框残留: "' + (await evalJS(c, EXPR_INPUT)) + '"（可能需调发送方式）');
  c.close();
}
main().catch((e) => { console.error('TEST_FAIL: ' + (e && e.message || e)); process.exit(1); });
