#!/usr/bin/env node
/** probe-cursor-send.mjs — 端到端：确保chat开→填只读检索查询→Enter发送→采样40s观察回复区+生成/完成信号。
 *  一次拿全建 cursor-console 需要的信息：发送方式/回复容器/完成信号。用法：node scripts/probes/probe-cursor-send.mjs [port] 默认9223 */
import http from 'http';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const __dir = dirname(fileURLToPath(import.meta.url));
const artifactDir = join(__dir, '..', '..', '.artifacts');
const PORT = Number(process.argv[2] || 9223);
const ORIGIN = `http://localhost:${PORT}`;
function httpJson(path){return new Promise((res,rej)=>{const r=http.get({host:'localhost',port:PORT,path},(s)=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{res(JSON.parse(d));}catch{rej(new Error('非JSON'));}});});r.on('error',rej);r.setTimeout(4000,()=>r.destroy(new Error('无响应')));});}
async function findPage(){const l=await httpJson('/json/list');const p=l.filter(t=>t.type==='page'&&t.webSocketDebuggerUrl);return p.find(t=>/workbench/i.test(t.url||''))||p[0];}
function makeClient(wsUrl){const ws=new WebSocket(wsUrl,{origin:ORIGIN});let id=0;const pending=new Map();const ready=new Promise((res,rej)=>{ws.on('open',res);ws.on('error',rej);});ws.on('message',(data)=>{let m;try{m=JSON.parse(data.toString());}catch{return;}if(m.id&&pending.has(m.id)){const{res,rej}=pending.get(m.id);pending.delete(m.id);if(m.error)rej(new Error(JSON.stringify(m.error)));else res(m.result);}});const send=(method,params={})=>{const myId=++id;return new Promise((res,rej)=>{pending.set(myId,{res,rej});ws.send(JSON.stringify({id:myId,method,params}));});};return{ready,send,close:()=>{try{ws.close();}catch{}}};}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function evalJS(c,expr){const r=await c.send('Runtime.evaluate',{expression:expr,returnByValue:true,includeCommandLineAPI:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result&&r.result.value;}
async function chord(c,modifiers,key,code,vk){await c.send('Input.dispatchKeyEvent',{type:'keyDown',modifiers,key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});await c.send('Input.dispatchKeyEvent',{type:'keyUp',modifiers,key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});}
const VISIBLE=`(function(){const i=document.querySelector('.aislash-editor-input');return !!(i&&i.offsetParent!==null);})()`;
const FILL=`(function(){const inp=document.querySelector('.aislash-editor-input');if(!inp||inp.offsetParent===null)return 'NO_INPUT';inp.focus();try{const s=getSelection();const r=document.createRange();r.selectNodeContents(inp);s.removeAllRanges();s.addRange(r);}catch(e){}document.execCommand('insertText',false,'只做检索：列出与 pet capture 灵宠捕获相关的文件路径和行号，不要读取文件正文、不要修改代码');inp.dispatchEvent(new Event('input',{bubbles:true}));return (inp.innerText||'').slice(0,30);})()`;
const SNAP=`(function(){
  const pane=document.querySelector('.aichat-pane,.aichat-container')||document.body;
  const txt=(pane.innerText||'');
  const md=[...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')];let mdMax=0;for(const m of md){const t=(m.innerText||'').length;if(t>mdMax)mdMax=t;}
  // stop/生成中信号：codicon-stop / debug-stop / aria含stop|cancel / loading
  const stop=[...document.querySelectorAll('[class*=codicon-stop],[class*=debug-stop],[aria-label*=Stop],[aria-label*=stop],[aria-label*=Cancel],[title*=Stop]')].filter(e=>e.offsetParent!==null).length;
  const loading=[...document.querySelectorAll('[class*=loading],[class*=spin],[class*=progress],[class*=generating]')].filter(e=>e.offsetParent!==null).length;
  return JSON.stringify({paneLen:txt.length, mdMax, stop, loading});
})()`;

(async()=>{
  const page=await findPage();
  const c=makeClient(page.webSocketDebuggerUrl); await c.ready;
  let vis=await evalJS(c,VISIBLE);
  if(!vis){ await chord(c,2,'L','KeyL',76); await sleep(1200); vis=await evalJS(c,VISIBLE); }
  if(!vis){ console.log('chat 未开，退出'); c.close(); return; }
  const f=await evalJS(c,FILL); console.log('[send] 填入="'+f+'"');
  await sleep(500);
  const before=JSON.parse(await evalJS(c,SNAP)); console.log('[send] 发送前 '+JSON.stringify(before));
  // Enter 发送
  await chord(c,0,'Enter','Enter',13);
  console.log('[send] 已按 Enter，采样 40s...');
  console.log('  t(s) | paneLen | mdMax | stop | load');
  const start=Date.now(); const samples=[];
  while(Date.now()-start<40000){
    await sleep(1500);
    let s; try{ s=JSON.parse(await evalJS(c,SNAP)); }catch(e){ s={err:1}; }
    const t=Math.round((Date.now()-start)/100)/10; samples.push({t,...s});
    console.log('  '+String(t).padStart(5)+' | '+String(s.paneLen).padStart(7)+' | '+String(s.mdMax).padStart(5)+' | '+String(s.stop).padStart(4)+' | '+String(s.loading).padStart(4));
  }
  try{mkdirSync(artifactDir,{recursive:true});}catch{}
  writeFileSync(join(artifactDir,'cursor_send_timeline.json'),JSON.stringify(samples,null,2),'utf8');
  c.close();
  console.log('[send] 时间线: .artifacts/cursor_send_timeline.json');
})().catch(e=>{console.error('FAIL: '+e.message);process.exit(1);});
