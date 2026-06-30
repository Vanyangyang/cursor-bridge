#!/usr/bin/env node
/**
 * 一次性探测：连 "Cursor Agents"（Agents Window）page target，验证 CDP 可控 + dump 输入/发送/停止 DOM 结构。
 * 决定能否把 cursor-bridge 的自动化（长按发送/自动连跑）对准 Agents Window。
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
async function evalJS(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true });
  if (r.exceptionDetails) throw new Error('page exc: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}

async function main() {
  const list = await httpJson('/json/list');
  const t = list.find((x) => x.type === 'page' && /Cursor Agents/i.test(x.title || ''));
  if (!t) { console.log('未找到 "Cursor Agents" target，列全部 page：'); list.filter(x => x.type === 'page').forEach(x => console.log('  ' + x.title + ' | ' + (x.url || '').slice(0, 80))); return; }
  console.log('目标：' + t.title + ' | ' + (t.url || '').slice(0, 90));

  const c = makeClient(t.webSocketDebuggerUrl); await c.ready;
  // 1) 基本可控性 + 顶层结构
  const base = await evalJS(c, `JSON.stringify({href:location.href,title:document.title,bodyLen:(document.body&&document.body.innerText||'').length})`);
  console.log('\n=== 可控性 ===\n  ' + base);

  // 2) 输入框候选
  const inputs = await evalJS(c, `JSON.stringify([...document.querySelectorAll('[contenteditable=true],textarea,.aislash-editor-input,[class*=editor-input],[class*=composer] [contenteditable]')].slice(0,6).map(e=>({tag:e.tagName,cls:(e.className||'').toString().slice(0,70),vis:e.offsetParent!==null})))`);
  console.log('\n=== 输入框候选 ===\n  ' + inputs);

  // 3) 发送/提交钮候选
  const sendBtns = await evalJS(c, `JSON.stringify([...document.querySelectorAll('button,[role=button],a[role=button]')].filter(e=>e.offsetParent!==null).filter(e=>{const s=((e.getAttribute('aria-label')||'')+' '+(e.className||'')+' '+(e.innerText||'')).toLowerCase();return /send|submit|继续|arrow-up|enter/.test(s);}).slice(0,6).map(e=>({cls:(e.className||'').toString().slice(0,55),aria:e.getAttribute('aria-label'),txt:(e.innerText||'').slice(0,18)})))`);
  console.log('\n=== 发送/提交钮候选 ===\n  ' + sendBtns);

  // 4) 停止钮（生成中信号）数
  const stop = await evalJS(c, `JSON.stringify({stop:[...document.querySelectorAll('[class*=codicon-stop],[class*=debug-stop],[aria-label*=Stop],[aria-label*=stop],[aria-label*=Cancel]')].filter(e=>e.offsetParent!==null).length})`);
  console.log('\n=== 停止钮(生成中信号) ===\n  ' + stop);

  // 5) agent 卡片/列表 + 回复区
  const struct = await evalJS(c, `JSON.stringify({agentItems:[...document.querySelectorAll('[class*=agent-item],[class*=agent-list],[class*=composer-bar],[class*=conversation]')].slice(0,5).map(e=>(e.className||'').toString().slice(0,55)),markdown:[...document.querySelectorAll('.markdown-root,[class*=markdown]')].filter(e=>e.offsetParent!==null).length})`);
  console.log('\n=== agent 结构 + 回复区 ===\n  ' + struct);

  c.close();
}
main().catch((e) => { console.error('PROBE_FAIL: ' + (e && e.message || e)); process.exit(1); });
