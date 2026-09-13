// No prompts or persistent preference writes. Temporarily select Auto, then
// restore the already-pinned Fable/high through the production selection path.
import { makeClient } from '../../cdp-client.mjs';
import { CursorBridge, selectModelPickerRow } from '../../server.mjs';
const pages = await (await fetch('http://127.0.0.1:9223/json/list', { signal: AbortSignal.timeout(4000) })).json();
const targets = pages.filter(p => p.type === 'page' && p.title === 'Cursor Agents');
if (targets.length !== 1) throw new Error('Expected one Agents Window');
const c = makeClient(targets[0].webSocketDebuggerUrl, { origin: 'http://localhost:9223', commandTimeoutMs: 5000 });
const b = new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null });
const preference = { model: 'Claude Fable 5.1', effort: 'high' };
const trace = [];
const read = b._readModelPickerRows.bind(b);
b._readModelPickerRows = async (...args) => {
  const snapshot = await read(...args);
  trace.push({ event: 'rows', open: snapshot.open, rows: snapshot.rows.map(({ text, kind, selected, pointerEvents, submenu, hasSubmenu }) => ({ text, kind, selected, pointerEvents, submenu, hasSubmenu })) });
  return snapshot;
};
const click = b._clickModelPickerPoint.bind(b);
b._clickModelPickerPoint = async (client, row) => {
  trace.push({ event: 'click', text: row.text, kind: row.kind, selected: row.selected, pointerEvents: row.pointerEvents });
  return click(client, row);
};
const report = { targetId: targets[0].id, sendState: 'not_sent' };
try {
  await c.ready;
  const before = await b._readModelPickerTrigger(c);
  if (before.text !== 'Claude Fable 5.1 High') throw new Error('Requires already-pinned Fable High');
  report.before = before.text;
  const opened = await b._openModelPicker(c);
  const located = await b._findModelPickerModel(c, opened, 'Auto');
  const auto = selectModelPickerRow(located.snapshot.rows, 'Auto', 'model');
  if (!auto) throw new Error('Auto row unavailable');
  await b._clickModelPickerPoint(c, auto);
  await new Promise(resolve => setTimeout(resolve, 550));
  report.transient = (await b._readModelPickerTrigger(c)).text;
  if (report.transient !== 'Auto') throw new Error('Auto selection was not confirmed');
  try { report.selection = await b._applyModelPreference(c, preference, { sendState: 'not_sent' }); }
  catch (error) { report.error = error.message; report.diagnostic = error.modelSelection; }
} finally {
  try {
    report.after = (await b._readModelPickerTrigger(c)).text;
    if (report.before && report.after !== report.before) {
      try { report.restoration = await b._applyModelPreference(c, preference, { sendState: 'not_sent' }); }
      catch (error) { report.restorationError = error.message; }
      report.after = (await b._readModelPickerTrigger(c)).text;
    }
    await b._closeModelPicker(c);
    report.menuClosed = !(await read(c)).open;
  } finally { c.close(); }
}
console.log(JSON.stringify({ ...report, trace }));
if (report.error || report.selection?.applied !== true || report.before !== report.after || !report.menuClosed) process.exitCode = 1;
