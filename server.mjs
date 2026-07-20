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
 *   - 填字 execCommand insertText + input 事件；发送 = 真实 Enter（无显式发送钮）。
 *   - 回复渲染在 `.markdown-root`；完成信号 = 停止钮（codicon-stop 等）从 >0 → 0（生成中 stop=2~3）。
 *
 * 注意：Cursor 是 agent（比 fast-context 更主动），prompt 强约束「只列 path:行号、不读正文、不改代码」，
 *   但非技术隔离，理论上 agent 仍有写能力，别当沙箱。前提：Cursor 带 --remote-debugging-port=9223 在跑。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import http from 'http';
import { pathToFileURL } from 'url';

const CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${CDP_PORT}`;
const QUERY_TIMEOUT = Number(process.env.CURSOR_BRIDGE_TIMEOUT || 180000);

function normalizeDelegationMode(value = process.env.CURSOR_BRIDGE_DELEGATION) {
  return String(value || 'on').trim().toLowerCase() === 'off' ? 'off' : 'on';
}

const DELEGATION_MODE = normalizeDelegationMode();
const DELEGATION_POLICIES = Object.freeze(['manual', 'auto', 'active', 'eager']);
const DELEGATION_POLICY_GUIDANCE = Object.freeze({
  manual: 'Cursor waits until the user asks for it. Ordinary work stays with the main agent.',
  auto: 'Cursor helps when a clear, bounded handoff is likely to save meaningful time or add a useful second pass. Small one-step edits usually stay local.',
  active: 'Cursor works as a regular teammate. For most non-trivial tasks, look for one useful, separable piece to hand off while keeping decisions and final review with the main agent.',
  eager: 'Hand Cursor every safe, separable piece you can, including small probes and mechanical work. Run independent tasks in parallel when their paths do not overlap. Product decisions and final approval still stay with the main agent.',
});

function resolveDelegationPolicyFile(value = process.env.CURSOR_BRIDGE_POLICY_FILE) {
  const configured = String(value || '').trim();
  if (configured) return resolve(configured);
  const configRoot = process.platform === 'win32' && process.env.APPDATA
    ? process.env.APPDATA
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configRoot, 'cursor-bridge', 'policy.json');
}

const DELEGATION_POLICY_FILE = resolveDelegationPolicyFile();

function normalizeDelegationPolicy(value = process.env.CURSOR_BRIDGE_POLICY, fallback = 'active') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'on') return 'active';
  if (DELEGATION_POLICIES.includes(normalized)) return normalized;
  return fallback;
}

const DELEGATION_POLICY_DEFAULT = normalizeDelegationPolicy(
  process.env.CURSOR_BRIDGE_POLICY,
  'active',
);

function readPersistedDelegationPolicy(filePath = DELEGATION_POLICY_FILE) {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const candidate = typeof parsed === 'string' ? parsed : parsed && parsed.policy;
    const normalized = normalizeDelegationPolicy(candidate, '');
    return DELEGATION_POLICIES.includes(normalized) ? normalized : null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    console.error(`[cursor-bridge] ignoring unreadable policy file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function writePersistedDelegationPolicy(filePath, policy) {
  if (!filePath) throw new Error('persistent cursor_policy storage is disabled for this server');
  const normalized = normalizeDelegationPolicy(policy, '');
  if (!DELEGATION_POLICIES.includes(normalized)) {
    throw new Error(`unsupported delegation policy: ${policy}`);
  }
  const target = resolve(filePath);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, policy: normalized }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`failed to persist cursor_policy at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return target;
}

// 只读检索 prompt：Cursor agent 当精准定位器用，约束操作类型（不读正文/不改码/不长篇），由 CC 拿清单后自己读真文件。
const SEARCH_PREFIX =
  '只做代码检索定位：列出与下面意图相关的文件路径 + 行号范围（形如 Assets/Scripts/X.cs:120-180），' +
  '逐行列出即可。不要读取文件正文、不要修改任何代码、不要展开长篇解释。\n\n意图：';

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
async function findPage() {
  const list = await httpJson('/json/list');
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const p = pages.find((t) => /workbench/i.test(t.url || '')) || pages[0];
  if (!p) throw new Error('未找到 Cursor workbench page target');
  return p;
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
const EXPR_VISIBLE = `(function(){const i=document.querySelector('.aislash-editor-input');return !!(i&&i.offsetParent!==null);})()`;
function exprFill(text) {
  const js = JSON.stringify(text);
  return `(function(){const inp=document.querySelector('.aislash-editor-input');if(!inp||inp.offsetParent===null)return 'NO_INPUT';inp.focus();try{const s=getSelection();const r=document.createRange();r.selectNodeContents(inp);s.removeAllRanges();s.addRange(r);}catch(e){}const ok=document.execCommand('insertText',false,${js});inp.dispatchEvent(new Event('input',{bubbles:true}));return ok?(inp.innerText||'').slice(0,30):'EXEC_FAIL';})()`;
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
  return JSON.stringify({messageCount:texts.length,replyLength:last.length,replyHash:hash,stop});
})()`;
// 抓答案：最后一个可见且不属于模型选择器的 markdown；短回复同样有效。
const EXPR_EXTRACT = `(function(){
  const md=[...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')]
    .filter(e=>e.offsetParent!==null&&!e.closest('.ui-model-picker__trigger,[class*=model-picker]'));
  const texts=md.map(m=>(m.innerText||'').trim()).filter(Boolean);
  return texts[texts.length-1]||'';
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
    const entries=adapter.props.entries;
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
// "New Agent" 新对话钮中心坐标（aria-label 含 New Agent/New Chat）；返回 JSON 坐标或空串。
const EXPR_FIND_NEWAGENT = `(function(){const b=[...document.querySelectorAll('button,[role=button],a.action-label,.codicon')].find(e=>e.offsetParent!==null&&/New Agent|New Chat/i.test(e.getAttribute('aria-label')||''));if(!b)return '';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`;

const EXPR_HISTORY_OPEN = `(function(){return !![...document.querySelectorAll('.compact-agent-history-react-menu-label')].find(e=>e.offsetParent!==null);})()`;
const EXPR_FIND_HISTORY = `(function(){const b=[...document.querySelectorAll('button,[role=button],a.action-label,.codicon')].find(e=>{if(e.offsetParent===null)return false;const s=(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'');return /Show Chat History|Chat History|Agent History/i.test(s);});if(!b)return '';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`;

// Cursor 3.7 的 Agent History 菜单由 React 提供 entries + onOpenEntry(id)。
// 内部接口集中封装在这里；探测失败时只允许在发送前降级 FIFO，绝不重复提交已发送任务。
const REACT_ADAPTER_BODY = `
  const findAdapter=()=>{
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
            if(p&&Array.isArray(p.entries)&&typeof p.onOpenEntry==='function')return {props:p};
          }
        }
      }
    }
    return null;
  };
  const a=findAdapter();`;

const EXPR_HISTORY_ENTRIES = `(function(){${REACT_ADAPTER_BODY}
  if(!a)return JSON.stringify({ok:false,error:'REACT_ADAPTER_UNAVAILABLE'});
  const entries=a.props.entries.map((e,index)=>{
    const raw=e.timestamp;
    let timestamp=raw instanceof Date?raw.getTime():Number(raw);
    if(!Number.isFinite(timestamp))timestamp=Date.parse(String(raw||''));
    if(!Number.isFinite(timestamp))timestamp=index;
    return {
      id:String(e.id||''),label:String(e.label||''),searchText:String(e.searchText||''),timestamp,
      isSelected:!!e.isSelected,showSpinner:!!e.showSpinner,
      icon:String(typeof e.icon==='string'?e.icon:(e.icon&&((e.icon.id)||(e.icon.props&&e.icon.props.id)||(e.icon.type&&e.icon.type.id)))||'')
    };
  }).filter(e=>e.id);
  return JSON.stringify({ok:true,entries});
})()`;

function exprOpenAgent(agentId) {
  const id = JSON.stringify(String(agentId));
  return `(function(){${REACT_ADAPTER_BODY}
    if(!a)return 'REACT_ADAPTER_UNAVAILABLE';
    const e=a.props.entries.find(x=>String(x.id||'')===${id}); if(!e)return 'AGENT_NOT_FOUND';
    a.props.onOpenEntry(${id}); return 'OPENED';
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
  if (/error|failed|warning/i.test(value)) return 'failed';
  if (/check-circled|check/i.test(value)) return 'completed';
  return 'unknown';
}

class CursorBridge {
  constructor(options = {}) {
    this.environmentDelegationMode = normalizeDelegationMode(options.delegationMode || DELEGATION_MODE);
    this.policyFile = options.policyFile === null
      ? null
      : resolve(options.policyFile || DELEGATION_POLICY_FILE);
    this.delegationPolicyDefault = DELEGATION_POLICY_DEFAULT;
    const persistedPolicy = options.delegationPolicy === undefined
      ? readPersistedDelegationPolicy(this.policyFile)
      : null;
    const requestedPolicy = options.delegationPolicy !== undefined
      ? options.delegationPolicy
      : persistedPolicy || this.delegationPolicyDefault;
    this.persistedDelegationPolicy = persistedPolicy;
    this.delegationPolicySource = options.delegationPolicy !== undefined
      ? 'constructor'
      : persistedPolicy
        ? 'persistent'
        : process.env.CURSOR_BRIDGE_POLICY
          ? 'environment'
          : 'default';
    this.delegationPolicyScope = persistedPolicy ? 'persistent' : 'session';
    this.delegationPolicy = normalizeDelegationPolicy(requestedPolicy);
    this._syncDelegationState();
    this.busy = false;
    this.queue = [];
    this._healing = null;
    this.tasks = new Map();
    this.nextTaskId = 1;
    this.activeParallel = new Map();
    this.currentJob = null;
    this._uiTail = Promise.resolve();
    this.parallelRestoreAgentId = null;
  }

  _syncDelegationState() {
    this.delegationEnabled = this.environmentDelegationMode !== 'off';
    this.delegationMode = this.delegationEnabled ? 'on' : 'off';
  }

  delegationPolicyView() {
    const restartPolicy = this.persistedDelegationPolicy || this.delegationPolicyDefault;
    const policyStored = this.delegationPolicyScope === 'persistent'
      && this.persistedDelegationPolicy === this.delegationPolicy;
    return {
      scope: this.delegationPolicyScope,
      policy: this.delegationPolicy,
      policySource: this.delegationPolicySource,
      policyDefault: this.delegationPolicyDefault,
      persistedPolicy: this.persistedDelegationPolicy,
      policyFile: this.policyFile,
      policyStored,
      persistsAcrossRestart: this.delegationPolicy === restartPolicy,
      restartPolicy,
      guidance: DELEGATION_POLICY_GUIDANCE[this.delegationPolicy],
      delegationMode: this.delegationMode,
      delegationEnabled: this.delegationEnabled,
      environmentLockedOff: this.environmentDelegationMode === 'off',
      availablePolicies: [...DELEGATION_POLICIES],
      appliesTo: 'future_submissions',
      runningTasksUnchanged: true,
    };
  }

  setDelegationPolicy(value, scope = 'persistent') {
    const normalizedScope = String(scope || 'persistent').trim().toLowerCase();
    if (normalizedScope !== 'persistent' && normalizedScope !== 'session') {
      throw new Error('cursor_policy supports scope=persistent or scope=session');
    }
    const normalized = normalizeDelegationPolicy(value, '');
    if (!DELEGATION_POLICIES.includes(normalized)) {
      throw new Error(`unsupported delegation policy: ${value}`);
    }
    if (this.environmentDelegationMode === 'off') {
      throw new Error('CURSOR_BRIDGE_DELEGATION=off locks delegation off until the MCP server is restarted without that setting');
    }
    if (normalizedScope === 'persistent') {
      writePersistedDelegationPolicy(this.policyFile, normalized);
    }
    const previousPolicy = this.delegationPolicy;
    this.delegationPolicy = normalized;
    this.delegationPolicySource = normalizedScope === 'persistent' ? 'persistent' : 'runtime';
    this.delegationPolicyScope = normalizedScope;
    if (normalizedScope === 'persistent') this.persistedDelegationPolicy = normalized;
    this._syncDelegationState();
    return { previousPolicy, ...this.delegationPolicyView() };
  }

  async search(query) {
    if (this._hasGlobalReservation()) {
      throw new Error('存在 Stop 未确认的全局 Cursor 占用；请先处理 cursor_status 中的 blockingTaskIds');
    }
    await this._ensureCursor();
    const job = this._enqueue('search', SEARCH_PREFIX + query, {
      timeoutMs: QUERY_TIMEOUT,
      newChat: true,
      execution: 'fifo',
      readOnly: true,
      allowedPaths: [],
    });
    return job.promise;
  }

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
      newChat: execution === 'parallel_agent' ? true : options.newChat !== false,
      execution,
      readOnly,
      allowedPaths,
      submittedPolicy: this.delegationPolicy,
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
      submittedPolicy: options.submittedPolicy || null,
      status: 'queued',
      phase: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      sentAt: null,
      agentId: null,
      agentLabel: null,
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
    job.status = 'failed';
    job.phase = 'failed';
    job.finishedAt = new Date().toISOString();
    job.recoveryState = null;
    job.cancelRequested = false;
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
    if (this._healing) return this._healing;
    this._healing = (async () => {
      try {
        const { ensureCursorRunning } = await import('./launch-cursor.mjs');
        const rr = await ensureCursorRunning({ reason: 'adapter-heal' });
        this._lastLifecycle = {
          adapterPid: rr.adapterPid ?? process.pid,
          supervisorPid: rr.supervisorPid ?? null,
          reusedSupervisor: !!rr.reusedSupervisor,
          createdSupervisor: !!rr.createdSupervisor,
          launchReason: rr.launchReason || rr.status,
          status: rr.status,
          spawnMethod: rr.spawnMethod || null,
        };
        const life = 'adapterPid=' + this._lastLifecycle.adapterPid + ' supervisorPid=' + this._lastLifecycle.supervisorPid + ' reused=' + this._lastLifecycle.reusedSupervisor + ' reason=' + this._lastLifecycle.launchReason;
        if (rr.status === 'already') {
          console.error('🪟 cursor ensure already: ' + life);
          return;
        }
        if (rr.status === 'port-not-cursor') { console.error('⚠️ ' + rr.message + ' | ' + life); return; }
        console.error('🪟 cursor 自愈拉起：' + (rr.message || rr.status) + ' | ' + life);
      } catch (e) { console.error('⚠️ cursor 自愈失败（降级，按需手动启动）：', e.message); }
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
    const page = await findPage();
    const c = makeClient(page.webSocketDebuggerUrl);
    await c.ready;
    try {
      this._throwIfCancelledBeforeSend(options);
      await this._ensureChatPanel(c);
      // 1.5) 开新对话（避免上下文累积 + 回复区干净，extract 不串旧对话）；找不到钮则跳过沿用当前
      if (options.newChat !== false) await this._newChat(c);
      this._throwIfCancelledBeforeSend(options);
      // 2) 填查询
      const filled = await evalJS(c, exprFill(prompt));
      if (filled === 'NO_INPUT' || filled === 'EXEC_FAIL') throw new Error('填入查询失败（输入框状态异常）');
      await sleep(450);
      this._throwIfCancelledBeforeSend(options);
      let baseline = { messageCount: 0 };
      try { baseline = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch {}
      // 3) Enter 发送
      options.sendState = 'dispatching';
      try {
        await chord(c, 0, 'Enter', 'Enter', 13);
        options.sendState = 'sent';
        options.sentAt = options.sentAt || new Date().toISOString();
        // 4) 等完成（stop 钮 >0 出现过 → 归 0）
        return await this._waitComplete(c, options.timeoutMs || QUERY_TIMEOUT, baseline.messageCount || 0, options);
      } catch (error) {
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
    if (!vis) throw new Error('无法打开 Cursor chat 面板（.aislash-editor-input 不可见）。Cursor 是否登录且窗口正常？');
  }

  // 清空对话上下文：定位 "New Agent" 钮后【Alt+click】——Alt 修饰使其执行 Replace Agent（清空旧对话），
  // 而非新建（aria 标注 "New Agent (Ctrl+N) / [Alt] Replace Agent"）。2026-06-08 实测回复区 markdown DOM 清空
  // 2719→17，避免 extract 串旧对话。找不到钮则跳过沿用当前（不阻断查询）。
  async _newChat(c) {
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
    if (await evalJS(c, EXPR_HISTORY_OPEN)) return true;
    const pos = await evalJS(c, EXPR_FIND_HISTORY);
    if (!pos) return false;
    const { x, y } = JSON.parse(pos);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(450);
    return !!(await evalJS(c, EXPR_HISTORY_OPEN));
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
    if (!(await this._ensureHistoryOpen(c))) throw new Error('Agent History 菜单不可用');
    try {
      const snapshot = JSON.parse(await evalJS(c, EXPR_HISTORY_ENTRIES));
      if (!snapshot.ok) throw new Error(snapshot.error || 'Agent History React adapter 不可用');
      return snapshot.entries || [];
    } finally {
      if (!keepOpen) await this._closeHistory(c);
    }
  }

  async _submitParallelAgent(job) {
    const page = await findPage();
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
      if (!(await this._clickNewAgent(c, false))) {
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
      job.sendState = 'dispatching';
      sent = true;
      await chord(c, 0, 'Enter', 'Enter', 13);
      job.sendState = 'sent';
      job.sentAt = new Date().toISOString();

      // Cursor 3.7 可能只在首次消息发送后才把 composer 登记进 Agent History。
      // 发送后仍只按 before/after ID 差分绑定；若失败则进入 needs_attention，绝不重发或释放路径。
      for (let i = 0; i < 12 && !agent; i++) {
        await sleep(350);
        try { agent = selectNewAgentEntry(before, await this._readAgentEntries(c)); } catch {}
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
      const page = await findPage();
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
      if (terminalClass === 'failed' || terminalClass === 'cancelled') {
        const stableError = updateStableEntryObservation(lastTerminalErrorSignature, terminalErrorStable, entry);
        terminalErrorStable = stableError.count;
        lastTerminalErrorSignature = stableError.signature;
        completedStable = 0;
        if (terminalErrorStable >= 2) {
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
    const page = await findPage();
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
      const page = await findPage();
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
    this.parallelRestoreAgentId = null;
    this._withUiLock(async () => {
      const page = await findPage();
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

  async _waitComplete(c, timeoutMs = QUERY_TIMEOUT, baselineCount = 0, job = null) {
    const start = Date.now();
    const INTERVAL = 1000;
    let sawStop = false;        // 观察到生成中（stop 钮出现过）
    let lastReplyKey = '', stableReply = 0;
    await sleep(1200);          // 给发送后 stop 钮起来留时间
    while (Date.now() - start < timeoutMs) {
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
    // 超时只接受已观察到生成，或消息数明确增加到助手回复；避免把用户 prompt 当结果。
    let finalSnap = { messageCount: 0 };
    try { finalSnap = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch {}
    const ans = await evalJS(c, EXPR_EXTRACT);
    if (ans && (sawStop || finalSnap.messageCount >= baselineCount + 2)) return ans;
    throw new Error(`Cursor 任务超时 (${timeoutMs}ms) 未产生可确认的助手回复`);
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
      submittedPolicy: job.submittedPolicy,
      agentId: job.agentId,
      agentLabel: job.agentLabel,
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
      if (!job) return { found: false, taskId: String(taskId), ...this.delegationPolicyView() };
      return { found: true, ...this.delegationPolicyView(), ...this._taskView(job, true) };
    }
    const parallelRunning = this.activeParallel.size;
    const uiBusy = this.busy;
    const globalBlocked = this._hasGlobalReservation();
    const common = {
      ...this.delegationPolicyView(),
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

function delegationPolicyToolContext(bridgeInstance) {
  const view = bridgeInstance.delegationPolicyView();
  const restartText = view.policyStored
    ? 'This choice is persisted and will remain after the MCP server restarts.'
    : view.persistsAcrossRestart
      ? `A restart currently resolves to the same ${view.restartPolicy} policy.`
      : `This temporary session override resets to ${view.restartPolicy} after restart.`;
  return `Current effective Cursor participation policy: ${view.policy}. ${view.guidance} ${restartText} A direct user opt-out always wins.`;
}

function buildToolDefinitions(bridgeInstance) {
  const policyContext = delegationPolicyToolContext(bridgeInstance);
  return [
    {
      name: 'cursor_search',
      description:
        `${policyContext} ` +
        'Ask Cursor to find where something lives in the current project using its semantic search and grep tools. ' +
        'Use this when ordinary text search is not enough. A search usually takes around 90 seconds and runs one at a time, so keep other work moving while it runs. ' +
        'Cursor is prompted to return a short path-and-line list without editing files, but this is a behavioral instruction rather than a security sandbox.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Describe what you want to find, for example: "Where is battle damage calculated?"' },
        },
        required: ['query'],
      },
    },
    bridgeInstance.environmentDelegationMode !== 'off' ? {
      name: 'cursor_do',
      description:
        `${policyContext} ` +
        'Give Cursor a clearly bounded task and get back a task ID. Use fifo for the compatible serial queue or parallel_agent for a separate top-level Cursor Agent. ' +
        'Parallel write tasks must declare non-overlapping allowed_paths; mark read-only work with read_only=true. ' +
        'Collect the result with cursor_status(task_id). Cursor can do the work, but the main agent still owns review and final verification.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task Cursor should receive. State the goal, boundaries, and what a complete result looks like.' },
          background: { type: 'boolean', default: true, description: 'When true, return the task ID immediately. When false, wait for the task to finish or need attention.' },
          execution: { type: 'string', enum: ['fifo', 'parallel_agent'], default: 'fifo', description: 'fifo uses the compatible serial queue. parallel_agent creates a separate top-level Cursor Agent.' },
          read_only: { type: 'boolean', default: false, description: 'Set true when Cursor must not change the workspace.' },
          new_chat: { type: 'boolean', default: true, description: 'Start fifo work in a clean chat. parallel_agent always starts a separate Agent.' },
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
        `${policyContext} ` +
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
      name: 'cursor_policy',
      description:
        `${policyContext} ` +
        'Choose how readily the main agent should hand suitable work to Cursor. ' +
        'This does not run Cursor by itself and is not a call-frequency setting. ' +
        'Use manual when Cursor should wait for an explicit request, auto for selective help, active for regular teamwork, or eager for every safe separable task. ' +
        'Persistent is the default scope; session is available only for an intentional temporary override. ' +
        'The choice never gives Cursor authority over product decisions, overlapping writes, or final approval. Omit mode to see the current choice.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [...DELEGATION_POLICIES],
            description: 'How readily to hand suitable work to Cursor: manual waits for you, auto is selective, active treats Cursor as a regular teammate, and eager hands off every safe separable task. Omit this field to see the current choice.',
          },
          scope: {
            type: 'string',
            enum: ['persistent', 'session'],
            default: 'persistent',
            description: 'persistent stores the choice across MCP server restarts. session intentionally keeps it only until this server restarts.',
          },
        },
      },
    },
    {
      name: 'cursor_status',
      description: `${policyContext} Read-only snapshot of Cursor connectivity, queued/running work, reservations, and current delegation policy. Pass a task ID to read its current in-memory state and any result already collected; this tool never switches Agents, reconciles, or stops work.`,
      inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'A task ID returned by cursor_do. Omit it for an overall status view.' } } },
    },
    {
      name: 'cursor_launch',
      description:
        'Make sure Cursor is running with the CDP debugging port that Cursor Bridge needs. On Windows, this can launch Cursor and open the current project automatically. ' +
        'The result explains whether Cursor was already ready, was launched, needs a full restart with debugging enabled, could not be found, or timed out.',
      inputSchema: { type: 'object', properties: {} },
    },
  ].filter(Boolean);
}

const bridge = new CursorBridge();
const server = new Server(
  { name: 'cursor-bridge', version: '2.2.3' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildToolDefinitions(bridge),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'cursor_search') {
      const result = await bridge.search(String((args && args.query) || ''));
      return { content: [{ type: 'text', text: String(result) }] };
    }
    if (name === 'cursor_do') {
      const result = await bridge.doTask(String((args && args.prompt) || ''), {
        background: !args || args.background !== false,
        execution: args && args.execution,
        readOnly: !!(args && args.read_only),
        newChat: !args || args.new_chat !== false,
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
    if (name === 'cursor_policy') {
      const mode = args && args.mode;
      const result = mode === undefined
        ? bridge.delegationPolicyView()
        : bridge.setDelegationPolicy(mode, (args && args.scope) || 'persistent');
      if (mode !== undefined) {
        try {
          await server.sendToolListChanged();
        } catch (error) {
          console.error(`[cursor-bridge] policy changed but tools/list_changed notification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'cursor_status') {
      return { content: [{ type: 'text', text: JSON.stringify(await bridge.status(args && args.task_id), null, 2) }] };
    }
    if (name === 'cursor_launch') {
      const { ensureCursorRunning } = await import('./launch-cursor.mjs');
      const r = await ensureCursorRunning({ reason: 'cursor_launch' });
      bridge._lastLifecycle = {
        adapterPid: r.adapterPid ?? process.pid,
        supervisorPid: r.supervisorPid ?? null,
        reusedSupervisor: !!r.reusedSupervisor,
        createdSupervisor: !!r.createdSupervisor,
        launchReason: r.launchReason || r.status,
        status: r.status,
        spawnMethod: r.spawnMethod || null,
      };
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: !r.ok };
    }
    throw new Error(`未知工具: ${name}`);
  } catch (error) {
    return { content: [{ type: 'text', text: `错误: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
});

async function main() {
  console.error('🚀 启动 cursor-bridge（CDP 直驱 :' + CDP_PORT + '）...');
  await server.connect(new StdioServerTransport());
  console.error('✅ MCP 已连接。');
  // 启动即确保 Cursor 带 CDP 在跑（fire-and-forget，失败不阻塞 MCP；首次 cursor_search 仍会自愈拉起）。
  // 关掉：设 env CURSOR_BRIDGE_NO_AUTOLAUNCH=1。Cursor 已在跑但没带 flag 时不强杀（返回 running-no-debug 指引）。
  // Cursor lifecycle is owned by the user-level singleton supervisor (job-breakaway on Windows).
  if (process.env.CURSOR_BRIDGE_NO_AUTOLAUNCH !== '1') {
    (async () => {
      try {
        const { ensureCursorRunning } = await import('./launch-cursor.mjs');
        const r = await ensureCursorRunning({ reason: 'adapter-startup' });
        bridge._lastLifecycle = {
          adapterPid: r.adapterPid ?? process.pid,
          supervisorPid: r.supervisorPid ?? null,
          reusedSupervisor: !!r.reusedSupervisor,
          createdSupervisor: !!r.createdSupervisor,
          launchReason: r.launchReason || r.status,
          status: r.status,
          spawnMethod: r.spawnMethod || null,
        };
        console.error(
          '🪟 启动即确保 Cursor：' + (r.message || r.status)
          + ' | adapterPid=' + bridge._lastLifecycle.adapterPid
          + ' supervisorPid=' + bridge._lastLifecycle.supervisorPid
          + ' reused=' + bridge._lastLifecycle.reusedSupervisor
          + ' reason=' + bridge._lastLifecycle.launchReason,
        );
      } catch (e) { console.error('⚠️ 启动即拉起 Cursor 失败（忽略，按需再拉）：', e.message); }
    })();
  }
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
  DELEGATION_POLICIES,
  normalizeAllowedPath,
  normalizeDelegationMode,
  normalizeDelegationPolicy,
  pathsOverlap,
  selectNewAgentEntry,
  exprClickSelectedAgentStop,
  isTargetedStopConfirmed,
  updateStableEntryObservation,
  classifyParallelTerminalIcon,
};
