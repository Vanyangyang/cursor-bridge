// One fresh, read-only task with bounded diagnostics. No model preference mutation.
import { CursorBridge } from '../../server.mjs';
const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null, sessionFile: null,
  projectPath: process.cwd(), runtimeMode: 'normal' });
const trace = [];
const health = [];
let activeJob;
let lastRows;
const originalRead = bridge._readModelPickerRows.bind(bridge);
bridge._readModelPickerRows = async (...args) => {
  const started = Date.now();
  const snapshot = await originalRead(...args);
  const rows = snapshot.rows.slice(0, 20).map(({ text, kind, selected, x, y }) => ({ text, kind, selected, x, y }));
  const signature = JSON.stringify({ open: snapshot.open, rows });
  if (signature !== lastRows) { trace.push({ event: 'rows', at: Date.now(), ms: Date.now() - started, open: snapshot.open, rows }); lastRows = signature; }
  return snapshot;
};
const originalClick = bridge._clickModelPickerPoint.bind(bridge);
bridge._clickModelPickerPoint = async (client, point) => {
  const expression = `(()=>{const x=${Number(point.x)}, y=${Number(point.y)};
    const hit=document.elementFromPoint(x,y); const owner=hit&&hit.closest('[role="menuitem"],[role="option"],button,[data-component="menu-row"],[data-component="menu-submenu-trigger"]');
    const node=owner||hit; const r=node&&node.getBoundingClientRect();
    const describe=n=>({tag:n.tagName,role:n.getAttribute('role'),component:n.getAttribute('data-component'),
      pointerEvents:getComputedStyle(n).pointerEvents,zIndex:getComputedStyle(n).zIndex,text:String(n.innerText||'').slice(0,120)});
    return {width:innerWidth,height:innerHeight,visibility:document.visibilityState,
      stack:document.elementsFromPoint(x,y).slice(0,6).map(describe),
      controls:[...document.querySelectorAll('[data-component="menu-submenu-trigger"]')].filter(n=>n.offsetParent!==null).map(describe),
      hit:node?{tag:node.tagName,role:node.getAttribute('role'),component:node.getAttribute('data-component'),text:String(node.innerText||'').slice(0,180),
      rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:null};})()`;
  const hit = await client.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 1500 });
  trace.push({ event: 'click', at: Date.now(), point: { text: point.text, kind: point.kind, x: point.x, y: point.y }, hit: hit.result?.value });
  return originalClick(client, point);
};
const originalApply = bridge._applyModelPreference.bind(bridge);
bridge._applyModelPreference = async (client, preference, job) => {
  activeJob = job;
  trace.push({ event: 'selection-start', at: Date.now(), taskId: job.id, targetId: job.targetId, preference });
  const send = client.send.bind(client);
  client.send = async (method, params, options) => {
    const start = Date.now();
    try {
      const result = await send(method, params, options);
      if (method === 'Input.dispatchMouseEvent' && ['mousePressed','mouseReleased'].includes(params.type)) {
        const state = await send('Runtime.evaluate', { expression: `JSON.stringify([...document.querySelectorAll('[role="menu"]')].filter(n=>n.offsetParent!==null).map(n=>({testId:n.getAttribute('data-testid'),component:n.getAttribute('data-component'),text:String(n.innerText||'').slice(0,400)})))`, returnByValue: true }, { timeoutMs: 1500 });
        trace.push({ event: 'after-input', type: params.type, at: Date.now(), menus: JSON.parse(state.result.value) });
      }
      if (Date.now() - start > 100) trace.push({ event: 'slow-cdp', method, ms: Date.now() - start });
      return result;
    } catch (error) {
      trace.push({ event: 'cdp-error', method, ms: Date.now() - start, code: error.code, message: error.message, cdp: error.cdp });
      throw error;
    }
  };
  try { return await originalApply(client, preference, job); }
  finally { client.send = send; trace.push({ event: 'selection-end', at: Date.now(), selection: job.modelSelection, sendState: job.sendState }); }
};
let probing = false;
async function sampleHealth() {
  if (probing) return;
  probing = true;
  const started = Date.now();
  try {
    const response = await fetch('http://127.0.0.1:9223/json/list', { signal: AbortSignal.timeout(1500) });
    const pages = await response.json();
    health.push({ at: started, ms: Date.now() - started, targets: pages.filter(p => p.type === 'page').map(p => ({ id: p.id, title: p.title })) });
  } catch (error) { health.push({ at: started, ms: Date.now() - started, error: error.message }); }
  finally { probing = false; }
}
await sampleHealth();
const timer = setInterval(sampleHealth, 1000);
try {
  const result = await bridge.doTask('只读 CDP 稳定性验证：读取根目录 package.json，只报告 name 和 version。禁止修改、创建或删除文件。',
    { background: false, execution: 'fifo', readOnly: true, timeoutMs: 180000,
      requestContext: { sender: 'model', source: 'model' } });
  console.log(JSON.stringify({ passed: result.status === 'completed', taskId: result.taskId, agentId: result.agentId,
    modelSelection: result.modelSelection, result: result.result, trace, health }));
  if (result.status !== 'completed') process.exitCode = 1;
} catch (error) {
  const failedJob = activeJob || [...bridge.tasks.values()].at(-1);
  console.log(JSON.stringify({ passed: false, error: error.message, cdp: error.cdp,
    taskId: failedJob?.id, agentId: failedJob?.agentId, targetId: failedJob?.targetId, sendState: failedJob?.sendState,
    modelSelection: error.modelSelection || failedJob?.modelSelection, trace, health }));
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}
