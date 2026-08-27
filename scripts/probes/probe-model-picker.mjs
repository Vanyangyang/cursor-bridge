#!/usr/bin/env node
import http from 'node:http';
import { WebSocket } from 'ws';
import { EXPR_MODEL_PICKER_ROWS, EXPR_MODEL_PICKER_TRIGGER } from '../../server.mjs';

const PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${PORT}`;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('CDP returned non-JSON data')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('CDP timeout')));
  });
}

function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl, { origin: ORIGIN });
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}) => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
  };
  return { ready, send, close: () => ws.close() };
}

async function evalJson(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    includeCommandLineAPI: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'page evaluation failed');
  return JSON.parse(response.result && response.result.value || '{}');
}

async function click(client, point) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
}

async function main() {
  const targets = await httpJson('/json/list');
  const page = targets.find((target) => target.type === 'page' && /Cursor Agents/i.test(target.title || ''));
  if (!page) throw new Error('Cursor Agents page target was not found');
  const client = makeClient(page.webSocketDebuggerUrl);
  await client.ready;
  try {
    const trigger = await evalJson(client, EXPR_MODEL_PICKER_TRIGGER);
    const triggerDiagnostics = await evalJson(client, `(function(){
      const trigger=[...document.querySelectorAll('.ui-model-picker__trigger,.vscode-model-picker__trigger')].filter(node=>node.offsetParent!==null).pop();
      if(!trigger)return JSON.stringify({found:false});
      const chain=[];
      let node=trigger;
      for(let depth=0;node&&depth<4;depth++,node=node.parentElement){
        const reactKey=Object.keys(node).find(key=>key.startsWith('__reactProps$'));
        const props=reactKey?node[reactKey]:null;
        chain.push({
          depth,
          tag:node.tagName,
          className:String(node.className||'').slice(0,500),
          attributes:Object.fromEntries([...node.attributes].map(attribute=>[attribute.name,attribute.value])),
          reactPropKeys:props?Object.keys(props):[],
          handlers:props?Object.keys(props).filter(key=>/^on[A-Z]/.test(key)&&typeof props[key]==='function'):[],
          handlerSources:props?Object.fromEntries(Object.keys(props)
            .filter(key=>['onClick','onMouseDown','onPointerDown'].includes(key)&&typeof props[key]==='function')
            .map(key=>[key,String(props[key]).slice(0,600)])):null,
        });
      }
      return JSON.stringify({found:true,chain});
    })()`);
    if (!trigger.found) {
      const diagnostics = await evalJson(client, `(function(){
        const visible=(node)=>!!(node&&(node.offsetParent!==null||(node.getClientRects&&node.getClientRects().length>0)));
        const input=[...document.querySelectorAll('.ui-prompt-input-editor__input,[contenteditable="true"]')].filter(visible).pop();
        let scope=input;
        for(let i=0;scope&&i<8;i++,scope=scope.parentElement){
          const buttons=[...scope.querySelectorAll('button,[role="button"]')].filter(visible);
          if(buttons.length>=2)return JSON.stringify({
            inputClass:String(input&&input.className||''),
            scopeClass:String(scope.className||''),
            buttons:buttons.map(button=>({
              text:String(button.innerText||'').replace(/\\s+/g,' ').trim(),
              aria:button.getAttribute('aria-label'),
              title:button.getAttribute('title'),
              className:String(button.className||''),
              testId:button.getAttribute('data-testid'),
            })).slice(0,30),
          });
        }
        return JSON.stringify({inputClass:String(input&&input.className||''),scopeClass:null,buttons:[]});
      })()`);
      console.log(JSON.stringify({ target: page.title, trigger, diagnostics }, null, 2));
      throw new Error(`model picker trigger unavailable: ${trigger.state}`);
    }
    let snapshot = await evalJson(client, EXPR_MODEL_PICKER_ROWS);
    if (!snapshot.open) {
      await click(client, trigger);
      await new Promise((resolve) => setTimeout(resolve, 500));
      snapshot = await evalJson(client, EXPR_MODEL_PICKER_ROWS);
    }
    const menuDiagnostics = await evalJson(client, `(function(){
      const visible=(node)=>!!(node&&(node.offsetParent!==null||(node.getClientRects&&node.getClientRects().length>0)));
      const nodes=[...document.querySelectorAll('[role="menu"],[role="menuitem"],[role="listbox"],[role="option"],[data-component="menu-popup"],[data-component="menu-row"],[class*="model-picker"],[class*="model-selector"]')].filter(visible);
      return JSON.stringify(nodes.slice(0,30).map(node=>({
        tag:node.tagName,
        role:node.getAttribute('role'),
        component:node.getAttribute('data-component'),
        testId:node.getAttribute('data-testid'),
        className:String(node.className||'').slice(0,300),
        text:String(node.innerText||'').replace(/\\s+/g,' ').trim().slice(0,500),
      })));
    })()`);
    const submenuSnapshots = {};
    for (const [name, kind] of [['model', 'model_control'], ['effort', 'effort_control']]) {
      const control = (snapshot.rows || []).find((row) => row.kind === kind);
      if (!control) continue;
      await click(client, control);
      await new Promise((resolve) => setTimeout(resolve, 450));
      const submenu = await evalJson(client, EXPR_MODEL_PICKER_ROWS);
      submenuSnapshots[name] = (submenu.rows || []).map(({ text, kind: rowKind, selected, disabled, hasSubmenu, submenu: nested }) => ({
        text, kind: rowKind, selected, disabled, hasSubmenu, submenu: nested,
      }));
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      snapshot = await evalJson(client, EXPR_MODEL_PICKER_ROWS);
    }
    console.log(JSON.stringify({
      target: page.title,
      trigger: { text: trigger.text, detail: trigger.detail },
      triggerDiagnostics,
      open: snapshot.open === true,
      menuDiagnostics,
      submenuSnapshots,
      rows: (snapshot.rows || []).map(({ text, kind, selected, disabled, hasSubmenu, submenu }) => ({
        text, kind, selected, disabled, hasSubmenu, submenu,
      })),
    }, null, 2));
    if (snapshot.open) {
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`PROBE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
