#!/usr/bin/env node
/** 一次性探测：精确区分 Agents Window 真输入框 vs readonly 历史区。纯 dump，无操作。 */
import { WebSocket } from 'ws';
import http from 'http';
const PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${PORT}`;
function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port: PORT, path }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('non-json')); } }); });
    req.on('error', reject); req.setTimeout(4000, () => req.destroy(new Error('CDP timeout')));
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
async function evalJS(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true });
  if (r.exceptionDetails) throw new Error('page exc: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}
async function main() {
  const list = await httpJson('/json/list');
  const t = list.find((x) => x.type === 'page' && /Cursor Agents/i.test(x.title || ''));
  if (!t) { console.log('未找到 "Cursor Agents" target'); return; }
  const c = makeClient(t.webSocketDebuggerUrl); await c.ready;

  // 所有可能输入元素：标注 contenteditable / readonly / 可见 / 内容
  const cands = await evalJS(c, `JSON.stringify([...document.querySelectorAll('[contenteditable],textarea,.tiptap,[class*=ProseMirror],[class*=editor-input],[class*=prompt-input]')].map((e,i)=>({i,tag:e.tagName,cls:(e.className||'').toString().slice(0,75),ce:e.getAttribute('contenteditable'),ro:((e.className||'').toString().includes('readonly')||e.hasAttribute('readonly')),vis:e.offsetParent!==null,text:(e.innerText||'').slice(0,18)})))`);
  console.log('=== 所有输入候选 ===');
  JSON.parse(cands).forEach(e => console.log('  #' + e.i + ' [' + e.tag + '] ce=' + e.ce + ' ro=' + e.ro + ' vis=' + e.vis + ' | ' + e.cls + ' | "' + e.text + '"'));

  // 真输入框定义：contenteditable=true && !readonly && 可见
  const real = await evalJS(c, `(function(){const r=[...document.querySelectorAll('[contenteditable=true]')].filter(e=>e.offsetParent!==null && !((e.className||'').toString().includes('readonly')));return JSON.stringify(r.map(e=>({cls:(e.className||'').toString().slice(0,75),text:(e.innerText||'').slice(0,20)})));})()`);
  console.log('\n=== 真输入框候选（contenteditable=true && !readonly && vis）===\n  ' + real);

  c.close();
}
main().catch((e) => { console.error('PROBE_FAIL: ' + (e && e.message || e)); process.exit(1); });
