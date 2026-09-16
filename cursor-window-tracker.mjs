import { WebSocket } from 'ws';
import { recordCursorClosedWindow } from './cursor-startup-window.mjs';

function windowFlavor(info) {
  if (info?.type !== 'page' || !String(info.url).startsWith('vscode-file://')) return null;
  const title = String(info.title || '').trim();
  if (/^Cursor Agents(?: -|$)/i.test(title)) return 'agents_v2';
  if (title === 'Cursor' || title.endsWith(' - Cursor')) return 'legacy';
  return null;
}

export function createWindowCloseObserver(record) {
  const pages = new Map();
  let lastClosed = null;
  return {
    update(info) {
      if (info?.type !== 'page' || !String(info.url).startsWith('vscode-file://')) return;
      pages.set(info.targetId, { ...info, flavor: windowFlavor(info) });
      lastClosed = null;
    },
    destroyed(id) {
      const closed = pages.get(id);
      pages.delete(id);
      if (closed?.flavor && pages.size === 0) { lastClosed = closed.flavor; record(lastClosed); }
    },
    disconnected() {
      // Some Electron exits close browser CDP before emitting targetDestroyed.
      // With multiple remaining windows, do not guess their closing order.
      if (!lastClosed && pages.size === 1) {
        const flavor = [...pages.values()][0].flavor;
        if (flavor) { lastClosed = flavor; record(flavor); }
      }
    },
  };
}

export async function startCursorWindowTracker({ port, onDisconnect = () => {}, log = () => {}, record = recordCursorClosedWindow } = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) })).json();
  const url = new URL(version.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== Number(port)) throw new Error('Unexpected Cursor browser CDP endpoint');
  const observer = createWindowCloseObserver(flavor => {
    try { record(flavor); } catch (error) { log(`window-state-save-failed: ${error.message}`); }
  });
  const ws = new WebSocket(url.href, { origin: `http://localhost:${port}`, handshakeTimeout: 3000 });
  let stopping = false;
  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') observer.update(message.params.targetInfo);
      if (message.method === 'Target.targetDestroyed') observer.destroyed(message.params.targetId);
    } catch (error) { log(`window-observer-event-failed: ${error.message}`); }
  });
  ws.on('error', error => log(`window-observer-disconnected: ${error.message}`));
  ws.on('close', async () => {
    if (!stopping) {
      try { await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }); }
      catch { observer.disconnected(); }
    }
    onDisconnect();
  });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Window observer connection timed out')); }, 3500);
    ws.once('error', error => { clearTimeout(timer); reject(error); });
    const acknowledge = raw => {
      let reply;
      try { reply = JSON.parse(raw.toString()); } catch { return; }
      if (reply.id !== 1) return;
      ws.off('message', acknowledge);
      clearTimeout(timer);
      if (reply.error) { ws.terminate(); reject(new Error(reply.error.message)); }
      else resolveReady();
    };
    ws.on('message', acknowledge);
    ws.once('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
    });
  });
  return { get active() { return ws.readyState === WebSocket.OPEN; }, close() { stopping = true; ws.close(); } };
}
