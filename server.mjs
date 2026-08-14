#!/usr/bin/env node
/**
 * cursor-bridge — MCP server（CDP 直驱架构）
 *
 * 让 Codex 调 Cursor IDE 里的 agent 做语义检索与边界明确的委托执行。
 * Cursor 的语义搜索【没有纯检索接口/独立 UI】（2026-06-08 CDP 实测：
 *   window.vscode 是 sandbox preload 无 command API；Ctrl+Shift+F 是普通全文搜索），
 *   只能跑 agent 拿（用户拍板 B1）。故走 @Codebase/agent chat：填查询 → Enter → 等完成 → 抓回复。
 *
 * 架构（CDP 直驱，无需 console+WS 回连）：
 *   Claude Code --(MCP stdio)--> 本 server --(CDP 9223 Runtime.evaluate + Input)--> Cursor 渲染进程
 *   GUI 操作通过互斥锁串行；独立顶层 Cursor Agent 在提交后可并行运行，再按 agentId 逐项取回。
 *
 * 实测确认的链路（2026-06-08，见 .claude/scripts/cursor-bridge/probe-*.mjs）：
 *   - 输入框 `.aislash-editor-input`（lexical contenteditable）；Ctrl+L 开/关 chat（toggle）。
 *   - 填字 execCommand insertText + input 事件；先发真实 Enter，若未被接受则精确点击当前 composer 的 Send。
 *   - 回复渲染在 `.markdown-root`；完成信号 = 停止钮（codicon-stop 等）从 >0 → 0（生成中 stop=2~3）。
 *
 * 注意：Cursor 是 agent（比 fast-context 更主动），CCE prompt 强约束只读与可核验证据，
 *   但非技术隔离，理论上 agent 仍有写能力，别当沙箱。前提：Cursor 带 --remote-debugging-port=9223 在跑。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { basename, dirname, join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import http from 'http';
import { pathToFileURL } from 'url';
import {
  CURSOR_RUNTIME_MODES,
  cursorStartupBehavior,
  normalizeCursorRuntimeMode,
  readPersistedCursorRuntimeMode,
  resolveCursorRuntimeFile,
  setCursorWindowPresentation,
  shouldAutoLaunchCursor,
  writePersistedCursorRuntimeMode,
} from './cursor-runtime.mjs';
import {
  readWorkspaceBinding,
  resolveWorkspaceBindingFile,
  resolveWorkspaceBindingKey,
  writeWorkspaceBinding,
} from './workspace-binding.mjs';

const CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${CDP_PORT}`;
const QUERY_TIMEOUT = Number(process.env.CURSOR_BRIDGE_TIMEOUT || 300000);

function normalizeDelegationMode(value = process.env.CURSOR_BRIDGE_DELEGATION) {
  return String(value || 'on').trim().toLowerCase() === 'off' ? 'off' : 'on';
}

const DELEGATION_MODE = normalizeDelegationMode();

// Cursor Context Engine (CCE) search contracts: use Cursor's indexed/code-navigation
// context, but return compact evidence anchors that the primary agent can verify.
function searchResultContract() {
  return [
    '只返回支撑结论所需的最小充分证据集，按证据强度排序；不要为了凑数量堆砌相似结果。',
    '',
    '输出格式（保持紧凑，不要追加长篇解释）：',
    'CCE_SEARCH_RESULT',
    'intent: <一句话复述检索意图>',
    'coverage: <focused|extended> | <为什么采用该检索力度；是否扩展过优先范围>',
    'evidence:',
    '- <workspace-relative-path>:<start>-<end> | <symbol 或锚点> | <相关性或已核验关系> | <semantic|exact|reference|source-read>',
    'gaps: <没有确认的部分；没有则写 none>',
    'confidence: <high|medium|low>（只评价定位证据，不评价代码正确性）',
  ];
}

function buildContextEnginePrompt(query) {
  return [
    '你现在是 Cursor Context Engine（CCE）：一个只读、证据驱动的项目理解引擎。',
    '目标是把自然语言意图解析成可核验的真实代码上下文，而不是猜测代码位置、复述框架惯例或生成实现方案。',
    '必须先检索再回答。根据问题形状和检索中发现的关系，自主决定检索力度：简单定位快速收敛；调用链、数据流、注册关系或跨模块问题继续追踪到最小充分证据。',
    '自行选择 Cursor 当前可用的最佳能力，包括项目索引语义检索、精确文本搜索、符号/引用追踪、定向源码读取，以及确有收益时的 Explore/子代理。调用方只约束只读、证据和停止条件，不替 Cursor 编排内部 harness。',
    '每条关系都必须由实际搜索、引用或源码读取支撑；语义相似不能冒充已证明调用边。达到最小充分上下文后立即停止，不做无关全仓库漫游。',
    '不得修改、创建或删除文件，不得执行改变工作区状态的命令。只读取足以确认定位的上下文。',
    '没有证据时明确写 NOT_FOUND，并在 gaps 中列出实际搜索过的词、符号、引用或范围；不得跳过搜索直接回答。',
    '检索范围是当前 Cursor 已打开并完成索引的整个工作区。若意图点名了模块或路径，把它视为线索而非硬边界。',
    ...searchResultContract(),
    '',
    `检索意图：${String(query || '').trim()}`,
  ].join('\n');
}

function normalizeCceSearchResult(value) {
  const text = String(value || '').trim();
  const marker = text.indexOf('CCE_SEARCH_RESULT');
  if (marker < 0) return text;
  return text.slice(marker)
    .replace(/^CCE_SEARCH_RESULT\s+(?=intent:)/, 'CCE_SEARCH_RESULT\n')
    .replace(/[^\S\r\n]+(?=(?:coverage|evidence|gaps|confidence):)/g, '\n');
}

function isConfirmedCompletedReply({ answer, snapshot = {}, sawStop = false, baselineCount = 0 } = {}) {
  if (!String(answer || '').trim()) return false;
  if (!snapshot || typeof snapshot !== 'object') return false;
  const stopCount = Number(snapshot.stop);
  if (!Number.isFinite(stopCount) || stopCount > 0) return false;
  const hasAssistantEvidence = Number(snapshot.replyLength || 0) > 0
    || Number(snapshot.messageCount || 0) >= Number(baselineCount || 0) + 2;
  const hasCompletionEvidence = sawStop
    || Number(snapshot.messageCount || 0) >= Number(baselineCount || 0) + 2;
  return hasAssistantEvidence && hasCompletionEvidence;
}

const DO_DEFAULT_CONTRACT =
  '\n\n完成要求：在当前 Cursor 已打开的工作区内直接完成任务；不要推送远端。' +
  '结束前检查实际改动并运行与风险匹配的验证。最终回复必须列出：完成内容、改动文件、验证结果、仍有风险或阻塞。';

// ---------- CDP helpers ----------
// 连接目标用字面 IP '127.0.0.1'，不用 'localhost'：Windows 上 "localhost" DNS 常优先解析到 ::1，
// 但 Chromium --remote-debugging-port 只监听 IPv4 127.0.0.1（非双栈），会导致 ECONNREFUSED（2026-07 实测）。
// ORIGIN 仍用 localhost 字符串——它只是 WS 握手 Origin 头，需跟 launch-cursor.mjs 的 --remote-allow-origins 保持一致，与连接目标无关。
const CDP_HOST = '127.0.0.1';
function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('CDP 非 JSON 响应')); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error(`Cursor 调试口 ${CDP_PORT} 无响应——Cursor 是否带 --remote-debugging-port=${CDP_PORT} 启动？`)));
  });
}
function scoreCursorPageCandidate(candidate, purpose = 'fifo') {
  const capability = candidate && (candidate.capabilities || candidate);
  if (!capability) return Number.NEGATIVE_INFINITY;
  let score = capability.hasWritableInput ? 1000 : -1000;
  if (purpose === 'parallel_agent') {
    if (capability.agentAdapterKind === 'agents_v2') score += 600;
    else if (capability.agentAdapterKind === 'legacy') score += 350;
    else score -= 500;
  }
  if (capability.uiFlavor === 'agents_v2') score += 180;
  else if (capability.uiFlavor === 'legacy') score += 90;
  if (capability.hasComposer) score += 60;
  if (capability.visible) score += 35;
  if (capability.focused) score += 20;
  if (/workbench/i.test(String(candidate && candidate.url || ''))) score += 15;
  return score;
}

function selectCursorPageCandidate(candidates, options = {}) {
  const pages = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (options.targetId) {
    const exact = pages.find((page) => page.id === options.targetId);
    if (!exact) throw new Error(`Cursor CDP target 已消失：${options.targetId}`);
    return exact;
  }
  const purpose = options.purpose || 'fifo';
  return pages
    .map((page, index) => ({ page, index, score: scoreCursorPageCandidate(page, purpose) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.page || null;
}

async function inspectPageTarget(page) {
  const c = makeClient(page.webSocketDebuggerUrl);
  try {
    await Promise.race([
      c.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP target 连接超时')), 5000)),
    ]);
    const raw = await evalJS(c, EXPR_PAGE_CAPABILITIES);
    return { ...page, capabilities: JSON.parse(raw || '{}') };
  } catch (error) {
    return { ...page, capabilities: null, probeError: error.message };
  } finally {
    c.close();
  }
}

async function findPage(options = {}) {
  const list = await httpJson('/json/list');
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('未找到 Cursor workbench page target');
  if (options.targetId && options.preferAgentsV2 !== true) return selectCursorPageCandidate(pages, options);
  const inspected = await Promise.all(pages.map(inspectPageTarget));
  const usable = inspected.filter((page) => page.capabilities && page.capabilities.hasWritableInput);
  if (options.preferAgentsV2 === true) {
    const agentsV2 = usable.filter((page) => page.capabilities.uiFlavor === 'agents_v2');
    if (agentsV2.length) return selectCursorPageCandidate(agentsV2, { purpose: options.purpose });
    if (options.targetId) return selectCursorPageCandidate(inspected, options);
  }
  return selectCursorPageCandidate(
    usable.length ? usable : inspected.filter((page) => /workbench/i.test(page.url || '') || page.capabilities),
    options,
  ) || pages[0];
}
function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl, { origin: ORIGIN });
  let id = 0; const pending = new Map();
  const failAll = (msg) => { for (const { rej } of pending.values()) { try { rej(new Error(msg)); } catch {} } pending.clear(); };
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.once('error', rej); });
  ws.on('message', (data) => { let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result); } });
  // 关键健壮性：ws 打开后若关闭/出错，立即拒掉所有 pending。否则半开 socket（renderer 后台节流 / target detach / reload）
  // 会让 evalJS 永挂，_waitComplete 的 QUERY_TIMEOUT（轮询守卫，只在迭代顶部求值）永不触发 → job 永挂 + busy 永真
  // + 队列 wedge + ws 泄漏。_failInflight 加固（2026-06-08 review CB-1）。
  ws.on('close', () => failAll('CDP ws 已关闭（页面/渲染进程消失）'));
  ws.on('error', (e) => failAll('CDP ws 出错: ' + (e && e.message)));
  const CMD_TIMEOUT = Number(process.env.CURSOR_BRIDGE_CMD_TIMEOUT || 30000);
  const send = (method, params = {}) => {
    const myId = ++id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (pending.delete(myId)) rej(new Error(`CDP 命令超时 ${method} (${CMD_TIMEOUT}ms)`)); }, CMD_TIMEOUT);
      pending.set(myId, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      try { ws.send(JSON.stringify({ id: myId, method, params })); }
      catch (e) { clearTimeout(t); pending.delete(myId); rej(e); }
    });
  };
  return { ready, send, close: () => { try { ws.close(); } catch {} } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJS(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}
async function chord(c, modifiers, key, code, vk) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

// ---------- 注入页面的探测/操作表达式 ----------
const CURSOR_INPUT_SELECTOR = [
  '[contenteditable="true"].ui-prompt-input-editor__input',
  '.tiptap.ProseMirror[contenteditable="true"]',
  '.aislash-editor-input',
].join(',');
const INPUT_PICKER_BODY = `
  const pickInput=()=>[...document.querySelectorAll(${JSON.stringify(CURSOR_INPUT_SELECTOR)})]
    .filter(e=>e.offsetParent!==null&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&e.getAttribute('contenteditable')!=='false')
    .sort((a,b)=>(b.classList&&b.classList.contains('ui-prompt-input-editor__input')?1:0)-(a.classList&&a.classList.contains('ui-prompt-input-editor__input')?1:0))[0]||null;`;
const EXPR_VISIBLE = `(function(){${INPUT_PICKER_BODY}return !!pickInput();})()`;
function exprFill(text) {
  const js = JSON.stringify(text);
  return `(function(){${INPUT_PICKER_BODY}const inp=pickInput();if(!inp)return 'NO_INPUT';inp.focus();try{const s=getSelection();const r=document.createRange();r.selectNodeContents(inp);s.removeAllRanges();s.addRange(r);}catch(e){}const ok=document.execCommand('insertText',false,${js});try{inp.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${js}}));}catch(e){inp.dispatchEvent(new Event('input',{bubbles:true}));}return ok?(inp.innerText||'').slice(0,30):'EXEC_FAIL';})()`;
}
// 生成中/完成信号：stop 钮数量 + 当前会话中最后一个真实消息 markdown。
// 排除模型选择器里的 markdown，避免短回复被 "Cursor Grok ..." 等模型标签盖过。
const EXPR_SNAP = `(function(){
  const md=[...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')]
    .filter(e=>e.offsetParent!==null&&!e.closest('.ui-model-picker__trigger,[class*=model-picker]'));
  const texts=md.map(m=>(m.innerText||'').trim()).filter(Boolean);
  const last=texts[texts.length-1]||'';
  let hash=0; for(let i=0;i<last.length;i++)hash=((hash<<5)-hash+last.charCodeAt(i))|0;
  const stop=[...document.querySelectorAll('[class*=codicon-stop],[class*=debug-stop],[aria-label*=Stop],[aria-label*=stop],[aria-label*=Cancel],[title*=Stop]')].filter(e=>e.offsetParent!==null).length;
  ${INPUT_PICKER_BODY}
  const input=pickInput();
  const inputText=String(input&&(input.innerText||input.textContent)||'').trim();
  return JSON.stringify({messageCount:texts.length,replyLength:last.length,replyHash:hash,stop,inputTextLength:inputText.length});
})()`;
const EXPR_CLICK_SEND = `(function(){${INPUT_PICKER_BODY}
  const input=pickInput();if(!input)return 'NO_INPUT';
  const composer=input.closest('.composer-bar')||input.parentElement;
  if(!composer)return 'NO_COMPOSER';
  const buttons=[...composer.querySelectorAll('button.ui-prompt-input-submit-button[data-state="send"],button[aria-label="Send"]')]
    .filter(button=>button.offsetParent!==null&&!button.disabled&&button.closest('.composer-bar')===input.closest('.composer-bar'));
  if(buttons.length!==1)return buttons.length?'AMBIGUOUS_SEND':'NO_SEND';
  buttons[0].click();return 'CLICKED';
})()`;
// 抓答案：最后一个可见且不属于模型选择器的 markdown；短回复同样有效。
const EXPR_EXTRACT = `(function(){
  const md=[...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')]
    .filter(e=>e.offsetParent!==null&&!e.closest('.ui-model-picker__trigger,[class*=model-picker]'));
  const texts=md.map(m=>(m.innerText||'').trim()).filter(Boolean);
  return texts[texts.length-1]||'';
})()`;
// Cursor Agents 新界面的 provider 失败会显示为全局 notification tray，并可能立即移除刚创建的
// draft Agent。只读取可见错误及 Request ID；绝不自动点击 Try again 或 Dismiss。
const EXPR_PROVIDER_ERROR = `(function(){
  const trays=[...document.querySelectorAll('.ui-tray.ui-notification-tray[data-visible="true"]')];
  const tray=trays.find(node=>{
    const titleNode=node.querySelector('.ui-tray-header__title');
    const title=String(titleNode&&(titleNode.innerText||titleNode.textContent)||'').trim();
    return /^LLM provider error$/i.test(title);
  });
  if(!tray)return JSON.stringify({found:false});
  const titleNode=tray.querySelector('.ui-tray-header__title');
  const title=String(titleNode&&(titleNode.innerText||titleNode.textContent)||'LLM provider error').trim();
  const lines=String(tray.innerText||tray.textContent||'').split(/\\r?\\n/)
    .map(line=>line.trim()).filter(Boolean);
  const message=lines.find(line=>line!==title&&!/^(Copy ID|Try again)$/i.test(line))||'';
  const match=message.match(/Request ID:\\s*([^\\s]+)/i);
  const requestId=match?match[1]:null;
  const retryAvailable=[...tray.querySelectorAll('button')].some(button=>
    /^Try again$/i.test(String(button.innerText||button.textContent||'').trim()));
  const signature=[title,message,requestId||''].join('|');
  return JSON.stringify({found:true,title,message,requestId,retryAvailable,signature});
})()`;
// 原子地验证当前选中 agentId，并只点击当前 composer 内唯一的停止控件。
// Cursor 既可能显示输入区的 “Stop generation”，也可能在前台工具调用期间只显示
// 与该 composer 绑定的 “Stop command”；两者都必须保持精确选择器与唯一性门禁。
// Agent History 必须保持打开，使 React adapter 与 composer 在同一次 Runtime.evaluate 中可被核对。
function exprClickSelectedAgentStop(agentId) {
  const expected = JSON.stringify(String(agentId));
  return `(function(){
    ${REACT_ADAPTER_BODY}
    const adapter=a;
    if(!adapter)return JSON.stringify({clicked:false,state:'adapter_unavailable'});
    const entries=adapter.entries();
    const selectedEntries=entries.filter(e=>e&&e.isSelected);
    const selected=selectedEntries.length===1?selectedEntries[0]:null;
    if(!selected||selected.id!==${expected}){
      return JSON.stringify({clicked:false,state:'selected_agent_mismatch',selectedId:selected&&selected.id||null,selectedCount:selectedEntries.length});
    }
    const expectedComposerId=String(${expected}).replace(/^local:/,'');
    const composers=[...document.querySelectorAll('.composer-bar[data-composer-id]')]
      .filter(e=>e.offsetParent!==null&&e.dataset.composerId===expectedComposerId);
    if(composers.length!==1){
      return JSON.stringify({clicked:false,state:'composer_identity_mismatch',selectedId:selected.id,count:composers.length});
    }
    const composer=composers[0];
    if(composer.dataset.composerStatus!=='generating'){
      return JSON.stringify({clicked:false,state:'composer_not_generating',selectedId:selected.id,status:composer.dataset.composerStatus||null});
    }
    const generationButtons=[...composer.querySelectorAll('button.ui-prompt-input-submit-button[data-state="stop"][aria-label="Stop generation"]')]
      .filter(button=>button.offsetParent!==null&&!button.disabled&&button.closest('.composer-bar')===composer);
    const commandButtons=[...composer.querySelectorAll('button.ui-shell-tool-call__glass-stop[aria-label="Stop command"]')]
      .filter(button=>button.offsetParent!==null&&!button.disabled&&button.closest('.composer-bar')===composer);
    const buttons=[...generationButtons,...commandButtons];
    if(buttons.length!==1){
      return JSON.stringify({clicked:false,state:buttons.length?'ambiguous_stop_controls':'stop_control_missing',selectedId:selected.id,count:buttons.length});
    }
    buttons[0].click();
    return JSON.stringify({clicked:true,state:'clicked',selectedId:selected.id,composerId:composer.dataset.composerId,control:generationButtons.length?'stop_generation':'stop_command'});
  })()`;
}
// "New Agent" 新对话钮中心坐标。新版 Cursor Agents 只有可见文本，旧版主要依赖 aria-label。
const EXPR_FIND_NEWAGENT = `(function(){const b=[...document.querySelectorAll('button,[role=button],a.action-label,.codicon')].find(e=>{if(e.offsetParent===null||e.closest('.glass-sidebar-agent-menu-btn'))return false;const s=(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+(e.innerText||'');return /(?:^|\\s)New (?:Agent|Chat)(?:\\s|$)/i.test(s);});if(!b)return '';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`;

// Legacy Agents v2 wrapped each repo in section.glass-sidebar-workspace-section-root.
// Cursor 3.16.17 Agents Window dropped that wrapper; repo identity is now the
// .ui-sidebar-section-head label, with New Agent in the same compact row.
const WORKSPACE_SECTION_BODY = `
  const headText=(el)=>String(el&&(el.innerText||el.textContent)||'').trim();
  const isNewAgentButton=(node)=>{
    if(!node)return false;
    const aria=String(node.getAttribute&&node.getAttribute('aria-label')||'').trim();
    const text=String(node.innerText||'').trim().split('\\n')[0].trim();
    return /^New Agent$/i.test(aria)||/^New Agent$/i.test(text);
  };
  const findNewAgent=(root)=>[...(root&&root.querySelectorAll?root.querySelectorAll('button,[role=button]'):[])].find(isNewAgentButton)||null;
  const collectWorkspaceSections=()=>{
    const sections=[];
    const seen=new Set();
    const add=(head,node,button)=>{
      const name=String(head||'').trim();
      if(!name)return;
      const key=name.toLowerCase();
      if(seen.has(key))return;
      seen.add(key);
      sections.push({head:name,node,button:button||findNewAgent(node)});
    };
    for(const section of document.querySelectorAll('section.glass-sidebar-workspace-section-root')){
      add(headText(section.querySelector('.ui-sidebar-section-head')),section,null);
    }
    for(const headEl of document.querySelectorAll('.ui-sidebar-section-head')){
      const name=headText(headEl);
      if(!name)continue;
      let scope=headEl;
      let chosen=null;
      for(let i=0;scope&&i<16;i++,scope=scope.parentElement){
        const nested=[...scope.querySelectorAll('.ui-sidebar-section-head')].map(headText).filter(Boolean);
        const unique=[...new Set(nested.map((h)=>h.toLowerCase()))];
        const button=findNewAgent(scope);
        if(button&&unique.length===1&&unique[0]===name.toLowerCase()){
          chosen={node:scope,button};
          break;
        }
      }
      add(name,chosen?chosen.node:headEl,chosen&&chosen.button);
    }
    return sections;
  };
`;

function exprCreateAgentForWorkspace(projectPath) {
  const workspaceLabel = JSON.stringify(basename(String(projectPath || '')).trim().toLowerCase());
  return `(function(){
    ${WORKSPACE_SECTION_BODY}
    const wanted=${workspaceLabel};
    const sections=collectWorkspaceSections();
    const available=sections.map((section)=>section.head).filter(Boolean);
    const matches=sections.filter((section)=>section.head.toLowerCase()===wanted);
    if(matches.length===0)return JSON.stringify({ok:false,state:'repository_not_found',wanted,available});
    if(matches.length>1)return JSON.stringify({ok:false,state:'repository_ambiguous',wanted,count:matches.length});
    const button=matches[0].button;
    if(!button)return JSON.stringify({ok:false,state:'repository_new_agent_unavailable',wanted});
    button.click();
    return JSON.stringify({ok:true,state:'repository_agent_created',workspace:wanted});
  })()`;
}

function exprInspectWorkspaceRepository(projectPath) {
  const workspaceLabel = JSON.stringify(basename(String(projectPath || '')).trim().toLowerCase());
  return `(function(){
    ${WORKSPACE_SECTION_BODY}
    const wanted=${workspaceLabel};
    const sections=collectWorkspaceSections();
    const available=sections.map((section)=>section.head).filter(Boolean);
    const matches=sections.filter((section)=>section.head.toLowerCase()===wanted);
    if(matches.length===0)return JSON.stringify({ok:false,state:'repository_not_found',wanted,available});
    if(matches.length>1)return JSON.stringify({ok:false,state:'repository_ambiguous',wanted,count:matches.length});
    return JSON.stringify({ok:true,state:'repository_ready',workspace:wanted});
  })()`;
}

const EXPR_HISTORY_OPEN = `(function(){return !![...document.querySelectorAll('.compact-agent-history-react-menu-label')].find(e=>e.offsetParent!==null);})()`;
const EXPR_FIND_HISTORY = `(function(){const b=[...document.querySelectorAll('button,[role=button],a.action-label,.codicon')].find(e=>{if(e.offsetParent===null)return false;const s=(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'');return /Show Chat History|Chat History|Agent History/i.test(s);});if(!b)return '';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`;

// 旧版 Agent History 提供 entries + onOpenEntry(id)；新版 Cursor Agents 的侧栏提供
// section.headers + onSelectAgent(header)。两套不稳定 React 内部接口只在此处归一化。
const REACT_ADAPTER_BODY = `
  const readScalar=value=>value&&typeof value==='object'&&'value' in value?value.value:value;
  const normalizeTimestamp=(value,index)=>{
    const raw=readScalar(value);
    let timestamp=raw instanceof Date?raw.getTime():Number(raw);
    if(!Number.isFinite(timestamp))timestamp=Date.parse(String(raw||''));
    return Number.isFinite(timestamp)?timestamp:index;
  };
  const normalizeLegacy=(e,index)=>({
    id:String(e&&e.id||''),label:String(e&&e.label||''),searchText:String(e&&e.searchText||''),
    timestamp:normalizeTimestamp(e&&e.timestamp,index),isSelected:!!(e&&e.isSelected),
    showSpinner:!!(e&&e.showSpinner),
    icon:String(typeof (e&&e.icon)==='string'?e.icon:(e&&e.icon&&((e.icon.id)||(e.icon.props&&e.icon.props.id)||(e.icon.type&&e.icon.type.id)))||'')
  });
  const normalizeV2=(header,selectedId,index,section)=>{
    const rawId=String(readScalar(header&&header.id)||'').replace(/^local:/,'');
    const status=String(readScalar(header&&header.status)||'').toLowerCase();
    const label=String(readScalar(header&&header.name)||readScalar(header&&header.subtitle)||'');
    const searchText=[label,readScalar(header&&header.subtitle),readScalar(header&&header.location),readScalar(header&&header.source)].filter(Boolean).join(' ');
    let icon=status;
    if(/in_progress|running|generating/.test(status))icon='loading';
    else if(status==='done'||status==='completed')icon='check-circled';
    else if(/needs_attention/.test(status))icon='needs-attention';
    else if(/failed|error/.test(status))icon='warning';
    else if(/cancel/.test(status))icon='circle-slash';
    return {
      id:rawId?'local:'+rawId:'',label,searchText,
      timestamp:normalizeTimestamp(readScalar(header&&header.lastUpdatedAt)||readScalar(header&&header.createdAt),index),
      isSelected:!!rawId&&(String(selectedId||'')===rawId||String(selectedId||'')==='local:'+rawId),
      showSpinner:/in_progress|running|generating/.test(status),icon:icon||'draft',
      workspaceId:String(readScalar(section&&section.id)||''),workspaceLabel:String(readScalar(section&&section.displayName)||'')
    };
  };
  const findLegacyAdapter=()=>{
    const label=[...document.querySelectorAll('.compact-agent-history-react-menu-label')].find(e=>e.offsetParent!==null);
    if(!label)return null;
    const nodes=[]; let n=label;
    for(let i=0;n&&i<18;i++,n=n.parentElement)nodes.push(n);
    for(const node of nodes){
      for(const key of Object.keys(node)){
        if(!key.startsWith('__reactFiber$')&&!key.startsWith('__reactProps$'))continue;
        const seed=node[key];
        let f=key.startsWith('__reactFiber$')?seed:{memoizedProps:seed,return:null};
        for(let j=0;f&&j<36;j++,f=f.return){
          for(const p of [f.memoizedProps,f.pendingProps,f.stateNode&&f.stateNode.props]){
            if(p&&Array.isArray(p.entries)&&typeof p.onOpenEntry==='function')return p;
          }
        }
      }
    }
    return null;
  };
  const findV2Props=()=>{
    const found=[]; const seen=new Set();
    for(const root of document.querySelectorAll('.glass-sidebar-agent-list-container')){
      const nodes=[]; let n=root;
      for(let i=0;n&&i<24;i++,n=n.parentElement)nodes.push(n);
      for(const node of nodes){
        for(const key of Object.keys(node)){
          if(!key.startsWith('__reactFiber$')&&!key.startsWith('__reactProps$'))continue;
          const seed=node[key];
          let f=key.startsWith('__reactFiber$')?seed:{memoizedProps:seed,return:null};
          for(let j=0;f&&j<80;j++,f=f.return){
            for(const p of [f.memoizedProps,f.pendingProps,f.stateNode&&f.stateNode.props]){
              if(p&&p.section&&Array.isArray(p.section.headers)&&typeof p.onSelectAgent==='function'&&!seen.has(p)){
                seen.add(p);found.push(p);
              }
            }
          }
        }
      }
    }
    return found;
  };
  const findAdapter=()=>{
    const v2=findV2Props();
    if(v2.length){
      return {
        kind:'agents_v2',
        entries:()=>{
          const entries=[];const seen=new Set();let index=0;
          for(const p of v2){
            const selectedId=readScalar(p.selectedAgentId);
            for(const header of p.section.headers){
              const entry=normalizeV2(header,selectedId,index++,p.section);
              if(entry.id&&!seen.has(entry.id)){seen.add(entry.id);entries.push(entry);}
            }
          }
          return entries;
        },
        open:id=>{
          const raw=String(id||'').replace(/^local:/,'');
          for(const p of v2){
            const header=p.section.headers.find(h=>String(readScalar(h&&h.id)||'')===raw);
            if(header){p.onSelectAgent(header);return true;}
          }
          return false;
        }
      };
    }
    const legacy=findLegacyAdapter();
    if(!legacy)return null;
    return {
      kind:'legacy',
      entries:()=>legacy.entries.map(normalizeLegacy).filter(e=>e.id),
      open:id=>{
        const value=String(id||'');
        if(!legacy.entries.some(e=>String(e&&e.id||'')===value))return false;
        legacy.onOpenEntry(value);return true;
      }
    };
  };
  const a=findAdapter();`;

const EXPR_AGENT_ADAPTER_READY = `(function(){${REACT_ADAPTER_BODY}return !!a;})()`;
const EXPR_PAGE_CAPABILITIES = `(function(){${INPUT_PICKER_BODY}
  const input=pickInput();
  const hasV2Sidebar=!!document.querySelector('.glass-sidebar-agent-list-container');
  const hasLegacyInput=!!document.querySelector('.aislash-editor-input');
  const hasLegacyHistory=!!document.querySelector('.compact-agent-history-react-menu-label')||
    [...document.querySelectorAll('button,[role=button],a.action-label,.codicon')].some(e=>/Show Chat History|Chat History|Agent History/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')));
  const uiFlavor=hasV2Sidebar||(input&&input.classList&&input.classList.contains('ui-prompt-input-editor__input'))?'agents_v2':hasLegacyInput?'legacy':'unknown';
  return JSON.stringify({
    hasWritableInput:!!input,uiFlavor,
    agentAdapterKind:hasV2Sidebar?'agents_v2':hasLegacyHistory?'legacy':'none',
    hasComposer:!!document.querySelector('.composer-bar[data-composer-id]'),
    visible:document.visibilityState==='visible',focused:typeof document.hasFocus==='function'&&document.hasFocus(),documentTitle:String(document.title||'')
  });
})()`;

const EXPR_HISTORY_ENTRIES = `(function(){${REACT_ADAPTER_BODY}
  if(!a)return JSON.stringify({ok:false,error:'REACT_ADAPTER_UNAVAILABLE'});
  return JSON.stringify({ok:true,kind:a.kind,entries:a.entries()});
})()`;

function exprOpenAgent(agentId) {
  const id = JSON.stringify(String(agentId));
  return `(function(){${REACT_ADAPTER_BODY}
    if(!a)return 'REACT_ADAPTER_UNAVAILABLE';
    return a.open(${id})?'OPENED':'AGENT_NOT_FOUND';
  })()`;
}

function normalizeAllowedPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  const prefix = /^[a-zA-Z]:/.test(raw) ? raw.slice(0, 2).toLowerCase() : '';
  const body = prefix ? raw.slice(2) : raw;
  const parts = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push('..');
    } else {
      parts.push(part.toLowerCase());
    }
  }
  const normalized = (prefix ? prefix + '/' : '') + parts.join('/');
  return normalized || '.';
}

function pathsOverlap(a, b) {
  const left = normalizeAllowedPath(a);
  const right = normalizeAllowedPath(b);
  return left === '.' || right === '.' || left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

function selectNewAgentEntry(beforeEntries, afterEntries) {
  const before = new Set((beforeEntries || []).map((e) => e.id));
  const fresh = (afterEntries || []).map((e, index) => ({ ...e, _index: index })).filter((e) => e.id && !before.has(e.id));
  if (fresh.length === 0) return null;
  const selected = fresh.filter((e) => e.isSelected);
  const pool = selected.length > 0 ? selected : fresh;
  return [...pool].sort((a, b) => (Number(b.timestamp || 0) - Number(a.timestamp || 0)) || b._index - a._index)[0];
}

function isTerminalTask(job) {
  return !!job && ['completed', 'failed', 'cancelled', 'reaped', 'abandoned'].includes(job.status);
}

function isTargetedStopConfirmed(clickResult, stableTerminalCount) {
  return !!clickResult && clickResult.clicked === true && Number(stableTerminalCount) >= 2;
}

function updateStableEntryObservation(lastSignature, stableCount, entry) {
  const signature = entry ? `${entry.id}:${String(entry.icon || '')}:${entry.showSpinner ? '1' : '0'}` : '';
  return {
    signature,
    count: signature && signature === lastSignature ? Number(stableCount || 0) + 1 : (signature ? 1 : 0),
  };
}

function classifyParallelTerminalIcon(icon) {
  const value = String(icon || '');
  if (/circle-slash|cancel/i.test(value)) return 'cancelled';
  if (/needs[-_]attention/i.test(value)) return 'needs_attention';
  if (/error|failed|warning/i.test(value)) return 'failed';
  if (/check-circled|check/i.test(value)) return 'completed';
  return 'unknown';
}

function providerErrorSignature(info) {
  if (!info || info.found !== true) return '';
  return String(info.signature || [info.title, info.message, info.requestId].filter(Boolean).join('|'));
}

function createProviderError(info) {
  const providerError = {
    found: true,
    title: String(info && info.title || 'LLM provider error'),
    message: String(info && info.message || ''),
    requestId: info && info.requestId ? String(info.requestId) : null,
    retryAvailable: !!(info && info.retryAvailable),
    signature: providerErrorSignature(info),
  };
  const detail = providerError.message || (providerError.requestId ? `Request ID: ${providerError.requestId}` : '');
  const error = new Error([providerError.title, detail].filter(Boolean).join(': '));
  error.sent = true;
  error.confirmedTerminal = true;
  error.terminalEvidence = `provider_error_tray:${providerError.requestId || providerError.signature || 'visible'}`;
  error.providerError = providerError;
  return error;
}

function promoteAgentsWorkspaceLifecycle(lifecycle, agentsWorkspace) {
  return {
    ...lifecycle,
    status: 'agents-workspace-ready',
    launchReason: 'agents-repository-ready',
    targetId: agentsWorkspace.targetId,
    targetUiFlavor: agentsWorkspace.targetUiFlavor,
    workspaceAction: 'reused-agents-repository',
    message: `CCE 已确认 Cursor Agents 中的工作区 ${lifecycle.projectPath || agentsWorkspace.workspace || ''} 可以使用。`,
    needsAction: null,
    nextStep: null,
    retryable: false,
  };
}

class CursorBridge {
  constructor(options = {}) {
    this.environmentDelegationMode = normalizeDelegationMode(options.delegationMode || DELEGATION_MODE);
    this._syncDelegationState();
    this.runtimeFile = options.runtimeFile === null
      ? null
      : resolve(options.runtimeFile || resolveCursorRuntimeFile());
    this.runtimeModeDefault = normalizeCursorRuntimeMode(
      options.runtimeModeDefault || process.env.CURSOR_BRIDGE_RUNTIME_MODE,
      'normal',
    );
    const persistedRuntimeMode = options.runtimeMode === undefined
      ? readPersistedCursorRuntimeMode(this.runtimeFile)
      : null;
    const requestedRuntimeMode = options.runtimeMode !== undefined
      ? options.runtimeMode
      : persistedRuntimeMode || this.runtimeModeDefault;
    this.persistedRuntimeMode = persistedRuntimeMode;
    this.runtimeMode = normalizeCursorRuntimeMode(requestedRuntimeMode);
    this.runtimeModeSource = options.runtimeMode !== undefined
      ? 'constructor'
      : persistedRuntimeMode
        ? 'persistent'
        : process.env.CURSOR_BRIDGE_RUNTIME_MODE
          ? 'environment'
          : 'default';
    this.runtimeModeScope = persistedRuntimeMode
      ? 'persistent'
      : options.runtimeMode !== undefined
        ? 'constructor'
        : process.env.CURSOR_BRIDGE_RUNTIME_MODE
          ? 'environment'
          : 'default';
    this.workspaceFile = options.workspaceFile === null
      ? null
      : resolve(options.workspaceFile || resolveWorkspaceBindingFile());
    this.workspaceKey = options.workspaceKey || resolveWorkspaceBindingKey();
    const persistedWorkspace = options.projectPath === undefined
      ? readWorkspaceBinding(this.workspaceFile, this.workspaceKey)
      : null;
    this.projectPath = options.projectPath !== undefined
      ? resolve(String(options.projectPath))
      : persistedWorkspace && persistedWorkspace.projectPath || null;
    this.workspaceSource = options.projectPath !== undefined
      ? 'constructor'
      : persistedWorkspace
        ? 'persistent_init'
        : 'auto_detect';
    this.workspaceUpdatedAt = persistedWorkspace && persistedWorkspace.updatedAt || null;
    this._lastPresentation = null;
    this.busy = false;
    this.queue = [];
    this._healing = null;
    this.tasks = new Map();
    this.nextTaskId = 1;
    this.activeParallel = new Map();
    this.currentJob = null;
    this._uiTail = Promise.resolve();
    this.parallelRestoreAgentId = null;
    this.parallelRestoreTargetId = null;
  }

  workspaceView() {
    const resolvedProjectPath = this.projectPath || this._lastLifecycle && this._lastLifecycle.projectPath || null;
    return {
      workspaceKey: this.workspaceKey,
      projectPath: resolvedProjectPath,
      workspaceSource: this.projectPath ? this.workspaceSource : resolvedProjectPath ? 'host_auto_detect' : this.workspaceSource,
      workspaceUpdatedAt: this.workspaceUpdatedAt,
      workspaceFile: this.workspaceFile,
      initialized: !!this.projectPath,
      reinitializable: true,
      interactionPreference: 'agents_v2_when_open_else_legacy',
      cursorUiPreferencePreserved: true,
    };
  }

  async initializeWorkspace(projectPath) {
    if (this.busy || this.activeParallel.size > 0 || this.queue.length > 0) {
      throw new Error('cursor_init cannot change workspace while Cursor tasks are queued or running');
    }
    const previousProjectPath = this.projectPath || this._lastLifecycle && this._lastLifecycle.projectPath || null;
    const saved = writeWorkspaceBinding(this.workspaceFile, this.workspaceKey, projectPath);
    this.projectPath = saved.projectPath;
    this.workspaceSource = 'persistent_init';
    this.workspaceUpdatedAt = saved.updatedAt;
    this._lastLifecycle = null;
    try {
      await this._ensureCursor();
    } catch (error) {
      const lifecycle = this._lastLifecycle;
      const recoverableStatuses = new Set([
        'running-no-debug',
        'port-not-cursor',
        'no-exe',
        'timeout',
        'workspace-not-ready',
      ]);
      if (!lifecycle || !recoverableStatuses.has(lifecycle.status)) throw error;
      return {
        previousProjectPath,
        ...this.workspaceView(),
        bindingPersisted: true,
        ready: false,
        status: lifecycle.status,
        message: lifecycle.message || 'CCE 初始化尚未完成，但工作区已经保存。',
        nextStep: lifecycle.nextStep || '处理提示后，重新执行同一句初始化命令。',
        retryable: lifecycle.retryable !== false,
        lifecycle,
      };
    }
    return {
      previousProjectPath,
      ...this.workspaceView(),
      bindingPersisted: true,
      ready: true,
      status: 'ready',
      message: `CCE 已准备好使用工作区 ${saved.projectPath}。`,
      nextStep: '现在可以直接使用 cursor_context_engine 或 cursor_do。',
      lifecycle: this._lastLifecycle,
    };
  }

  async _findAgentsWorkspace(projectPath) {
    if (!projectPath) return null;
    let page;
    try {
      page = await findPage({ purpose: 'fifo', preferAgentsV2: true });
    } catch {
      return null;
    }
    if (!page || page.capabilities && page.capabilities.uiFlavor !== 'agents_v2') return null;
    const c = makeClient(page.webSocketDebuggerUrl);
    try {
      await c.ready;
      const repository = JSON.parse(await evalJS(c, exprInspectWorkspaceRepository(projectPath)) || '{}');
      if (!repository.ok) return null;
      return {
        targetId: page.id,
        targetUiFlavor: 'agents_v2',
        workspace: repository.workspace,
      };
    } catch {
      return null;
    } finally {
      c.close();
    }
  }

  _syncDelegationState() {
    this.delegationEnabled = this.environmentDelegationMode !== 'off';
    this.delegationMode = this.delegationEnabled ? 'on' : 'off';
  }

  delegationView() {
    return {
      delegationMode: this.delegationMode,
      delegationEnabled: this.delegationEnabled,
      environmentLockedOff: this.environmentDelegationMode === 'off',
    };
  }

  _refreshPersistedRuntimeMode() {
    if (!this.runtimeFile || this.runtimeModeScope === 'session' || this.runtimeModeScope === 'constructor') {
      return false;
    }
    const persisted = readPersistedCursorRuntimeMode(this.runtimeFile);
    if (!persisted) return false;
    const changed = this.runtimeMode !== persisted
      || this.runtimeModeSource !== 'persistent'
      || this.runtimeModeScope !== 'persistent';
    this.persistedRuntimeMode = persisted;
    if (changed) {
      this.runtimeMode = persisted;
      this.runtimeModeSource = 'persistent';
      this.runtimeModeScope = 'persistent';
    }
    return changed;
  }

  runtimeModeView() {
    this._refreshPersistedRuntimeMode();
    const restartMode = this.persistedRuntimeMode || this.runtimeModeDefault;
    const modeStored = this.runtimeModeScope === 'persistent'
      && this.persistedRuntimeMode === this.runtimeMode;
    return {
      runtimeMode: this.runtimeMode,
      runtimeModeSource: this.runtimeModeSource,
      runtimeModeScope: this.runtimeModeScope,
      runtimeModeDefault: this.runtimeModeDefault,
      persistedRuntimeMode: this.persistedRuntimeMode,
      runtimeFile: this.runtimeFile,
      modeStored,
      persistsAcrossRestart: this.runtimeMode === restartMode,
      restartMode,
      availableRuntimeModes: [...CURSOR_RUNTIME_MODES],
      platformWindowControl: process.platform === 'win32' ? 'supported' : 'unsupported',
      startupBehavior: cursorStartupBehavior(this.runtimeMode),
      minimalModeWarning: this.runtimeMode === 'minimal'
        ? 'Cursor windows are continuously hidden. Switch CCE to normal mode before using the Cursor interface.'
        : null,
      lastPresentation: this._lastPresentation,
    };
  }

  async applyRuntimePresentation(action) {
    const normalizedAction = String(action || '').trim().toLowerCase();
    if (!['hide', 'show'].includes(normalizedAction)) {
      throw new Error('cursor_runtime action supports hide or show');
    }
    const result = setCursorWindowPresentation({
      action: normalizedAction,
      port: CDP_PORT,
    });
    this._lastPresentation = { ...result, at: new Date().toISOString() };
    return this._lastPresentation;
  }

  async setRuntimeMode(value, scope = 'persistent') {
    const normalizedScope = String(scope || 'persistent').trim().toLowerCase();
    if (!['persistent', 'session'].includes(normalizedScope)) {
      throw new Error('cursor_runtime supports scope=persistent or scope=session');
    }
    const normalized = normalizeCursorRuntimeMode(value, '');
    if (!CURSOR_RUNTIME_MODES.includes(normalized)) throw new Error(`unsupported Cursor runtime mode: ${value}`);
    if (normalizedScope === 'persistent') writePersistedCursorRuntimeMode(this.runtimeFile, normalized);
    const previousMode = this.runtimeMode;
    this.runtimeMode = normalized;
    this.runtimeModeSource = normalizedScope === 'persistent' ? 'persistent' : 'runtime';
    this.runtimeModeScope = normalizedScope;
    if (normalizedScope === 'persistent') this.persistedRuntimeMode = normalized;
    const presentation = await this.applyRuntimePresentation(normalized === 'minimal' ? 'hide' : 'show');
    return {
      previousMode,
      ...this.runtimeModeView(),
      presentation,
      recovery: normalized === 'minimal'
        ? 'Switch CCE to normal mode before opening Cursor manually.'
        : null,
    };
  }

  async contextEngine(query) {
    const text = String(query || '').trim();
    if (!text) throw new Error('query 不能为空');
    if (text.length > 20000) throw new Error('query 过长（最大 20000 字符）');
    if (this._hasGlobalReservation()) {
      throw new Error('存在 Stop 未确认的全局 Cursor 占用；请先处理 cursor_status 中的 blockingTaskIds');
    }
    await this._ensureCursor();
    const job = this._enqueue('context_engine', buildContextEnginePrompt(text), {
      timeoutMs: QUERY_TIMEOUT,
      newChat: true,
      execution: 'fifo',
      readOnly: true,
      allowedPaths: [],
    });
    return normalizeCceSearchResult(await job.promise);
  }

  // Unlisted compatibility aliases for clients that cached the pre-3.0 tool surface.
  async search(query) { return this.contextEngine(query); }
  async searchDeep(query) { return this.contextEngine(query); }

  async doTask(prompt, options = {}) {
    if (!this.delegationEnabled) {
      throw new Error('cursor_do is disabled by CURSOR_BRIDGE_DELEGATION=off; restart the MCP server without that setting to enable delegation');
    }
    const text = String(prompt || '').trim();
    if (!text) throw new Error('prompt 不能为空');
    if (text.length > 100000) throw new Error('prompt 过长（最大 100000 字符）');
    if (this._hasGlobalReservation()) {
      throw new Error('存在 Stop 未确认的全局 Cursor 占用；在显式恢复或释放前禁止提交新任务');
    }
    await this._ensureCursor();

    const execution = String(options.execution || 'fifo');
    if (execution !== 'fifo' && execution !== 'parallel_agent') {
      throw new Error(`execution 不支持 ${execution}；只能是 fifo 或 parallel_agent`);
    }
    const readOnly = options.readOnly === true;
    const timeoutMs = Math.max(30000, Math.min(900000, Number(options.timeoutMs || 600000)));
    const allowedPaths = Array.isArray(options.allowedPaths)
      ? options.allowedPaths.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (readOnly && allowedPaths.length > 0) {
      throw new Error('read_only=true 与 allowed_paths 不能同时使用；只读任务不得声明写入范围');
    }
    if (execution === 'parallel_agent' && !readOnly && allowedPaths.length === 0) {
      throw new Error('parallel_agent 写任务必须提供 allowed_paths；纯读取任务请显式设置 read_only=true');
    }
    if (execution === 'parallel_agent' && !readOnly) {
      this._validateParallelAllowedPaths(allowedPaths);
      this._assertNoParallelPathConflict(allowedPaths);
    }

    const contract = String(options.completionContract || '').trim();
    let fullPrompt = text;
    if (readOnly) fullPrompt += '\n\n只读边界：不得修改、创建或删除任何文件，不得执行会改变工作区状态的命令。';
    if (allowedPaths.length > 0) {
      fullPrompt += '\n\n允许修改范围（不得越界）：\n' + allowedPaths.map((x) => '- ' + x).join('\n');
    }
    fullPrompt += contract ? '\n\n验收与回报合同：\n' + contract : DO_DEFAULT_CONTRACT;

    const job = this._enqueue('do', fullPrompt, {
      timeoutMs,
      newChat: true,
      execution,
      readOnly,
      allowedPaths,
    });
    if (options.background !== false) return this._taskView(job);
    await job.promise;
    return this._taskView(job, true);
  }

  _assertNoParallelPathConflict(allowedPaths) {
    if (this._hasGlobalReservation()) {
      throw new Error('存在 Stop 未确认的全局 Cursor 占用；禁止提交新的 parallel_agent 写任务');
    }
    const live = [...this.tasks.values()].filter((job) =>
      job.execution === 'parallel_agent' && !job.readOnly && !isTerminalTask(job));
    for (const job of live) {
      const overlap = allowedPaths.some((a) => job.allowedPaths.some((b) => pathsOverlap(a, b)));
      if (overlap) throw new Error(`parallel_agent allowed_paths 与任务 ${job.id} 重叠；请改用 fifo 或拆成不重叠路径`);
    }
  }

  _validateParallelAllowedPaths(allowedPaths) {
    for (const raw of allowedPaths) {
      const slash = String(raw).replace(/\\/g, '/');
      if (/[*?\[\]{}!]/.test(slash)) throw new Error(`parallel_agent allowed_paths 不接受 glob：${raw}`);
      if (/^[a-zA-Z]:\//.test(slash) || slash.startsWith('/')) {
        throw new Error(`parallel_agent allowed_paths 必须使用工作区相对路径：${raw}`);
      }
      const normalized = normalizeAllowedPath(slash);
      if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`parallel_agent allowed_paths 不得为空或越出工作区：${raw}`);
      }
    }
  }

  _enqueue(kind, prompt, options) {
    const id = `cursor-${Date.now().toString(36)}-${this.nextTaskId++}`;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    promise.catch(() => {});
    const job = {
      id,
      kind,
      prompt,
      timeoutMs: options.timeoutMs,
      newChat: options.newChat,
      execution: options.execution || 'fifo',
      effectiveExecution: options.execution || 'fifo',
      readOnly: options.readOnly === true,
      allowedPaths: options.allowedPaths || [],
      projectPath: options.projectPath || this._lastLifecycle && this._lastLifecycle.projectPath || this.projectPath || null,
      status: 'queued',
      phase: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      sentAt: null,
      agentId: null,
      agentLabel: null,
      targetId: null,
      targetUiFlavor: null,
      fallbackReason: null,
      result: null,
      error: null,
      cancelRequested: false,
      cancelReason: null,
      underlyingStopConfirmed: null,
      orphanedAt: null,
      lastRecoveryAt: null,
      recoveryState: null,
      monitorAttached: false,
      monitorGeneration: 0,
      monitorPromise: null,
      resultUnavailable: false,
      terminalEvidence: null,
      providerError: null,
      sendState: 'not_sent',
      reservationScope: null,
      controlTail: Promise.resolve(),
      settled: false,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.tasks.set(id, job);
    this.queue.push(job);
    this._trimTasks();
    this._drain();
    return job;
  }

  _finishJob(job, result) {
    if (isTerminalTask(job)) return;
    job.result = result;
    job.status = 'completed';
    job.phase = 'completed';
    job.finishedAt = new Date().toISOString();
    job.recoveryState = null;
    job.cancelRequested = false;
    job.resultUnavailable = false;
    if (!job.settled) {
      job.settled = true;
      job.resolve(result);
    }
  }

  _failJob(job, error) {
    if (isTerminalTask(job)) return;
    const e = error instanceof Error ? error : new Error(String(error));
    job.error = e.message;
    if (e.providerError) job.providerError = e.providerError;
    if (e.terminalEvidence) job.terminalEvidence = e.terminalEvidence;
    job.status = 'failed';
    job.phase = 'failed';
    job.finishedAt = new Date().toISOString();
    job.recoveryState = null;
    job.cancelRequested = false;
    job.reservationScope = null;
    if (!job.settled) {
      job.settled = true;
      job.reject(e);
    }
  }

  _cancelJob(job, reason, options = {}) {
    if (isTerminalTask(job)) return this._taskView(job, true);
    const message = String(reason || '任务已取消').trim() || '任务已取消';
    this.queue = this.queue.filter((candidate) => candidate.id !== job.id);
    this.activeParallel.delete(job.id);
    this._invalidateParallelMonitor(job);
    job.cancelRequested = false;
    job.cancelReason = message;
    job.underlyingStopConfirmed = options.underlyingStopConfirmed === true;
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.error = message;
    job.finishedAt = new Date().toISOString();
    job.recoveryState = options.underlyingStopConfirmed === true ? 'stopped' : 'released_unconfirmed';
    job.reservationScope = null;
    if (!job.settled) {
      job.settled = true;
      job.reject(new Error(message));
    }
    this._drain();
    this._maybeRestoreParallelOrigin();
    return this._taskView(job, true);
  }

  _orphanParallelJob(job, error) {
    if (isTerminalTask(job)) return;
    const e = error instanceof Error ? error : new Error(String(error));
    job.error = e.message;
    job.status = 'needs_attention';
    job.phase = 'orphaned';
    job.finishedAt = null;
    job.orphanedAt = job.orphanedAt || new Date().toISOString();
    job.recoveryState = 'unverified';
    job.reservationScope = job.execution === 'parallel_agent' && job.agentId
      ? (job.readOnly ? 'agent' : 'paths')
      : 'global';
    // 保留在 activeParallel：真实 Cursor Agent 可能仍在运行。未绑定身份或 FIFO 孤儿使用全局占用。
    this.activeParallel.set(job.id, job);
    if (!job.settled) {
      job.settled = true;
      job.reject(e);
    }
  }

  _withUiLock(fn) {
    const run = this._uiTail.then(fn, fn);
    this._uiTail = run.catch(() => {});
    return run;
  }

  _withJobLock(job, fn) {
    const previous = job.controlTail || Promise.resolve();
    const run = previous.then(fn, fn);
    job.controlTail = run.catch(() => {});
    return run;
  }

  _hasGlobalReservation() {
    return [...this.activeParallel.values()].some((job) =>
      !isTerminalTask(job) && job.reservationScope === 'global');
  }

  _invalidateParallelMonitor(job) {
    job.monitorGeneration = Number(job.monitorGeneration || 0) + 1;
    job.monitorPromise = null;
    job.monitorAttached = false;
  }

  _monitorOwns(job, generation) {
    return !isTerminalTask(job)
      && this.activeParallel.has(job.id)
      && job.monitorGeneration === generation;
  }

  // 自愈：每次查询前委托 ensureCursorRunning。并发去重。失败静默降级（_run 报清晰错）。
  // 统一走 ensureCursorRunning 复用其【单一身份校验来源】（cdpUp + cdpIsCursor）——避免热路径裸 /json/version 检查
  // 绕过身份校验、在别的 IDE 占 9223 时驱动错应用（2026-06-08 review #6）。
  _ensureCursor() {
    this._refreshPersistedRuntimeMode();
    if (this._healing) return this._healing;
    this._healing = (async () => {
      try {
        const { ensureCursorRunning } = await import('./launch-cursor.mjs');
        const rr = await ensureCursorRunning({
          reason: 'adapter-heal',
          runtimeMode: this.runtimeMode,
          ...(this.projectPath ? { projectPath: this.projectPath } : {}),
        });
        this._lastLifecycle = {
          adapterPid: rr.adapterPid ?? process.pid,
          supervisorPid: rr.supervisorPid ?? null,
          reusedSupervisor: !!rr.reusedSupervisor,
          createdSupervisor: !!rr.createdSupervisor,
          launchReason: rr.launchReason || rr.status,
          status: rr.status,
          spawnMethod: rr.spawnMethod || null,
          cursorPid: rr.cursorPid || null,
          runtimeMode: rr.runtimeMode || this.runtimeMode,
          projectPath: rr.projectPath || null,
          targetId: rr.targetId || null,
          workspaceAction: rr.workspaceAction || null,
          presentation: rr.presentation || null,
          message: rr.message || null,
          needsAction: rr.needsAction || null,
          nextStep: rr.nextStep || null,
          retryable: rr.retryable === true,
          cursorExecutable: rr.cursorExecutable || null,
          cursorExecutableSource: rr.cursorExecutableSource || null,
        };
        if (!rr.ok && rr.status === 'workspace-not-ready' && rr.projectPath) {
          const agentsWorkspace = await this._findAgentsWorkspace(rr.projectPath);
          if (agentsWorkspace) {
            this._lastLifecycle = promoteAgentsWorkspaceLifecycle(this._lastLifecycle, agentsWorkspace);
          }
        }
        if (this.runtimeMode === 'minimal') {
          this._lastPresentation = rr.presentation
            ? { ...rr.presentation, at: new Date().toISOString() }
            : await this.applyRuntimePresentation('hide');
        }
        const life = 'adapterPid=' + this._lastLifecycle.adapterPid + ' supervisorPid=' + this._lastLifecycle.supervisorPid + ' reused=' + this._lastLifecycle.reusedSupervisor + ' reason=' + this._lastLifecycle.launchReason;
        if (!rr.ok && this._lastLifecycle.status !== 'agents-workspace-ready') {
          throw new Error([rr.message || `Cursor lifecycle failed: ${rr.status}`, rr.nextStep].filter(Boolean).join(' '));
        }
        if (this._lastLifecycle.status === 'agents-workspace-ready') {
          console.error(`🪟 Cursor Agents repository ready: ${this._lastLifecycle.projectPath} -> ${this._lastLifecycle.targetId}`);
          return;
        }
        if (rr.status === 'already') {
          console.error('🪟 cursor ensure already: ' + life);
          return;
        }
        if (rr.status === 'port-not-cursor') { console.error('⚠️ ' + rr.message + ' | ' + life); return; }
        console.error('🪟 cursor 自愈拉起：' + (rr.message || rr.status) + ' | ' + life);
      } catch (e) {
        console.error('⚠️ cursor 自愈失败（CCE/委托已中止，避免驱动错误工作区）：', e.message);
        throw e;
      }
      finally { this._healing = null; }
    })();
    return this._healing;
  }
  async _drain() {
    if (this.busy || this.queue.length === 0) return;
    if (this._hasGlobalReservation()) return;
    if (this.queue[0].effectiveExecution !== 'parallel_agent' && this.activeParallel.size > 0) {
      // 由并行任务的明确终态、reap/cancel/abandon 主动唤醒；避免 orphan 时每 400ms 永久空转。
      return;
    }
    this.busy = true;
    const job = this.queue.shift();
    this.currentJob = job;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      await this._withJobLock(job, async () => {
        try {
          if (job.effectiveExecution === 'parallel_agent') {
            job.phase = 'submitting';
            const submitted = await this._withUiLock(() => this._submitParallelAgent(job));
            if (submitted.fallbackReason) {
              job.effectiveExecution = 'fifo';
              job.fallbackReason = submitted.fallbackReason;
              if (this.activeParallel.size > 0) {
                job.status = 'queued';
                job.phase = 'queued';
                this.queue.unshift(job);
                return;
              }
              job.phase = 'running';
              const result = await this._withUiLock(() => this._run(job.prompt, job));
              this._finishJob(job, result);
            } else {
              job.agentId = submitted.agent.id;
              job.agentLabel = submitted.agent.label || null;
              job.sentAt = job.sentAt || new Date().toISOString();
              job.phase = 'running';
              job.reservationScope = job.readOnly ? 'agent' : 'paths';
              if (!this.parallelRestoreAgentId && submitted.previousSelectedId) {
                this.parallelRestoreAgentId = submitted.previousSelectedId;
                this.parallelRestoreTargetId = job.targetId;
              }
              this.activeParallel.set(job.id, job);
              if (job.cancelRequested) {
                this._invalidateParallelMonitor(job);
                job.phase = 'cancelling';
                job.recoveryState = 'stopping_after_binding';
                let stopped;
                try { stopped = await this._stopParallelAgent(job); }
                catch (error) { stopped = { confirmed: false, state: 'stop_error', error: error.message }; }
                if (stopped.confirmed) {
                  job.terminalEvidence = `targeted_stop:${job.agentId}`;
                  this._cancelJob(job, job.cancelReason, { underlyingStopConfirmed: true });
                } else {
                  job.cancelRequested = false;
                  this._orphanParallelJob(job, new Error(`无法确认 Cursor Agent 已停止：${stopped.error || stopped.state}`));
                  job.recoveryState = 'cancel_unconfirmed';
                }
              } else {
                this._startParallelMonitor(job);
              }
            }
          } else {
            job.phase = 'running';
            const result = await this._withUiLock(() => this._run(job.prompt, job));
            this._finishJob(job, result);
          }
        } catch (error) {
          if ((error && error.cancelled) || job.cancelRequested) {
            if (error && error.stopConfirmed) {
              this._cancelJob(job, job.cancelReason || error.message || '任务已取消', {
                underlyingStopConfirmed: true,
              });
            } else {
              job.cancelRequested = false;
              this._orphanParallelJob(job, new Error('已请求取消，但无法确认 Cursor 已停止；占用继续保留'));
              job.recoveryState = 'cancel_unconfirmed';
            }
          } else if (error && error.confirmedTerminal) {
            this.activeParallel.delete(job.id);
            this._failJob(job, error);
          } else if (error && error.sent) {
            job.error = `发送状态不确定，继续按 agentId 监控：${error.message}`;
            if (job.agentId) {
              job.phase = 'running';
              job.reservationScope = job.readOnly ? 'agent' : 'paths';
              this.activeParallel.set(job.id, job);
              this._startParallelMonitor(job);
            } else {
              this._orphanParallelJob(job, error);
            }
          } else {
            this._failJob(job, error);
          }
        }
      });
    } finally {
      if (this.currentJob === job) this.currentJob = null;
      this.busy = false;
      this._drain();
      this._maybeRestoreParallelOrigin();
    }
  }

  async _run(prompt, options = {}) {
    const page = await findPage({
      targetId: options.targetId || (this._lastLifecycle && this._lastLifecycle.targetId),
      purpose: 'fifo',
      preferAgentsV2: true,
    });
    options.targetId = page.id;
    options.targetUiFlavor = page.capabilities && page.capabilities.uiFlavor || options.targetUiFlavor || null;
    const c = makeClient(page.webSocketDebuggerUrl);
    await c.ready;
    try {
      this._throwIfCancelledBeforeSend(options);
      await this._ensureChatPanel(c);
      // 1.5) 开新对话（避免上下文累积 + 回复区干净，extract 不串旧对话）；找不到钮则跳过沿用当前
      if (options.newChat !== false) {
        await this._newChat(c, {
          uiFlavor: options.targetUiFlavor,
          projectPath: options.projectPath || this._lastLifecycle && this._lastLifecycle.projectPath || this.projectPath,
        });
      }
      this._throwIfCancelledBeforeSend(options);
      // 2) 填查询
      const filled = await evalJS(c, exprFill(prompt));
      if (filled === 'NO_INPUT' || filled === 'EXEC_FAIL') throw new Error('填入查询失败（输入框状态异常）');
      await sleep(450);
      this._throwIfCancelledBeforeSend(options);
      let baseline = { messageCount: 0 };
      try { baseline = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch {}
      const providerErrorBaseline = providerErrorSignature(await this._readProviderError(c));
      // 3) Enter 发送
      options.sendState = 'dispatching';
      try {
        await chord(c, 0, 'Enter', 'Enter', 13);
        await this._confirmSubmission(c, baseline.messageCount || 0, providerErrorBaseline);
        options.sendState = 'sent';
        options.sentAt = options.sentAt || new Date().toISOString();
        // 4) 等完成（stop 钮 >0 出现过 → 归 0）
        return await this._waitComplete(
          c,
          options.timeoutMs || QUERY_TIMEOUT,
          baseline.messageCount || 0,
          options,
          providerErrorBaseline,
        );
      } catch (error) {
        if (error && error.confirmedNotSent) {
          options.sendState = 'not_sent';
          throw error;
        }
        // Enter 派发开始后无法证明消息未发送；任何后续异常都必须保守保留全局占用。
        error.sent = true;
        throw error;
      }
    } finally { c.close(); }
  }

  _throwIfCancelledBeforeSend(job) {
    if (!job || !job.cancelRequested || job.sendState === 'dispatching' || job.sendState === 'sent') return;
    const error = new Error(job.cancelReason || '任务已取消');
    error.cancelled = true;
    error.stopConfirmed = true;
    error.preSend = true;
    throw error;
  }

  async _ensureChatPanel(c) {
    let vis = await evalJS(c, EXPR_VISIBLE);
    if (!vis) {
      await chord(c, 2, 'L', 'KeyL', 76);
      await sleep(1300);
      vis = await evalJS(c, EXPR_VISIBLE);
    }
    if (!vis) {
      await chord(c, 2, 'I', 'KeyI', 73);
      await sleep(1300);
      vis = await evalJS(c, EXPR_VISIBLE);
    }
    if (!vis) throw new Error('无法打开 Cursor chat/agent 输入面板。Cursor 是否登录且窗口正常？');
  }

  // 清空对话上下文：定位 "New Agent" 钮后【Alt+click】——Alt 修饰使其执行 Replace Agent（清空旧对话），
  // 而非新建（aria 标注 "New Agent (Ctrl+N) / [Alt] Replace Agent"）。2026-06-08 实测回复区 markdown DOM 清空
  // 2719→17，避免 extract 串旧对话。找不到钮则跳过沿用当前（不阻断查询）。
  async _newChat(c, options = {}) {
    if (options.uiFlavor === 'agents_v2' && options.projectPath) {
      const created = JSON.parse(await evalJS(c, exprCreateAgentForWorkspace(options.projectPath)) || '{}');
      if (!created.ok) {
        const available = Array.isArray(created.available) ? `; available=${created.available.join(', ')}` : '';
        throw new Error(`Cursor Agents workspace binding failed: ${created.state || 'unknown'}; wanted=${created.wanted || basename(options.projectPath)}${available}`);
      }
      await sleep(1100);
      return true;
    }
    return this._clickNewAgent(c, true);
  }

  async _clickNewAgent(c, replaceCurrent) {
    try {
      const pos = await evalJS(c, EXPR_FIND_NEWAGENT);
      if (!pos) return false;
      const { x, y } = JSON.parse(pos);
      const modifiers = replaceCurrent ? 1 : 0;
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
      await sleep(1100);   // 等新对话初始化（输入框重建 + 回复区清空）
      return true;
    } catch { return false; }
  }

  async _ensureHistoryOpen(c) {
    if (await evalJS(c, EXPR_AGENT_ADAPTER_READY)) return true;
    if (await evalJS(c, EXPR_HISTORY_OPEN)) return true;
    const pos = await evalJS(c, EXPR_FIND_HISTORY);
    if (!pos) return false;
    const { x, y } = JSON.parse(pos);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(450);
    return !!(await evalJS(c, EXPR_AGENT_ADAPTER_READY));
  }

  async _closeHistory(c) {
    try {
      if (await evalJS(c, EXPR_HISTORY_OPEN)) {
        await chord(c, 0, 'Escape', 'Escape', 27);
        await sleep(180);
      }
    } catch {}
  }

  async _readAgentEntries(c, keepOpen = false) {
    if (!(await this._ensureHistoryOpen(c))) throw new Error('Cursor Agent 列表适配器不可用');
    try {
      const snapshot = JSON.parse(await evalJS(c, EXPR_HISTORY_ENTRIES));
      if (!snapshot.ok) throw new Error(snapshot.error || 'Agent History React adapter 不可用');
      return snapshot.entries || [];
    } finally {
      if (!keepOpen) await this._closeHistory(c);
    }
  }

  async _confirmSubmission(c, baselineCount = 0, providerErrorBaseline = '') {
    const accepted = async () => {
      await this._throwIfNewProviderError(c, providerErrorBaseline);
      let snap = {};
      try { snap = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch {}
      const inputTextLength = Number(snap.inputTextLength);
      return Number(snap.stop || 0) > 0
        || Number(snap.messageCount || 0) > Number(baselineCount || 0)
        || (Number.isFinite(inputTextLength) && inputTextLength === 0);
    };
    for (let i = 0; i < 6; i++) {
      await sleep(250);
      if (await accepted()) return 'enter';
    }
    const clicked = await evalJS(c, EXPR_CLICK_SEND);
    if (clicked === 'CLICKED') {
      for (let i = 0; i < 20; i++) {
        await sleep(250);
        if (await accepted()) return 'button';
      }
    }
    const error = new Error(`Cursor 未接受提交（submit_not_accepted: ${clicked || 'unknown'}）；提示仍在输入框中，未创建孤儿任务`);
    error.confirmedNotSent = true;
    throw error;
  }

  async _readProviderError(c) {
    const raw = await evalJS(c, EXPR_PROVIDER_ERROR);
    try {
      return JSON.parse(raw || '{"found":false}');
    } catch {
      return { found: false };
    }
  }

  async _throwIfNewProviderError(c, baselineSignature = '') {
    const providerError = await this._readProviderError(c);
    if (!providerError || providerError.found !== true) return;
    const signature = providerErrorSignature(providerError);
    if (baselineSignature && signature === baselineSignature) return;
    throw createProviderError(providerError);
  }

  async _submitParallelAgent(job) {
    const page = await findPage({
      targetId: this._lastLifecycle && this._lastLifecycle.targetId,
      purpose: 'parallel_agent',
      preferAgentsV2: true,
    });
    job.targetId = page.id;
    job.targetUiFlavor = page.capabilities && page.capabilities.uiFlavor || null;
    const c = makeClient(page.webSocketDebuggerUrl);
    await c.ready;
    let sent = false;
    try {
      this._throwIfCancelledBeforeSend(job);
      await this._ensureChatPanel(c);
      let before;
      try {
        before = await this._readAgentEntries(c);
      } catch (e) {
        return { fallbackReason: `parallel_agent 前置能力不可用：${e.message}` };
      }
      const previousSelectedId = (before.find((e) => e.isSelected) || {}).id || null;
      this._throwIfCancelledBeforeSend(job);
      const createdForWorkspace = job.targetUiFlavor === 'agents_v2' && job.projectPath
        ? await this._newChat(c, { uiFlavor: job.targetUiFlavor, projectPath: job.projectPath })
        : await this._clickNewAgent(c, false);
      if (!createdForWorkspace) {
        return { fallbackReason: '找不到 Cursor New Agent 按钮，已在发送前降级 FIFO' };
      }

      let agent = null;
      // 大多数 Cursor 版本在点击 New Agent 后即登记 local:<UUID>；先在发送前绑定身份。
      for (let i = 0; i < 5 && !agent; i++) {
        try { agent = selectNewAgentEntry(before, await this._readAgentEntries(c)); } catch {}
        if (!agent) await sleep(350);
      }
      if (agent) {
        job.agentId = agent.id;
        job.agentLabel = agent.label || null;
      }

      await this._closeHistory(c);
      await this._ensureChatPanel(c);
      this._throwIfCancelledBeforeSend(job);
      const filled = await evalJS(c, exprFill(job.prompt));
      if (filled === 'NO_INPUT' || filled === 'EXEC_FAIL') throw new Error('parallel_agent 填入任务失败');
      await sleep(350);
      this._throwIfCancelledBeforeSend(job);
      const providerErrorBaseline = providerErrorSignature(await this._readProviderError(c));
      let baseline = { messageCount: 0 };
      try { baseline = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch {}
      job.sendState = 'dispatching';
      await chord(c, 0, 'Enter', 'Enter', 13);
      await this._confirmSubmission(c, baseline.messageCount || 0, providerErrorBaseline);
      sent = true;
      job.sendState = 'sent';
      job.sentAt = new Date().toISOString();

      // Cursor 3.7 可能只在首次消息发送后才把 composer 登记进 Agent History。
      // 新版还会先登记 draft；只有进入 running/terminal 状态才算发送确认。若同时出现新的
      // provider error tray，则这是明确失败终态，释放占用但不自动重试。
      agent = null;
      for (let i = 0; i < 24 && !agent; i++) {
        await sleep(350);
        await this._throwIfNewProviderError(c, providerErrorBaseline);
        try {
          const candidate = selectNewAgentEntry(before, await this._readAgentEntries(c));
          if (candidate && (
            candidate.showSpinner
            || classifyParallelTerminalIcon(candidate.icon) !== 'unknown'
          )) agent = candidate;
        } catch {}
      }
      if (!agent) {
        const e = new Error('任务可能已发送，但无法从 Agent History 捕获唯一 agentId；已保留占用，禁止自动重发');
        e.sent = true;
        throw e;
      }
      job.agentId = agent.id;
      job.agentLabel = agent.label || null;
      return { agent, previousSelectedId };
    } catch (e) {
      if (sent) e.sent = true;
      throw e;
    } finally {
      await this._closeHistory(c);
      c.close();
    }
  }

  async _readParallelEntry(job) {
    return this._withUiLock(async () => {
      const page = await findPage({ targetId: job.targetId, purpose: 'parallel_agent' });
      const c = makeClient(page.webSocketDebuggerUrl);
      await c.ready;
      try {
        const entries = await this._readAgentEntries(c);
        return entries.find((e) => e.id === job.agentId) || null;
      } finally { c.close(); }
    });
  }

  _startParallelMonitor(job) {
    if (isTerminalTask(job) || !this.activeParallel.has(job.id) || job.monitorPromise) return false;
    const generation = Number(job.monitorGeneration || 0) + 1;
    job.monitorGeneration = generation;
    job.monitorAttached = true;
    let monitorPromise;
    monitorPromise = this._monitorParallelAgent(job, generation)
      .catch((error) => this._withJobLock(job, async () => {
        if (!this._monitorOwns(job, generation)) return;
        this._failParallelJob(job, error);
      }))
      .finally(() => {
        if (job.monitorPromise === monitorPromise) {
          job.monitorPromise = null;
          job.monitorAttached = false;
        }
      });
    job.monitorPromise = monitorPromise;
    return true;
  }

  async _monitorParallelAgent(job, generation) {
    const started = Date.now();
    let sawGenerating = false;
    let completedStable = 0;
    let missingPolls = 0;
    let transientErrors = 0;
    let terminalErrorStable = 0;
    let lastTerminalErrorSignature = '';
    let collectionAttempts = 0;
    let lastCollectionError = '';
    while (Date.now() - started < job.timeoutMs) {
      if (!this._monitorOwns(job, generation)) return;
      await sleep(1400);
      if (!this._monitorOwns(job, generation)) return;
      let entry;
      try {
        entry = await this._readParallelEntry(job);
        if (!this._monitorOwns(job, generation)) return;
        transientErrors = 0;
      } catch (e) {
        transientErrors++;
        // Cursor 切换 Agent、收起侧栏或 History 菜单重渲染时可能短暂不可读。
        // 保留约一分钟恢复窗口；超出后进入 needs_attention，绝不把已发送任务自动重发。
        if (transientErrors >= 45) throw new Error(`连续无法读取 Agent History：${e.message}`);
        continue;
      }
      if (!entry) {
        missingPolls++;
        if (missingPolls >= 45) throw new Error(`Agent History 中持续丢失 ${job.agentId}`);
        continue;
      }
      missingPolls = 0;
      if (entry.showSpinner) {
        sawGenerating = true;
        completedStable = 0;
        terminalErrorStable = 0;
        lastTerminalErrorSignature = '';
        continue;
      }
      const terminalClass = classifyParallelTerminalIcon(entry.icon);
      if (terminalClass === 'failed' || terminalClass === 'cancelled' || terminalClass === 'needs_attention') {
        const stableError = updateStableEntryObservation(lastTerminalErrorSignature, terminalErrorStable, entry);
        terminalErrorStable = stableError.count;
        lastTerminalErrorSignature = stableError.signature;
        completedStable = 0;
        if (terminalErrorStable >= 2) {
          if (terminalClass === 'needs_attention') {
            throw new Error(`Cursor Agent ${job.agentId} 正在等待用户处理`);
          }
          if (terminalClass === 'cancelled') {
            await this._withJobLock(job, async () => {
              if (!this._monitorOwns(job, generation)) return;
              job.terminalEvidence = `stable_history_icon:${entry.icon}`;
              this._cancelJob(job, `Cursor Agent ${job.agentId} 已显示稳定取消终态`, {
                underlyingStopConfirmed: true,
              });
            });
            return;
          }
          const error = new Error(`Cursor Agent ${job.agentId} 显示稳定失败状态 ${entry.icon}`);
          error.confirmedTerminal = true;
          throw error;
        }
        continue;
      }
      terminalErrorStable = 0;
      lastTerminalErrorSignature = '';
      const completedIcon = terminalClass === 'completed';
      if (completedIcon) {
        completedStable++;
        // 极短任务可能在首次轮询前已完成；此时以两次稳定完成状态替代 sawGenerating。
        if (sawGenerating || completedStable >= 2) {
          const outcome = await this._withJobLock(job, async () => {
            if (!this._monitorOwns(job, generation)) return 'stale';
            job.phase = 'collecting';
            try {
              const result = await this._withUiLock(() => this._collectParallelAgent(job));
              if (!this._monitorOwns(job, generation)) return 'stale';
              job.error = null;
              job.terminalEvidence = `stable_history_icon:${entry.icon}`;
              this.activeParallel.delete(job.id);
              this._finishJob(job, result);
              this._drain();
              this._maybeRestoreParallelOrigin();
              return 'completed';
            } catch (error) {
              if (!this._monitorOwns(job, generation)) return 'stale';
              collectionAttempts++;
              lastCollectionError = error.message;
              job.error = `第 ${collectionAttempts} 次回收未完成，继续重试：${error.message}`;
              job.phase = 'running';
              return 'retry';
            }
          });
          if (outcome === 'completed' || outcome === 'stale') return;
          completedStable = 0;
          await sleep(1200);
          continue;
        }
      } else {
        completedStable = 0;
      }
    }
    if (!this._monitorOwns(job, generation)) return;
    const detail = lastCollectionError ? `；最后回收错误：${lastCollectionError}` : '';
    throw new Error(`Cursor parallel_agent 任务超时 (${job.timeoutMs}ms)${detail}`);
  }

  async _waitForSelectedAgent(c, agentId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entries = await this._readAgentEntries(c);
      const target = entries.find((e) => e.id === agentId);
      if (target && target.isSelected) return true;
      await sleep(250);
    }
    throw new Error(`打开 ${agentId} 后未确认其成为当前选中 Agent`);
  }

  async _collectParallelAgent(job) {
    const page = await findPage({ targetId: job.targetId, purpose: 'parallel_agent' });
    const c = makeClient(page.webSocketDebuggerUrl);
    await c.ready;
    let previousSelectedId = null;
    try {
      const entries = await this._readAgentEntries(c, true);
      previousSelectedId = (entries.find((e) => e.isSelected) || {}).id || null;
      const opened = await evalJS(c, exprOpenAgent(job.agentId));
      if (opened !== 'OPENED') throw new Error(`无法打开 ${job.agentId}: ${opened}`);
      await this._closeHistory(c);
      await this._waitForSelectedAgent(c, job.agentId);

      let answer = '';
      let lastKey = '';
      let stable = 0;
      // Agent History 已给出完成图标，但打开会话后的 Markdown/虚拟列表仍可能延迟挂载。
      // 给视图约 24 秒稳定时间，并允许只有一个可见 Markdown（常见于用户 prompt 不是 markdown 的情况）。
      for (let i = 0; i < 80; i++) {
        let snap = { messageCount: 0, replyLength: 0, replyHash: 0 };
        try { snap = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch {}
        const candidate = String(await evalJS(c, EXPR_EXTRACT) || '').trim();
        if (candidate && Number(snap.stop || 0) === 0) {
          const key = `${snap.replyLength}:${snap.replyHash}`;
          if (key === lastKey) stable++; else { lastKey = key; stable = 0; }
          if (stable >= 1) { answer = candidate; break; }
        }
        await sleep(300);
      }
      if (!answer) throw new Error(`已打开 ${job.agentId}，但未找到助手最终回复`);

      if (previousSelectedId && previousSelectedId !== job.agentId) {
        if (await this._ensureHistoryOpen(c)) {
          await evalJS(c, exprOpenAgent(previousSelectedId));
          await this._closeHistory(c);
          await this._waitForSelectedAgent(c, previousSelectedId);
        }
      }
      return answer;
    } finally {
      await this._closeHistory(c);
      c.close();
    }
  }

  _reapWithoutResult(job, error, evidence) {
    if (isTerminalTask(job)) return;
    const message = error instanceof Error ? error.message : String(error || 'Cursor Agent 已终止，但最终回复无法回收');
    job.status = 'needs_attention';
    job.phase = 'orphaned';
    job.finishedAt = null;
    job.error = message;
    job.result = null;
    job.resultUnavailable = true;
    job.terminalEvidence = evidence || 'stable_completed_history_icon';
    job.recoveryState = 'terminal_result_uncollected';
    job.reservationScope = job.readOnly ? 'agent' : 'paths';
  }

  _abandonJob(job, reason) {
    if (isTerminalTask(job)) return this._taskView(job, true);
    const message = String(reason || '').trim();
    this._invalidateParallelMonitor(job);
    this.queue = this.queue.filter((candidate) => candidate.id !== job.id);
    this.activeParallel.delete(job.id);
    job.status = 'abandoned';
    job.phase = 'abandoned';
    job.finishedAt = new Date().toISOString();
    job.error = message;
    job.cancelReason = message;
    job.underlyingStopConfirmed = false;
    job.terminalEvidence = 'explicit_abandon_acknowledgement';
    job.recoveryState = 'released_unconfirmed';
    job.reservationScope = null;
    if (!job.settled) {
      job.settled = true;
      job.reject(new Error(message));
    }
    this._drain();
    this._maybeRestoreParallelOrigin();
    return this._taskView(job, true);
  }

  async _readStableParallelEntry(job) {
    let first;
    let second;
    try {
      first = await this._readParallelEntry(job);
      await sleep(300);
      second = await this._readParallelEntry(job);
    } catch (error) {
      job.lastRecoveryAt = new Date().toISOString();
      job.recoveryState = 'history_unavailable';
      job.error = `重新检查 Agent History 失败：${error.message}`;
      return { stable: false, error: error.message, entry: null };
    }
    job.lastRecoveryAt = new Date().toISOString();
    if (!first || !second) {
      job.recoveryState = 'agent_missing';
      return { stable: false, error: 'Agent History 中未找到绑定的 agentId', entry: second || first || null };
    }
    const stable = first.id === second.id
      && first.showSpinner === second.showSpinner
      && String(first.icon || '') === String(second.icon || '');
    return { stable, entry: second, error: stable ? null : 'Agent History 状态尚未稳定' };
  }

  async _reapParallelJob(job, options = {}) {
    if (!job) return { changed: false, state: 'missing', task: null };
    return this._withJobLock(job, () => this._reapParallelJobLocked(job, options));
  }

  async _reapParallelJobLocked(job, options = {}) {
    if (!job || isTerminalTask(job)) return { changed: false, state: 'terminal', task: this._taskView(job, true) };
    if (job.execution !== 'parallel_agent' || !this.activeParallel.has(job.id)) {
      return { changed: false, state: 'not_parallel_reservation', task: this._taskView(job, true) };
    }
    if (!job.agentId) {
      job.lastRecoveryAt = new Date().toISOString();
      job.recoveryState = 'unbound_agent';
      return { changed: false, state: 'unbound_agent', task: this._taskView(job, true) };
    }

    // 显式 reconcile 接管该任务；使所有旧 monitor generation 失效，避免旧 catch/finally 覆盖本次结论。
    this._invalidateParallelMonitor(job);

    const observed = await this._readStableParallelEntry(job);
    if (!observed.stable || !observed.entry) {
      return { changed: false, state: job.recoveryState || 'unstable', error: observed.error, task: this._taskView(job, true) };
    }
    const entry = observed.entry;
    const icon = String(entry.icon || '');
    if (entry.showSpinner) {
      job.status = 'running';
      job.phase = 'running';
      job.error = null;
      job.recoveryState = 'monitoring';
      const attached = options.reattach !== false && !job.cancelRequested && this._startParallelMonitor(job);
      return { changed: attached, state: 'running', monitorReattached: attached, task: this._taskView(job, true) };
    }
    const terminalClass = classifyParallelTerminalIcon(icon);
    if (terminalClass === 'cancelled') {
      job.terminalEvidence = `stable_history_icon:${icon || 'cancelled'}`;
      const task = this._cancelJob(job, `Cursor Agent ${job.agentId} 已显示取消终态`, { underlyingStopConfirmed: true });
      return { changed: true, state: 'cancelled', task };
    }
    if (terminalClass === 'failed') {
      const error = new Error(`Cursor Agent ${job.agentId} 显示稳定失败状态 ${icon}`);
      job.terminalEvidence = `stable_history_icon:${icon}`;
      this.activeParallel.delete(job.id);
      this._failJob(job, error);
      this._drain();
      this._maybeRestoreParallelOrigin();
      return { changed: true, state: 'failed', task: this._taskView(job, true) };
    }
    if (terminalClass === 'completed') {
      job.phase = 'collecting';
      try {
        const result = await this._withUiLock(() => this._collectParallelAgent(job));
        job.error = null;
        job.terminalEvidence = `stable_history_icon:${icon}`;
        this.activeParallel.delete(job.id);
        this._finishJob(job, result);
        this._drain();
        this._maybeRestoreParallelOrigin();
        return { changed: true, state: 'completed', task: this._taskView(job, true) };
      } catch (error) {
        this._reapWithoutResult(job, error, `stable_history_icon:${icon}`);
        return {
          changed: false,
          state: 'terminal_uncollected',
          error: error.message,
          next: '底层 Agent 已显示稳定完成，但最终回复尚未取回；可再次 reap 重试，或在接受丢失回复时显式 abandon。',
          task: this._taskView(job, true),
        };
      }
    }
    job.status = 'needs_attention';
    job.phase = 'orphaned';
    job.recoveryState = 'idle_unconfirmed';
    return { changed: false, state: 'idle_unconfirmed', task: this._taskView(job, true) };
  }

  async _stopParallelAgent(job) {
    if (!job.agentId) return { confirmed: false, state: 'unbound_agent' };
    return this._withUiLock(async () => {
      const page = await findPage({ targetId: job.targetId, purpose: 'parallel_agent' });
      const c = makeClient(page.webSocketDebuggerUrl);
      await c.ready;
      let previousSelectedId = null;
      try {
        const entries = await this._readAgentEntries(c, true);
        const target = entries.find((entry) => entry.id === job.agentId);
        previousSelectedId = (entries.find((entry) => entry.isSelected) || {}).id || null;
        if (!target) return { confirmed: false, state: 'agent_missing' };
        if (!target.showSpinner) return { confirmed: false, clicked: false, state: 'target_not_generating', icon: target.icon || null };
        const opened = await evalJS(c, exprOpenAgent(job.agentId));
        if (opened !== 'OPENED') return { confirmed: false, state: opened || 'open_failed' };
        await this._closeHistory(c);
        await this._waitForSelectedAgent(c, job.agentId);
        const selectedEntries = await this._readAgentEntries(c, true);
        const selected = selectedEntries.filter((entry) => entry.isSelected);
        const selectedTarget = selected.length === 1 && selected[0].id === job.agentId
          ? selected[0]
          : null;
        if (!selectedTarget || !selectedTarget.showSpinner) {
          return { confirmed: false, clicked: false, state: 'selected_agent_not_generating' };
        }
        let clickResult;
        try { clickResult = JSON.parse(await evalJS(c, exprClickSelectedAgentStop(job.agentId))); }
        catch (error) { clickResult = { clicked: false, state: 'stop_evaluate_failed', error: error.message }; }
        await this._closeHistory(c);
        if (!clickResult.clicked) return { confirmed: false, ...clickResult };

        let stableTerminal = 0;
        let lastSignature = '';
        let finalTarget = null;
        for (let i = 0; i < 24; i++) {
          await sleep(250);
          try {
            const afterEntries = await this._readAgentEntries(c);
            finalTarget = afterEntries.find((entry) => entry.id === job.agentId) || null;
          } catch {
            finalTarget = null;
          }
          const icon = String(finalTarget && finalTarget.icon || '');
          const terminal = !!finalTarget
            && !finalTarget.showSpinner
            && /circle-slash|cancel|check-circled|check|error|failed|warning/i.test(icon);
          const signature = terminal ? `${finalTarget.id}:${icon}` : '';
          if (terminal && signature === lastSignature) stableTerminal++; else stableTerminal = terminal ? 1 : 0;
          lastSignature = signature;
          if (stableTerminal >= 2) break;
        }
        const confirmed = isTargetedStopConfirmed(clickResult, stableTerminal);
        return {
          confirmed,
          clicked: true,
          state: confirmed ? 'stopped' : finalTarget ? 'stop_unconfirmed' : 'agent_missing_after_stop',
          icon: finalTarget && finalTarget.icon,
          click: clickResult,
        };
      } finally {
        try {
          if (previousSelectedId && previousSelectedId !== job.agentId && await this._ensureHistoryOpen(c)) {
            await evalJS(c, exprOpenAgent(previousSelectedId));
            await this._closeHistory(c);
            await this._waitForSelectedAgent(c, previousSelectedId);
          }
        } catch {}
        await this._closeHistory(c);
        c.close();
      }
    });
  }

  async taskControl(taskId, options = {}) {
    const id = String(taskId || '').trim();
    if (!id) throw new Error('task_id 不能为空');
    const job = this.tasks.get(id);
    if (!job) return { found: false, taskId: id };
    const action = String(options.action || 'reap').trim().toLowerCase();
    if (!['reap', 'cancel', 'abandon'].includes(action)) {
      throw new Error(`不支持 action=${action}；只能是 reap、cancel 或 abandon`);
    }
    const reason = String(options.reason || '').trim();
    const expectedAgentId = String(options.expectedAgentId || '').trim();
    if (action !== 'reap' && options.confirm !== true) throw new Error(`${action} 需要 confirm=true`);
    const submittingCancelWithoutPublishedId = action === 'cancel'
      && job.phase === 'submitting'
      && !expectedAgentId;
    if (job.agentId && action !== 'reap' && !submittingCancelWithoutPublishedId && expectedAgentId !== job.agentId) {
      throw new Error(`expected_agent_id 不匹配；任务绑定的是 ${job.agentId}`);
    }
    // cancel latch 必须在第一个 await 之前写入，避免 submitting 期间等待 job lock 而错过发送前门禁。
    if (action === 'cancel' && !isTerminalTask(job)) {
      job.cancelRequested = true;
      job.cancelReason = reason || (job.execution === 'parallel_agent' ? '用户请求取消 Cursor Agent' : '用户请求取消 FIFO 任务');
      job.cancelRequestSeq = Number(job.cancelRequestSeq || 0) + 1;
    }
    return this._withJobLock(job, () => this._taskControlLocked(job, action, {
      ...options,
      reason,
      expectedAgentId,
    }));
  }

  async _taskControlLocked(job, action, options) {
    if (action === 'reap') {
      const result = await this._reapParallelJobLocked(job, { reattach: true });
      if (result.state === 'not_parallel_reservation' && job.phase === 'orphaned') {
        result.next = 'FIFO 孤儿没有可安全重绑的 agentId；请先在 Cursor UI 人工确认已停止，再显式 abandon。';
      }
      return { found: true, action, ...result };
    }
    if (isTerminalTask(job)) {
      return { found: true, action, changed: false, state: job.status, alreadyTerminal: true, task: this._taskView(job, true) };
    }

    if (action === 'abandon') {
      if (options.acknowledgeMayStillWrite !== true) {
        throw new Error('abandon 需要 acknowledge_may_still_write=true');
      }
      if (!options.reason) throw new Error('abandon 必须提供非空 reason');
      if (job.phase !== 'orphaned' && job.phase !== 'cancelling' && job.status !== 'needs_attention') {
        throw new Error('abandon 只允许用于 needs_attention/orphaned/cancelling 任务');
      }
      return {
        found: true,
        action,
        changed: true,
        state: 'abandoned',
        warning: 'Bridge 已释放占用，但无法证明底层 Cursor Agent 已停止；它仍可能继续写文件。',
        task: this._abandonJob(job, options.reason),
      };
    }

    if (job.status === 'queued') {
      return {
        found: true,
        action,
        changed: true,
        state: 'cancelled',
        task: this._cancelJob(job, options.reason || '排队任务已取消', { underlyingStopConfirmed: true }),
      };
    }
    if (job.phase === 'orphaned' && (!job.agentId || job.effectiveExecution === 'fifo')) {
      job.cancelRequested = false;
      return {
        found: true,
        action,
        changed: false,
        state: 'cancel_unconfirmed',
        next: '任务已进入无可安全定向身份的孤儿状态，并继续保留全局占用。请先在 Cursor UI 人工确认已停止，再显式 abandon。',
        task: this._taskView(job, true),
      };
    }
    if (job.phase === 'submitting') {
      job.phase = 'cancelling';
      job.recoveryState = job.sendState === 'dispatching' || job.sendState === 'sent'
        ? 'cancel_pending_binding'
        : 'cancel_pending_submission';
      return {
        found: true,
        action,
        changed: true,
        state: job.recoveryState,
        next: 'Bridge 已锁存取消请求；发送前会中止，若消息已发出则会先绑定 agentId 再定向停止。',
        task: this._taskView(job, true),
      };
    }
    if (job.execution === 'parallel_agent') {
      this._invalidateParallelMonitor(job);
      const reaped = await this._reapParallelJobLocked(job, { reattach: false });
      if (isTerminalTask(job)) return { found: true, action, ...reaped };
      job.phase = 'cancelling';
      job.recoveryState = 'stopping';
      let stopped;
      try { stopped = await this._stopParallelAgent(job); }
      catch (error) { stopped = { confirmed: false, state: 'stop_error', error: error.message }; }
      if (isTerminalTask(job)) {
        return {
          found: true,
          action,
          changed: false,
          state: job.status,
          stop: stopped,
          task: this._taskView(job, true),
        };
      }
      if (stopped.confirmed) {
        job.terminalEvidence = `targeted_stop:${job.agentId}`;
        return {
          found: true,
          action,
          changed: true,
          state: 'cancelled',
          stop: stopped,
          task: this._cancelJob(job, job.cancelReason, { underlyingStopConfirmed: true }),
        };
      }
      job.status = 'needs_attention';
      job.phase = 'orphaned';
      job.cancelRequested = false;
      job.recoveryState = 'cancel_unconfirmed';
      job.error = `无法确认 Cursor Agent 已停止：${stopped.error || stopped.state}`;
      return {
        found: true,
        action,
        changed: false,
        state: 'cancel_unconfirmed',
        stop: stopped,
        next: '确认 Cursor UI 已停止后，可再次 cancel；只有明确承担风险时才使用 abandon。',
        task: this._taskView(job, true),
      };
    }

    job.phase = 'cancelling';
    job.recoveryState = 'cancel_pending_fifo';
    return {
      found: true,
      action,
      changed: true,
      state: 'cancel_pending_fifo',
      next: 'FIFO 没有可安全定向的 agentId；Bridge 不会模糊点击 Stop。任务会转为全局孤儿占用，人工确认停止后再 abandon。',
      task: this._taskView(job, true),
    };
  }

  _failParallelJob(job, error) {
    if (isTerminalTask(job)) return;
    if (error && error.confirmedTerminal) {
      this.activeParallel.delete(job.id);
      this._failJob(job, error);
      this._drain();
      this._maybeRestoreParallelOrigin();
      return;
    }
    this._orphanParallelJob(job, error);
  }

  _maybeRestoreParallelOrigin() {
    if (!this.parallelRestoreAgentId || this.busy || this.activeParallel.size > 0 ||
        this.queue.some((job) => job.execution === 'parallel_agent')) return;
    const agentId = this.parallelRestoreAgentId;
    const targetId = this.parallelRestoreTargetId;
    this.parallelRestoreAgentId = null;
    this.parallelRestoreTargetId = null;
    this._withUiLock(async () => {
      const page = await findPage({ targetId, purpose: 'parallel_agent' });
      const c = makeClient(page.webSocketDebuggerUrl);
      await c.ready;
      try {
        if (await this._ensureHistoryOpen(c)) {
          await evalJS(c, exprOpenAgent(agentId));
          await sleep(450);
        }
      } finally {
        await this._closeHistory(c);
        c.close();
      }
    }).catch((e) => console.error('⚠️ 恢复原 Cursor Agent 失败：' + e.message));
  }

  async _waitComplete(c, timeoutMs = QUERY_TIMEOUT, baselineCount = 0, job = null, providerErrorBaseline = '') {
    const start = Date.now();
    const INTERVAL = 1000;
    let sawStop = false;        // 观察到生成中（stop 钮出现过）
    let lastReplyKey = '', stableReply = 0;
    await sleep(1200);          // 给发送后 stop 钮起来留时间
    while (Date.now() - start < timeoutMs) {
      await this._throwIfNewProviderError(c, providerErrorBaseline);
      if (job && job.cancelRequested) {
        // FIFO 没有稳定 agentId；禁止用宽泛 Stop/Cancel 选择器猜测性点击其他会话或工作台控件。
        const e = new Error(job.cancelReason || '任务已取消');
        e.cancelled = true;
        e.stopConfirmed = false;
        throw e;
      }
      let s;
      try { s = JSON.parse(await evalJS(c, EXPR_SNAP)); }
      catch { s = { stop: 0, messageCount: 0, replyLength: 0, replyHash: 0 }; }
      if (s.stop > 0) sawStop = true;

      // 主路径：确认生成过、停止钮归零且存在非空回复；不再硬编码回复长度。
      if (sawStop && s.stop === 0 && s.replyLength > 0) {
        await sleep(800);      // 宽限：最后一次 DOM 追加
        const ans = await evalJS(c, EXPR_EXTRACT);
        if (ans) return ans;
      }
      // 兜底：没采到 stop 时，必须比发送前多出用户+助手两条消息，并且最后回复稳定。
      if (!sawStop && s.messageCount >= baselineCount + 2 && s.replyLength > 0) {
        const key = `${s.replyLength}:${s.replyHash}`;
        if (key === lastReplyKey) {
          stableReply++;
          if (stableReply >= 4) {
            const ans = await evalJS(c, EXPR_EXTRACT);
            if (ans) return ans;
          }
        } else {
          stableReply = 0;
          lastReplyKey = key;
        }
      }
      await sleep(INTERVAL);
    }
    // 超时边界仍需确认当前已停止生成。仅有半截 Markdown、曾见过 Stop 或消息数增长都不够。
    let finalSnap = null;
    try { finalSnap = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch {}
    const ans = await evalJS(c, EXPR_EXTRACT);
    if (isConfirmedCompletedReply({
      answer: ans,
      snapshot: finalSnap,
      sawStop,
      baselineCount,
    })) return ans;
    const taskHint = job && job.id
      ? `；task_id=${job.id}，请用 cursor_status(task_id) 检查并按恢复流程处理`
      : '';
    throw new Error(`Cursor 任务超时 (${timeoutMs}ms)，尚未确认生成已停止并产生完整助手回复${taskHint}`);
  }

  _taskView(job, includeResult = false) {
    const view = {
      taskId: job.id,
      kind: job.kind,
      status: job.status,
      phase: job.phase,
      execution: job.execution,
      effectiveExecution: job.effectiveExecution,
      readOnly: job.readOnly,
      allowedPaths: job.allowedPaths,
      projectPath: job.projectPath,
      agentId: job.agentId,
      agentLabel: job.agentLabel,
      targetId: job.targetId,
      targetUiFlavor: job.targetUiFlavor,
      fallbackReason: job.fallbackReason,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      sentAt: job.sentAt,
      finishedAt: job.finishedAt,
      error: job.error,
      cancelRequested: job.cancelRequested,
      cancelReason: job.cancelReason,
      underlyingStopConfirmed: job.underlyingStopConfirmed,
      orphanedAt: job.orphanedAt,
      lastRecoveryAt: job.lastRecoveryAt,
      recoveryState: job.recoveryState,
      monitorAttached: job.monitorAttached,
      monitorGeneration: job.monitorGeneration,
      resultUnavailable: job.resultUnavailable,
      terminalEvidence: job.terminalEvidence,
      providerError: job.providerError,
      sendState: job.sendState,
      reservationScope: job.reservationScope,
      reservationHeld: this.activeParallel.has(job.id),
      blocksFifo: this.activeParallel.has(job.id) && !isTerminalTask(job),
      blocksAll: this.activeParallel.has(job.id) && !isTerminalTask(job) && job.reservationScope === 'global',
    };
    if (includeResult || isTerminalTask(job)) view.result = job.result;
    if (job.phase === 'orphaned') {
      if (job.recoveryState === 'terminal_result_uncollected') {
        view.attention = 'Agent History 已证明底层任务结束，但最终回复尚未取回；再次 reap 重试，或在接受丢失回复时显式 abandon。';
      } else {
        view.attention = job.execution === 'parallel_agent' && job.agentId
          ? '用 cursor_task_control(action=reap) 显式重查原 agentId；需要停止时用 cancel；只有已人工确认且接受残余写入风险时才 abandon。'
          : '该孤儿没有可安全重绑的 agentId，并全局阻断新委托；请先在 Cursor UI 人工确认已停止，再用 cursor_task_control(action=abandon) 显式释放。';
      }
    }
    return view;
  }

  _trimTasks() {
    if (this.tasks.size <= 50) return;
    for (const [id, job] of this.tasks) {
      if (isTerminalTask(job)) this.tasks.delete(id);
      if (this.tasks.size <= 50) break;
    }
  }

  async status(taskId = '') {
    if (taskId) {
      const job = this.tasks.get(String(taskId));
      if (!job) return { found: false, taskId: String(taskId), ...this.workspaceView(), ...this.delegationView(), ...this.runtimeModeView() };
      return { found: true, ...this.workspaceView(), ...this.delegationView(), ...this.runtimeModeView(), ...this._taskView(job, true) };
    }
    const parallelRunning = this.activeParallel.size;
    const uiBusy = this.busy;
    const globalBlocked = this._hasGlobalReservation();
    const common = {
      ...this.workspaceView(),
      ...this.delegationView(),
      ...this.runtimeModeView(),
      busy: uiBusy || parallelRunning > 0 || this.queue.length > 0,
      uiBusy,
      parallelRunning,
      idle: !uiBusy && parallelRunning === 0 && this.queue.length === 0,
      queued: this.queue.length,
      blockingTaskIds: [...this.activeParallel.values()].filter((job) => !isTerminalTask(job)).map((job) => job.id),
      globallyBlocked: globalBlocked,
      blockedQueuedCount: this.activeParallel.size > 0
        ? this.queue.filter((job) => globalBlocked || job.effectiveExecution !== 'parallel_agent').length
        : 0,
      activeParallel: [...this.activeParallel.values()].map((job) => this._taskView(job)),
      recentTasks: [...this.tasks.values()].slice(-10).map((job) => this._taskView(job)),
      cdpPort: CDP_PORT,
      lifecycle: this._lastLifecycle || {
        adapterPid: process.pid,
        supervisorPid: null,
        reusedSupervisor: null,
        createdSupervisor: null,
        launchReason: null,
        status: null,
        spawnMethod: null,
        cursorPid: null,
        runtimeMode: this.runtimeMode,
        presentation: null,
      },
    };
    try {
      const ver = await httpJson('/json/version');
      const page = await findPage();
      return { connected: true, ...common, browser: ver.Browser, page: (page.url || '').slice(0, 60) };
    } catch (e) {
      return { connected: false, ...common, error: e.message };
    }
  }
}

function buildSearchInputSchema() {
  return {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Describe the behavior, concept, symbol relationship, or ownership boundary to locate. State intent instead of guessing a directory.' },
    },
    required: ['query'],
  };
}

function buildToolDefinitions(bridgeInstance) {
  return [
    {
      name: 'cursor_init',
      description:
        'Initialize or reinitialize CCE for one local workspace. Give only the project path: Bridge saves it, finds Cursor, ensures the required connection, and opens or verifies the matching project. ' +
        'If Cursor was opened too early without CCE access, initialization safely keeps the binding and tells the user to save, close Cursor once, and repeat the same initialization sentence; it never force-closes Cursor. ' +
        'Cursor login and the user\'s old/new UI preference are preserved. When both UIs are open, Bridge selects the new Agents Window and creates work in the matching repository instead of Home.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute local project directory or .code-workspace path. Re-run initialization with another path to switch workspaces.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'cursor_context_engine',
      description:
        'Use this evidence-driven, read-only Cursor Context Engine (CCE) when understanding an indexed project requires discovering an unknown implementation location or tracing behavior, symbols, callers/callees, data flow, registrations, interface implementations, ownership boundaries, or cross-module relationships. Skip it when a known exact file or symbol can answer the question through direct reading or exact search, the needed code is already in context, or the task is only editing, tests, logs, builds, Git work, or external documentation. Cursor autonomously chooses the necessary investigation depth and its available semantic retrieval, exact search, symbol/reference tracing, targeted source reading, or Explore capabilities; the caller supplies one natural-language intent, not a harness recipe. ' +
        'It follows simple locations quickly and continues through call chains, data flows, registrations, interfaces, or cross-module relationships only when the question requires them, stopping at minimum sufficient context. Results return compact verifiable workspace-relative path:line evidence, distinguish proven relationships from semantic similarity and gaps, and say NOT_FOUND instead of guessing from framework convention. ' +
        'Search is serialized through Cursor UI automation and can take several minutes on large or cold workspaces. Read-only behavior is strongly prompted and audited in the result contract, but it is not a filesystem sandbox.',
      inputSchema: buildSearchInputSchema(),
    },
    bridgeInstance.environmentDelegationMode !== 'off' ? {
      name: 'cursor_do',
      description:
        'Give Cursor a clearly bounded task and get back a task ID. fifo means first in, first out: Bridge runs one queued task at a time, starting it in a clean chat. parallel_agent creates a separate top-level Cursor Agent. ' +
        'Parallel write tasks must declare non-overlapping allowed_paths; mark read-only work with read_only=true. ' +
        'Collect the result with cursor_status(task_id). Cursor can do the work, but the main agent still owns review and final verification. A direct user opt-out always wins.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task Cursor should receive. State the goal, boundaries, and what a complete result looks like.' },
          background: { type: 'boolean', default: true, description: 'When true, return the task ID immediately. When false, wait for the task to finish or need attention.' },
          execution: { type: 'string', enum: ['fifo', 'parallel_agent'], default: 'fifo', description: 'fifo is the first-in, first-out serial queue and runs one task at a time in a clean chat. parallel_agent creates a separate top-level Cursor Agent.' },
          read_only: { type: 'boolean', default: false, description: 'Set true when Cursor must not change the workspace.' },
          timeout_ms: { type: 'integer', minimum: 30000, maximum: 900000, default: 600000, description: 'How long to wait before timing out, in milliseconds. The default is 10 minutes.' },
          allowed_paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths Cursor may write. Parallel write tasks require non-overlapping paths. This declaration is not a filesystem sandbox.' },
          completion_contract: { type: 'string', description: 'Optional acceptance checks or a required final-report format.' },
        },
        required: ['prompt'],
      },
    } : null,
    {
      name: 'cursor_task_control',
      description:
        'Recover or terminate one exact in-memory Cursor task without resubmitting it; task records do not survive this MCP server process. ' +
        'Use reap for needs_attention/orphaned work only when it has a bound agentId; it explicitly rechecks that Agent and collects a stable terminal result when possible. ' +
        'Use cancel with confirm=true and the exact expected_agent_id to target Stop safely. ' +
        'FIFO or unbound orphans globally block delegation and require manual verification before abandon. ' +
        'Use abandon only with an explicit reason and acknowledge_may_still_write=true; it releases reservations without proving the Cursor Agent stopped.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The exact task ID returned by cursor_do.' },
          action: { type: 'string', enum: ['reap', 'cancel', 'abandon'], description: 'reap rechecks/collects a bound Agent, cancel targets its exact Stop control, abandon explicitly releases an unconfirmed orphan.' },
          expected_agent_id: { type: 'string', description: 'Required for cancel/abandon once cursor_status has published an agentId; it must match exactly. A cancel latched while phase=submitting may omit it because Bridge has not published the pre-bound ID yet.' },
          confirm: { type: 'boolean', default: false, description: 'Must be true for cancel or abandon.' },
          reason: { type: 'string', description: 'Reason for cancel; required and non-empty for abandon.' },
          acknowledge_may_still_write: { type: 'boolean', default: false, description: 'Must be true for abandon. It acknowledges that the underlying Cursor Agent may still be running or writing.' },
        },
        required: ['task_id', 'action'],
      },
    },
    {
      name: 'cursor_runtime',
      description:
        'Persistently switch Cursor presentation between normal and minimal. normal is the fresh-install default and restores ordinary visible Cursor use. ' +
        'minimal is the recommended opt-in background experience on tested Windows 11 systems: Cursor and CCE keep running while Cursor windows stay hidden. ' +
        'Before enabling minimal, tell the user that manually opening Cursor will remain hidden until CCE is switched back to normal. This is UI suppression, not a headless reimplementation.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...CURSOR_RUNTIME_MODES], description: 'normal shows Cursor and is the default. minimal is an explicit opt-in that keeps the Cursor-powered CCE running while continuously hiding its Windows UI.' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'cursor_status',
      description: 'Read-only snapshot of Cursor connectivity, queued/running work, reservations, execution availability, and normal/minimal runtime presentation. Pass a task ID to read its current in-memory state and any result already collected; this tool never switches Agents, reconciles, or stops work.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'A task ID returned by cursor_do. Omit it for an overall status view.' } } },
    },
  ].filter(Boolean);
}

const bridge = new CursorBridge();
const server = new Server(
  { name: 'cursor-bridge', version: '5.2.1' },
  { capabilities: { tools: { listChanged: true } } },
);

async function ensureBridgeCursor(targetBridge, reason) {
  targetBridge._refreshPersistedRuntimeMode();
  const { ensureCursorRunning } = await import('./launch-cursor.mjs');
  const r = await ensureCursorRunning({
    reason,
    runtimeMode: targetBridge.runtimeMode,
    ...(targetBridge.projectPath ? { projectPath: targetBridge.projectPath } : {}),
  });
  targetBridge._lastLifecycle = {
    adapterPid: r.adapterPid ?? process.pid,
    supervisorPid: r.supervisorPid ?? null,
    reusedSupervisor: !!r.reusedSupervisor,
    createdSupervisor: !!r.createdSupervisor,
    launchReason: r.launchReason || r.status,
    status: r.status,
    spawnMethod: r.spawnMethod || null,
    cursorPid: r.cursorPid || null,
    runtimeMode: r.runtimeMode || targetBridge.runtimeMode,
    projectPath: r.projectPath || null,
    targetId: r.targetId || null,
    workspaceAction: r.workspaceAction || null,
    presentation: r.presentation || null,
    windowGuard: r.windowGuard || null,
    startupWindowGuard: r.startupWindowGuard || null,
    message: r.message || null,
    needsAction: r.needsAction || null,
    nextStep: r.nextStep || null,
    retryable: r.retryable === true,
    cursorExecutable: r.cursorExecutable || null,
    cursorExecutableSource: r.cursorExecutableSource || null,
  };
  if (targetBridge.runtimeMode === 'minimal') {
    targetBridge._lastPresentation = r.presentation
      ? { ...r.presentation, at: new Date().toISOString() }
      : await targetBridge.applyRuntimePresentation('hide');
  }
  return r;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildToolDefinitions(bridge),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'cursor_init') {
      const result = await bridge.initializeWorkspace(String(args && args.path || ''));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'cursor_context_engine' || name === 'cursor_search' || name === 'cursor_search_deep') {
      const result = await bridge.contextEngine(String((args && args.query) || ''));
      return { content: [{ type: 'text', text: String(result) }] };
    }
    if (name === 'cursor_do') {
      const result = await bridge.doTask(String((args && args.prompt) || ''), {
        background: !args || args.background !== false,
        execution: args && args.execution,
        readOnly: !!(args && args.read_only),
        timeoutMs: args && args.timeout_ms,
        allowedPaths: args && args.allowed_paths,
        completionContract: args && args.completion_contract,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'cursor_task_control') {
      const result = await bridge.taskControl(args && args.task_id, {
        action: args && args.action,
        expectedAgentId: args && args.expected_agent_id,
        confirm: !!(args && args.confirm),
        reason: args && args.reason,
        acknowledgeMayStillWrite: !!(args && args.acknowledge_may_still_write),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'cursor_runtime') {
      const mode = args && args.mode;
      const action = args && args.action;
      let result = mode === undefined
        ? bridge.runtimeModeView()
        : await bridge.setRuntimeMode(mode, (args && args.scope) || 'persistent');
      if (mode !== undefined && shouldAutoLaunchCursor()) {
        result = { ...result, prewarm: await ensureBridgeCursor(bridge, 'runtime-mode-change') };
      }
      // Hidden compatibility for pre-5.0 clients. action remains intentionally absent from tools/list.
      if (action !== undefined) {
        result = { ...result, presentation: await bridge.applyRuntimePresentation(action) };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'cursor_status') {
      return { content: [{ type: 'text', text: JSON.stringify(await bridge.status(args && args.task_id), null, 2) }] };
    }
    if (name === 'cursor_launch') {
      const r = await ensureBridgeCursor(bridge, 'cursor_launch');
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: !r.ok };
    }
    throw new Error(`未知工具: ${name}`);
  } catch (error) {
    return { content: [{ type: 'text', text: `错误: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
});

async function main() {
  console.error('🚀 启动 cursor-bridge（CDP 直驱 :' + CDP_PORT + '）...');
  // Prewarm both runtime modes before the MCP handshake completes. In minimal mode this claims
  // Cursor's default single-instance slot with CDP enabled, then the PID-scoped guard keeps its
  // windows hidden. That prevents later "Open in Cursor" actions from stealing the slot without 9223.
  const startupEnsure = shouldAutoLaunchCursor()
    ? ensureBridgeCursor(bridge, 'adapter-startup')
      .then((r) => {
        console.error(
          '🪟 启动即确保 Cursor：' + (r.message || r.status)
          + ' | adapterPid=' + bridge._lastLifecycle.adapterPid
          + ' supervisorPid=' + bridge._lastLifecycle.supervisorPid
          + ' reused=' + bridge._lastLifecycle.reusedSupervisor
          + ' reason=' + bridge._lastLifecycle.launchReason,
        );
        return r;
      })
      .catch((error) => {
        console.error('⚠️ 启动即拉起 Cursor 失败（忽略，按需再拉）：', error.message);
        return null;
      })
    : Promise.resolve(null);
  await server.connect(new StdioServerTransport());
  console.error('✅ MCP 已连接。');
  void startupEnsure;
}

// 仅在直接运行（node server.mjs）时启 MCP；被 import（如 test 脚本）时只导出 CursorBridge/bridge。
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
  process.on('SIGINT', () => process.exit(0));
  main().catch((e) => { console.error('❌ 致命错误:', e); process.exit(1); });
}
export {
  CursorBridge,
  bridge,
  normalizeAllowedPath,
  normalizeDelegationMode,
  CURSOR_RUNTIME_MODES,
  cursorStartupBehavior,
  normalizeCursorRuntimeMode,
  shouldAutoLaunchCursor,
  buildContextEnginePrompt,
  normalizeCceSearchResult,
  isConfirmedCompletedReply,
  buildToolDefinitions,
  pathsOverlap,
  scoreCursorPageCandidate,
  selectCursorPageCandidate,
  selectNewAgentEntry,
  EXPR_VISIBLE,
  EXPR_FIND_NEWAGENT,
  exprCreateAgentForWorkspace,
  exprInspectWorkspaceRepository,
  EXPR_PAGE_CAPABILITIES,
  EXPR_HISTORY_ENTRIES,
  EXPR_PROVIDER_ERROR,
  EXPR_CLICK_SEND,
  exprFill,
  exprOpenAgent,
  exprClickSelectedAgentStop,
  isTargetedStopConfirmed,
  updateStableEntryObservation,
  classifyParallelTerminalIcon,
  providerErrorSignature,
  createProviderError,
  promoteAgentsWorkspaceLifecycle,
};
