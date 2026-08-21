#!/usr/bin/env node
import http from 'node:http';
import { WebSocket } from 'ws';

const port = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const getJson = (path) => new Promise((resolve, reject) => {
  const request = http.get({ host: '127.0.0.1', port, path }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
  });
  request.on('error', reject);
});

const pages = (await getJson('/json/list')).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
if (!pages.length) throw new Error('No Cursor page target');
const page = pages[0];
const socket = new WebSocket(page.webSocketDebuggerUrl, { origin: `http://localhost:${port}` });
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

const expression = `(function(){
  const visible=e=>e&&e.offsetParent!==null;
  const markdownNodes=[...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')]
    .filter(visible);
  const markdown=markdownNodes.map(e=>(e.innerText||'').trim()).filter(Boolean);
  const markdownDetails=markdownNodes.map(e=>({
    text:(e.innerText||'').trim().slice(0,1000),className:String(e.className||''),
    parentClass:String(e.parentElement&&e.parentElement.className||''),
    grandparentClass:String(e.parentElement&&e.parentElement.parentElement&&e.parentElement.parentElement.className||''),
    inModelPicker:!!e.closest('.ui-model-picker__trigger,[class*=model-picker]'),
    inComposer:!!e.closest('.composer-bar[data-composer-id]')
  }));
  const stop=[...document.querySelectorAll('[class*=codicon-stop],[class*=debug-stop],[aria-label*=Stop],[aria-label*=stop],[aria-label*=Cancel],[title*=Stop]')].filter(visible);
  const composers=[...document.querySelectorAll('.composer-bar[data-composer-id]')]
    .map(e=>({id:e.dataset.composerId,status:e.dataset.composerStatus,visible:visible(e)}));
  const trays=[...document.querySelectorAll('.ui-tray.ui-notification-tray[data-visible="true"]')]
    .map(e=>(e.innerText||'').trim().slice(0,500));
  const inputs=[...document.querySelectorAll('[contenteditable="true"].ui-prompt-input-editor__input,.tiptap.ProseMirror[contenteditable="true"],.aislash-editor-input')]
    .map(e=>({visible:visible(e),text:(e.innerText||'').slice(0,120)}));
  return JSON.stringify({
    title:document.title,visibility:document.visibilityState,
    focused:typeof document.hasFocus==='function'&&document.hasFocus(),
    markdownCount:markdown.length,lastMarkdown:markdown[markdown.length-1]||'',markdownDetails,
    stopCount:stop.length,composers,trays,inputs
  });
})()`;

socket.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression, returnByValue: true },
}));
const message = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate timeout')), 10000);
  socket.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
    if (parsed.id !== 1) return;
    clearTimeout(timer);
    resolve(parsed);
  });
});
socket.close();
console.log(message.result.result.value);
