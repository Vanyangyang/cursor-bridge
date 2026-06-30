#!/usr/bin/env node
/** probe-cursor-chat.mjs — 打开 Cursor AI chat/agent 面板，广谱 dump 结构（输入/发送钮/回复区/停止钮），为建 cursor-console 注入器铺路。
 *  用法：node probe-cursor-chat.mjs [openKey] [port]  openKey: L(Ctrl+L,默认) / I(Ctrl+I) / none ; port 默认 9223 */
import http from 'http';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const __dir = dirname(fileURLToPath(import.meta.url));
const OPENKEY = (process.argv[2] || 'L').toUpperCase();
const PORT = Number(process.argv[3] || 9223);
const ORIGIN = `http://localhost:${PORT}`;
function httpJson(path){return new Promise((res,rej)=>{const r=http.get({host:'localhost',port:PORT,path},(s)=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{res(JSON.parse(d));}catch{rej(new Error('非JSON'));}});});r.on('error',rej);r.setTimeout(4000,()=>r.destroy(new Error('无响应')));});}
async function findPage(){const l=await httpJson('/json/list');const p=l.filter(t=>t.type==='page'&&t.webSocketDebuggerUrl);return p.find(t=>/workbench/i.test(t.url||''))||p[0];}
function makeClient(wsUrl){const ws=new WebSocket(wsUrl,{origin:ORIGIN});let id=0;const pending=new Map();const ready=new Promise((res,rej)=>{ws.on('open',res);ws.on('error',rej);});ws.on('message',(data)=>{let m;try{m=JSON.parse(data.toString());}catch{return;}if(m.id&&pending.has(m.id)){const{res,rej}=pending.get(m.id);pending.delete(m.id);if(m.error)rej(new Error(JSON.stringify(m.error)));else res(m.result);}});const send=(method,params={})=>{const myId=++id;return new Promise((res,rej)=>{pending.set(myId,{res,rej});ws.send(JSON.stringify({id:myId,method,params}));});};return{ready,send,close:()=>{try{ws.close();}catch{}}};}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function evalJS(c,expr){const r=await c.send('Runtime.evaluate',{expression:expr,returnByValue:true,includeCommandLineAPI:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result&&r.result.value;}
async function chord(c,modifiers,key,code,vk){await c.send('Input.dispatchKeyEvent',{type:'keyDown',modifiers,key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});await c.send('Input.dispatchKeyEvent',{type:'keyUp',modifiers,key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});}

const DUMP = `(function(){
  const vis=(e)=>e.offsetParent!==null;
  const cls=(e)=>(typeof e.className==='string'?e.className:'').slice(0,90);
  // 输入候选
  const editables=[...document.querySelectorAll('[contenteditable="true"],textarea,input[type="text"]')].filter(vis).map(e=>({
    tag:e.tagName, role:e.getAttribute('role'), lexical:e.getAttribute('data-lexical-editor'),
    ph:(e.getAttribute('placeholder')||e.getAttribute('aria-label')||e.getAttribute('data-placeholder')||'').slice(0,50),
    focused:e===document.activeElement, cls:cls(e)
  }));
  // 按钮候选（可见，带 aria/svg/text）
  const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(vis).map(e=>{
    const svg=e.querySelector('svg'); const svgcls=svg?(typeof svg.className==='object'?(svg.className.baseVal||''):(svg.className||'')):'';
    return {aria:e.getAttribute('aria-label')||'', title:e.getAttribute('title')||'', text:(e.innerText||'').trim().slice(0,24), dis:!!e.disabled, svg:svgcls.slice(0,40), cls:cls(e)};
  }).filter(b=>b.aria||b.title||b.text||b.svg).slice(0,40);
  // 回复/消息容器候选：class 含关键词
  const kw=/markdown|message|conversation|prose|aichat|composer|chat|bubble|response|turn|assistant/i;
  const containers=[...document.querySelectorAll('div,section,ul,article')].filter(e=>vis(e)&&kw.test(typeof e.className==='string'?e.className:'')).map(e=>({
    tag:e.tagName, cls:cls(e), textLen:(e.innerText||'').length
  })).slice(0,30);
  return JSON.stringify({editables, buttons, containers});
})()`;

(async()=>{
  const page=await findPage();
  console.log('[chat] page=' + (page.title||'').slice(0,40));
  const c=makeClient(page.webSocketDebuggerUrl); await c.ready;
  await chord(c,0,'Escape','Escape',27); await sleep(200);
  if(OPENKEY==='L'){ await chord(c,2,'L','KeyL',76); }
  else if(OPENKEY==='I'){ await chord(c,2,'I','KeyI',73); }
  console.log('[chat] openKey=' + OPENKEY + ' (Ctrl+' + OPENKEY + ')');
  await sleep(1400);
  const r=JSON.parse(await evalJS(c,DUMP));
  c.close();
  const cacheDir=join(__dir,'..','..','cache'); try{mkdirSync(cacheDir,{recursive:true});}catch{}
  writeFileSync(join(cacheDir,'cursor_chat_dump.json'),JSON.stringify(r,null,2),'utf8');
  console.log('\n=== 输入候选 (' + r.editables.length + ') ===');
  for(const e of r.editables) console.log('  ['+e.tag+'] ph="'+e.ph+'" focused='+e.focused+' lexical='+e.lexical+' cls='+e.cls.slice(0,60));
  console.log('\n=== 按钮候选 (' + r.buttons.length + ') ===');
  for(const b of r.buttons) console.log('  aria="'+b.aria+'" title="'+b.title+'" text="'+b.text+'" dis='+b.dis+' svg='+b.svg+' cls='+b.cls.slice(0,55));
  console.log('\n=== 回复/消息容器候选 (' + r.containers.length + ') ===');
  for(const x of r.containers) console.log('  ['+x.tag+'] textLen='+x.textLen+' cls='+x.cls);
  console.log('\n[chat] 全量: .claude/cache/cursor_chat_dump.json');
})().catch(e=>{console.error('FAIL: '+e.message);process.exit(1);});
