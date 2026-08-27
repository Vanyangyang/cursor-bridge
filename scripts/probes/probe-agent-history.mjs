#!/usr/bin/env node
import http from 'node:http';
import { WebSocket } from 'ws';
import { EXPR_HISTORY_ENTRIES } from '../../server.mjs';

const args = process.argv.slice(2);
const inspectShape = args.includes('--shape');
const inspectSelected = args.includes('--selected');
const inspectFullSelected = args.includes('--full');
const requestedIds = args.filter((value) => !value.startsWith('--')).map((value) => value.replace(/^local:/, ''));
const SHAPE_EXPRESSION = `(function(){
  const requested=${JSON.stringify(requestedIds)};
  const read=value=>value&&typeof value==='object'&&'value' in value?value.value:value;
  const results=[];const seen=new Set();
  const summarizeArray=(value)=>({
    length:value.length,
    firstKeys:value[0]&&typeof value[0]==='object'?Object.keys(value[0]).slice(0,30):[],
    firstId:String(read(value[0]&&value[0].id)||''),
    lastId:String(read(value[value.length-1]&&value[value.length-1].id)||''),
  });
  for(const root of document.querySelectorAll('.glass-sidebar-agent-list-container')){
    const nodes=[];let node=root;
    for(let i=0;node&&i<24;i++,node=node.parentElement)nodes.push(node);
    for(const current of nodes){
      for(const key of Object.keys(current)){
        if(!key.startsWith('__reactFiber$')&&!key.startsWith('__reactProps$'))continue;
        const seed=current[key];
        let fiber=key.startsWith('__reactFiber$')?seed:{memoizedProps:seed,return:null};
        for(let depth=0;fiber&&depth<100;depth++,fiber=fiber.return){
          for(const props of [fiber.memoizedProps,fiber.pendingProps,fiber.stateNode&&fiber.stateNode.props]){
            if(!props||typeof props!=='object'||seen.has(props))continue;
            const keys=Object.keys(props);
            const section=props.section&&typeof props.section==='object'?props.section:null;
            if(!section&&!keys.some(name=>/agent|header|row|selected/i.test(name)))continue;
            seen.add(props);
            const arrays={};
            for(const [name,value] of Object.entries(props))if(Array.isArray(value))arrays['props.'+name]=summarizeArray(value);
            if(section)for(const [name,value] of Object.entries(section))if(Array.isArray(value))arrays['section.'+name]=summarizeArray(value);
            const presentations={};
            if(typeof props.getAgentPresentation==='function')for(const id of requested){
              try{
                const value=props.getAgentPresentation(id);
                presentations[id]=value&&typeof value==='object'
                  ?Object.fromEntries(Object.entries(value).slice(0,80).map(([name,item])=>[name,typeof read(item)==='object'?String(read(item)):read(item)]))
                  :read(value);
              }catch(error){presentations[id]={error:String(error&&error.message||error)}}
            }
            const sectionMap={};
            if(props.sectionIdByAgentId)for(const id of requested){
              try{sectionMap[id]=props.sectionIdByAgentId instanceof Map?props.sectionIdByAgentId.get(id):read(props.sectionIdByAgentId[id]);}catch{}
            }
            results.push({
              depth,
              propsKeys:keys.slice(0,80),
              sectionKeys:section?Object.keys(section).slice(0,80):[],
              sectionId:String(read(section&&section.id)||''),
              selectedAgentId:String(read(props.selectedAgentId)||''),
              committedSelectedAgentId:String(read(props.committedSelectedAgentId)||''),
              arrays,
              presentations,
              sectionMap,
              onSelectAgentSource:typeof props.onSelectAgent==='function'?String(props.onSelectAgent).slice(0,1200):null,
              rowSelectSource:props.rowHandlers&&typeof props.rowHandlers.onSelect==='function'?String(props.rowHandlers.onSelect).slice(0,1200):null,
            });
          }
        }
      }
    }
  }
  const filtered=requested.length?results.filter(result=>Object.keys(result.sectionMap||{}).length||result.onSelectAgentSource||result.rowSelectSource):results;
  return JSON.stringify({count:filtered.length,results:filtered.slice(0,200)});
})()`;
const SELECTED_EXPRESSION = `(function(){
  const full=${inspectFullSelected ? 'true' : 'false'};
  const visible=node=>!!(node&&(node.offsetParent!==null||(node.getClientRects&&node.getClientRects().length>0)));
  const composers=[...document.querySelectorAll('.composer-bar[data-composer-id]')];
  const selected=composers.find(visible)||composers[composers.length-1]||null;
  const input=[...document.querySelectorAll('.ui-prompt-input-editor__input,[contenteditable="true"]')].filter(visible).pop();
  const markdown=[...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')].filter(visible);
  const stops=[...document.querySelectorAll('[aria-label="Stop generation"],[data-state="stop"],.codicon-stop,.codicon-debug-stop')].filter(visible);
  const substantial=markdown.map(node=>String(node.innerText||'')).filter(text=>text.length>200);
  if(full)return JSON.stringify({
    visibleComposerId:String(selected&&selected.dataset&&selected.dataset.composerId||''),
    visibleComposerStatus:String(selected&&selected.dataset&&selected.dataset.composerStatus||''),
    stopCount:stops.length,
    assistantText:String(substantial[substantial.length-1]||'').slice(0,50000),
  });
  return JSON.stringify({
    composerCount:composers.length,
    visibleComposerId:String(selected&&selected.dataset&&selected.dataset.composerId||''),
    visibleComposerStatus:String(selected&&selected.dataset&&selected.dataset.composerStatus||''),
    inputText:String(input&&input.innerText||'').slice(0,1000),
    markdownCount:markdown.length,
    markdown:markdown.map(node=>({className:String(node.className||'').slice(0,300),text:String(node.innerText||'').slice(0,1000)})),
    lastMarkdown:String(markdown[markdown.length-1]&&markdown[markdown.length-1].innerText||'').slice(0,3000),
    stopCount:stops.length,
  });
})()`;

const port = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const origin = `http://localhost:${port}`;
const targets = await new Promise((resolve, reject) => {
  const request = http.get({ host: '127.0.0.1', port, path: '/json/list' }, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
    });
  });
  request.on('error', reject);
});
const page = targets.find((target) => target.type === 'page' && /Cursor Agents/i.test(target.title || ''));
if (!page) throw new Error('Cursor Agents page target was not found');
const socket = new WebSocket(page.webSocketDebuggerUrl, { origin });
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Runtime.evaluate timed out')), 15000);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: inspectSelected ? SELECTED_EXPRESSION : inspectShape ? SHAPE_EXPRESSION : EXPR_HISTORY_ENTRIES, returnByValue: true, includeCommandLineAPI: true },
  }));
});
socket.close();
if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'History expression failed');
const parsed = JSON.parse(result.result && result.result.value || '{}');
if (!inspectShape && !inspectSelected && requestedIds.length && Array.isArray(parsed.entries)) {
  const requested = new Set(requestedIds);
  parsed.entries = parsed.entries.filter((entry) => requested.has(String(entry?.id || '').replace(/^local:/, '')));
  parsed.requestedIds = requestedIds;
}
console.log(JSON.stringify(parsed, null, 2));
