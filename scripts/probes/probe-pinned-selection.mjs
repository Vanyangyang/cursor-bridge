// Exercises the production picker path on the already-selected model only. Never submits a prompt.
import { makeClient } from '../../cdp-client.mjs';
import { CursorBridge, EXPR_MODEL_PICKER_TRIGGER } from '../../server.mjs';
const pages = await (await fetch('http://127.0.0.1:9223/json/list', { signal: AbortSignal.timeout(4000) })).json();
const matches = pages.filter(p => p.type === 'page' && p.title === 'Cursor Agents');
if (matches.length !== 1) throw new Error('requires one exact Agents target');
const client = makeClient(matches[0].webSocketDebuggerUrl, { origin: 'http://localhost:9223', commandTimeoutMs: 5000 });
const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
bridge._ensureCursor = async () => { throw new Error('probe must never initialize lifecycle'); };
const trace = [];
let lastSnapshot;
const read = bridge._readModelPickerRows.bind(bridge);
bridge._readModelPickerRows = async c => {
  const snapshot = await read(c);
  const reduced = { open: snapshot.open, rows: snapshot.rows.map(r => ({ text: r.text, kind: r.kind, selected: r.selected, x: r.x, y: r.y })) };
  const encoded = JSON.stringify(reduced);
  if (encoded !== lastSnapshot) { trace.push({ event: 'snapshot', ...reduced }); lastSnapshot = encoded; }
  return snapshot;
};
const click = bridge._clickModelPickerPoint.bind(bridge);
bridge._clickModelPickerPoint = async (c, point) => {
  if (['model', 'parameter'].includes(point.kind) && !point.selected) throw new Error('probe refuses changing model or effort');
  trace.push({ event: 'click', kind: point.kind, text: point.text, x: point.x, y: point.y });
  return click(c, point);
};
const hover = bridge._hoverModelPickerPoint.bind(bridge);
bridge._hoverModelPickerPoint = async (c, point) => {
  trace.push({ event: 'hover', kind: point.kind, text: point.text, x: point.x, y: point.y });
  return hover(c, point);
};
const job = { sendState: 'not_sent' };
const report = { targetId: matches[0].id };
try {
  await client.ready;
  const before = await bridge._readModelPickerTrigger(client);
  if (before.text !== 'Claude Fable 5.1 High') throw new Error('probe requires already-selected Claude Fable 5.1 High');
  report.before = before.text;
  if (process.argv.includes('--model-submenu-open')) {
    const root = await bridge._openModelPicker(client);
    await bridge._openModelPickerControl(client, root, 'model_control');
  }
  try { report.selection = await bridge._applyModelPreference(client, { model: 'Claude Fable 5.1', effort: 'high' }, job); }
  catch (error) { report.error = error.message; report.diagnostic = error.modelSelection; }
  report.after = (await bridge._readModelPickerTrigger(client)).text;
  report.menuClosed = !(await read(client)).open;
  report.sendState = job.sendState;
} finally {
  client.close();
}
console.log(JSON.stringify({ ...report, trace }));
if (report.error || report.selection?.applied !== true || !report.menuClosed || report.before !== report.after) process.exitCode = 1;
