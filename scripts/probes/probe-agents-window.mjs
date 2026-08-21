#!/usr/bin/env node
/**
 * 一次性探测：点击 Cursor "Agents Window" 按钮，观察打开什么窗口 + 新窗口能否 CDP 控制。
 * 关键分支：① Cursor 内新 Electron 窗口（同进程 → 出现在 /json/list → CDP 可控）；
 *           ② 跳外部浏览器/web（不在本 CDP 端口下 → 连不上）。
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
const sig = (t) => `[${t.type}] "${(t.title || '').slice(0, 45)}" | ${(t.url || '').slice(0, 90)}`;
const SEL = `a.open-agents-window-button,[class*=open-agents-window-button],[class*=open-agents-window]`;

async function main() {
  const before = await httpJson('/json/list');
  console.log('=== BEFORE targets (' + before.length + ') ===');
  before.forEach((t) => console.log('  ' + sig(t)));
  const beforeIds = new Set(before.map((t) => t.id));

  const page = before.find((t) => t.type === 'page' && /workbench/i.test(t.url || '')) || before.find((t) => t.type === 'page');
  if (!page) { console.log('NO workbench page'); return; }
  const c = makeClient(page.webSocketDebuggerUrl); await c.ready;

  const found = await evalJS(c, `(function(){const b=[...document.querySelectorAll(${JSON.stringify(SEL)})].find(e=>e.offsetParent!==null);if(!b)return JSON.stringify({found:false});const r=b.getBoundingClientRect();return JSON.stringify({found:true,text:(b.innerText||'').trim(),href:b.getAttribute('href')||null,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`);
  console.log('\n=== Agents Window 按钮探测 ===\n  ' + found);
  const fb = JSON.parse(found);
  if (!fb.found) { console.log('  ⚠️ 按钮当前不可见（可能要先打开某面板/某状态才显示）。未点击。'); c.close(); return; }

  console.log('  → 点击按钮…');
  await evalJS(c, `(function(){const b=[...document.querySelectorAll(${JSON.stringify(SEL)})].find(e=>e.offsetParent!==null);if(b)b.click();return 'clicked';})()`);
  c.close();
  await sleep(3500);

  const after = await httpJson('/json/list');
  const fresh = after.filter((t) => !beforeIds.has(t.id));
  console.log('\n=== AFTER targets (' + after.length + ')，新增 = ' + fresh.length + ' ===');
  if (!fresh.length) {
    console.log('  ⚠️ 无新 CDP target。可能：①同窗口内路由切换（没开新 renderer）；②打开了非 CDP 外部进程。列全部 after：');
    after.forEach((t) => console.log('  ' + sig(t)));
  }
  for (const t of fresh) {
    console.log('  NEW ' + sig(t));
    if (t.type !== 'page' || !t.webSocketDebuggerUrl) { console.log('    （非 page target，跳过 CDP 验证）'); continue; }
    try {
      const cc = makeClient(t.webSocketDebuggerUrl); await cc.ready;
      const info = await evalJS(cc, `JSON.stringify({href:location.href,title:document.title,bodyLen:(document.body&&document.body.innerText||'').length,hasInput:!!document.querySelector('textarea,[contenteditable],.aislash-editor-input'),inputCls:[...document.querySelectorAll('[contenteditable],textarea')].slice(0,3).map(e=>e.className).join(' | ')})`);
      console.log('    ✅ CDP 连上新窗口可操作: ' + info);
      cc.close();
    } catch (e) { console.log('    ❌ 新窗口 CDP 连接/操作失败: ' + e.message); }
  }
}
main().catch((e) => { console.error('PROBE_FAIL: ' + (e && e.message || e)); process.exit(1); });
