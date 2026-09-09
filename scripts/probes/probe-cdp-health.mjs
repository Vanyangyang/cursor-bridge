// Read-only: no lifecycle initialization, input events, Agent creation or model changes.
import http from 'node:http';
import { WebSocket } from 'ws';
import { EXPR_PAGE_CAPABILITIES, EXPR_MODEL_PICKER_TRIGGER, EXPR_MODEL_PICKER_ROWS } from '../../server.mjs';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: 9223, path }, res => {
      let body = '';
      res.on('data', data => { body += data; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.setTimeout(4000, () => req.destroy(new Error('HTTP deadline')));
    req.on('error', reject);
  });
}

const report = { runtime: process.version, http: [], pages: [] };
let targets;
const extended = process.argv.includes('--extended');
for (let i = 0; i < (extended ? 30 : 8); i++) {
  const start = Date.now();
  try {
    targets = await get('/json/list');
    report.http.push({ ms: Date.now() - start, ok: true });
  } catch (e) { report.http.push({ ms: Date.now() - start, error: e.message }); }
  await new Promise(r => setTimeout(r, extended ? 1000 : 250));
}
for (const page of (targets || []).filter(p => p.type === 'page' && p.webSocketDebuggerUrl)) {
  const record = { id: page.id, title: page.title, samples: [], snapshots: {} };
  for (let i = 0; i < 3; i++) {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { origin: 'http://localhost:9223', handshakeTimeout: 5000 });
    let id = 0;
    const pending = new Map();
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (!pending.has(message.id)) return;
      const task = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    });
    const evaluate = expression => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('evaluate deadline')); }, 5000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    const sample = {};
    try {
      const start = Date.now();
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      sample.connectMs = Date.now() - start;
      const evalStart = Date.now();
      const ping = await evaluate('1+1');
      sample.evalMs = Date.now() - evalStart;
      sample.value = ping.result?.value;
      if (i === 0) {
        for (const [name, expression] of Object.entries({ capabilities: EXPR_PAGE_CAPABILITIES, trigger: EXPR_MODEL_PICKER_TRIGGER, menus: EXPR_MODEL_PICKER_ROWS })) {
          const result = await evaluate(expression);
          record.snapshots[name] = result.exceptionDetails ? { exception: result.exceptionDetails.text } : JSON.parse(result.result.value);
        }
      }
    } catch (e) { sample.error = e.message; }
    finally {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      ws.terminate();
    }
    record.samples.push(sample);
  }
  report.pages.push(record);
}
console.log(JSON.stringify(report));
if (!report.pages.some(p => p.title === 'Cursor Agents') || report.http.some(sample => !sample.ok)
  || report.pages.some(page => page.samples.some(sample => sample.error || sample.value !== 2))) process.exitCode = 1;
