#!/usr/bin/env node
/**
 * 一次性探测：验证 CDP 能否往 Agents Window 的 TipTap/ProseMirror 输入框填字 + 发送钮状态随之变化。
 * 只填字、不点发送、测完清空——对用户无副作用。
 * 验证链：填字前发送钮 disabled → 填字后 enabled → 清空后回 disabled，即证明 ProseMirror 填字生效、发送可行。
 */
import { WebSocket } from 'ws';
import http from 'http';

const PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${PORT}`;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port: PORT, path }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('non-json')); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('CDP timeout')));
  });
}
function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl, { origin: ORIGIN });
  let id = 0; const pending = new Map();
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.once('error', rej); });
  ws.on('message', (data) => { let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result); } });
  const send = (method, params = {}) => { const myId = ++id; return new Promise((res, rej) => { const t = setTimeout(() => { if (pending.delete(myId)) rej(new Error('cmd timeout ' + method)); }, 15000); pending.set(myId, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); try { ws.send(JSON.stringify({ id: myId, method, params })); } catch (e) { clearTimeout(t); pending.delete(myId); rej(e); } }); };
  return { ready, send, close: () => { try { ws.close(); } catch {} } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJS(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true });
  if (r.exceptionDetails) throw new Error('page exc: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}
async function chord(c, modifiers, key, code, vk) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

const INPUT_SEL = `[contenteditable=true].ui-prompt-input-editor__input, .tiptap.ProseMirror[contenteditable=true]`;
const SNAP = `(function(){
  const i=document.querySelector(${JSON.stringify('[contenteditable=true].ui-prompt-input-editor__input, .tiptap.ProseMirror[contenteditable=true]')});
  const b=document.querySelector('.ui-prompt-input-submit-button, [aria-label="Send message"]');
  const stop=[...document.querySelectorAll('[class*=codicon-stop],[class*=debug-stop],[aria-label*=Stop],[aria-label*=stop],[aria-label*=Cancel]')].filter(e=>e.offsetParent!==null).length;
  return JSON.stringify({
    inputText:i?(i.innerText||'').slice(0,40):'NO_INPUT',
    btn: b?{disabled:!!(b.disabled||b.getAttribute('aria-disabled')==='true'||(b.className||'').toString().includes('disabled')),vis:b.offsetParent!==null,cls:(b.className||'').toString().slice(0,55)}:null,
    stop
  });
})()`;

async function main() {
  const list = await httpJson('/json/list');
  const t = list.find((x) => x.type === 'page' && /Cursor Agents/i.test(x.title || ''));
  if (!t) { console.log('未找到 "Cursor Agents" target'); return; }
  const c = makeClient(t.webSocketDebuggerUrl); await c.ready;

  console.log('1) 初始（空输入）：\n   ' + await evalJS(c, SNAP));

  // focus 输入框 + CDP 真实输入文本（ProseMirror 监听 beforeinput/input，Input.insertText 是 isTrusted 输入）
  const foc = await evalJS(c, `(function(){const i=document.querySelector(${JSON.stringify(INPUT_SEL)});if(!i)return 'NO_INPUT';i.focus();return i.className.slice(0,50);})()`);
  console.log('2) focus 输入框：' + foc);
  await c.send('Input.insertText', { text: '续跑探测请忽略' });
  await sleep(400);
  console.log('3) 填字后：\n   ' + await evalJS(c, SNAP));

  // 清空：Ctrl+A 全选 + Backspace
  await evalJS(c, `(function(){const i=document.querySelector(${JSON.stringify(INPUT_SEL)});if(i)i.focus();return 'ok';})()`);
  await chord(c, 2, 'a', 'KeyA', 65);
  await sleep(120);
  await chord(c, 0, 'Backspace', 'Backspace', 8);
  await sleep(300);
  console.log('4) 清空后：\n   ' + await evalJS(c, SNAP));

  c.close();
}
main().catch((e) => { console.error('PROBE_FAIL: ' + (e && e.message || e)); process.exit(1); });
