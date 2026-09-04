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
  CURSOR_MODEL_EFFORTS,
  CURSOR_MODEL_TARGETS,
  cursorEffortUiValue,
  normalizeCursorModelEffort,
  readCursorModelPreferences,
  resolveCursorModelPreferencesFile,
  updateCursorModelPreferences,
} from './cursor-model-preferences.mjs';
import {
  readWorkspaceBinding,
  resolveWorkspaceBindingFile,
  resolveWorkspaceBindingKey,
  writeWorkspaceBinding,
} from './workspace-binding.mjs';
import {
  CURSOR_SESSION_MODES,
  createCursorSessionId,
  normalizeCursorSessionMode,
  readCursorSessionRegistry,
  resolveCursorSessionRegistryFile,
  updateCursorSessionRegistry,
} from './cursor-session-registry.mjs';
import { isAgentsWindowTitle } from './cursor-ensure-core.mjs';
import { defaultLifecycleDir, ensureLifecycleDir } from './lifecycle-paths.mjs';

const PLUGIN_VERSION = '5.8.1';
const CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${CDP_PORT}`;
const QUERY_TIMEOUT = Number(process.env.CURSOR_BRIDGE_TIMEOUT || 300000);

function normalizeDelegationMode(value = process.env.CURSOR_BRIDGE_DELEGATION) {
  return String(value || 'on').trim().toLowerCase() === 'off' ? 'off' : 'on';
}

const DELEGATION_MODE = normalizeDelegationMode();

function cursorSessionError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function normalizeSessionRequestId(value) {
  const id = String(value || '').trim();
  if (id.length > 200) throw cursorSessionError('SESSION_REQUEST_ID_INVALID', 'request_id exceeds 200 characters');
  return id;
}

function sessionPathContains(parent, child) {
  const base = normalizeAllowedPath(parent);
  const candidate = normalizeAllowedPath(child);
  return candidate === base || candidate.startsWith(`${base}/`);
}

function sameSessionProject(left, right) {
  const a = resolve(String(left || ''));
  const b = resolve(String(right || ''));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Cursor Context Engine (CCE) search contracts: use Cursor's indexed/code-navigation
// context, but return compact evidence anchors that the primary agent can verify.
function searchResultContract() {
  return [
    'Return only the minimum sufficient evidence set, ordered by evidence strength. Do not pad the result with similar matches.',
    '',
    'Output format (keep it compact; write narrative fields in the language of the user query and do not append a long explanation):',
    'CCE_SEARCH_RESULT',
    'intent: <one-sentence restatement of the retrieval intent>',
    'coverage: <focused|extended> | <why this search depth was sufficient; whether the preferred scope was expanded>',
    'evidence:',
    '- <workspace-relative-path>:<start>-<end> | <symbol or anchor> | <relevance or verified relationship> | <semantic|exact|reference|source-read>',
    'gaps: <anything not confirmed; write none when empty>',
    'confidence: <high|medium|low> (rate retrieval evidence only, not code correctness)',
  ];
}

function buildContextEnginePrompt(query) {
  return [
    'You are Cursor Context Engine (CCE), a read-only, evidence-driven project-understanding engine.',
    'Resolve natural-language intent into verifiable code context. Do not guess locations, repeat framework conventions, or propose an implementation.',
    'Search before answering. Choose the search depth from the question shape and discovered relationships: converge quickly for a simple location; trace call chains, data flow, registrations, or cross-module relationships until the minimum sufficient evidence is reached.',
    'Choose the best Cursor capabilities available, including indexed semantic retrieval, exact text search, symbol/reference tracing, targeted source reading, and Explore or subagents when they materially help. The caller defines the read-only, evidence, and stopping boundaries; it does not prescribe Cursor\'s internal harness.',
    'Support every claimed relationship with actual search, references, or source reading. Semantic similarity is not a proven call edge. Stop at minimum sufficient context and avoid unrelated repository-wide exploration.',
    'Do not modify, create, or delete files, and do not run commands that change workspace state. Read only the context needed to verify the location.',
    'When evidence is missing, write NOT_FOUND and list the terms, symbols, references, or scopes actually searched under gaps. Never answer without searching.',
    'The search scope is the complete workspace currently open and indexed by Cursor. Treat any module or path named in the intent as a clue, not a hard boundary.',
    'Write narrative output in the language of the user query unless the query explicitly requests another language. Never translate paths, symbols, identifiers, keys, enum values, or evidence-source markers.',
    ...searchResultContract(),
    '',
    `Retrieval intent: ${String(query || '').trim()}`,
  ].join('\n');
}

function normalizeCceSearchResult(value) {
  const text = String(value || '').trim();
  const marker = text.indexOf('CCE_SEARCH_RESULT');
  if (marker < 0) return text;
  return text.slice(marker)
    .replace(/^CCE_SEARCH_RESULT\s+(?=intent:)/, 'CCE_SEARCH_RESULT\n')
    .replace(/[^\S\r\n]+(?=(?:coverage|evidence|gaps|confidence):)/g, '\n')
    .replace(/^(?!- )([^:\r\n]+:\d+(?:-\d+)?\s+\|)/gm, '- $1');
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

function isSessionTurnReplyReady(responseBaseline, snapshot = {}) {
  if (!responseBaseline) return true;
  if (Number(snapshot.messageCount || 0) >= Number(responseBaseline.messageCount || 0) + 2) return true;
  const replyLength = Number(snapshot.replyLength || 0);
  return replyLength > 0 && (
    replyLength !== Number(responseBaseline.replyLength || 0)
    || Number(snapshot.replyHash || 0) !== Number(responseBaseline.replyHash || 0)
  );
}

function shouldScheduleParallelOriginRestore(job) {
  return String(job && job.sessionMode || 'isolated') === 'isolated';
}

const DO_DEFAULT_CONTRACT =
  '\n\nCompletion requirements: Work directly in the workspace currently open in Cursor; do not push to a remote. ' +
  'Before finishing, inspect the actual changes and run verification proportional to risk. ' +
  'The final reply must list completed work, changed files, verification results, and remaining risks or blockers.';
const DO_LANGUAGE_CONTRACT =
  '\n\nResponse language: Reply in the language of the user task unless it explicitly requests another language. ' +
  'Never translate paths, commands, identifiers, keys, enum values, exact options, or error/status codes.';

// ---------- CDP helpers ----------
// 连接目标用字面 IP '127.0.0.1'，不用 'localhost'：Windows 上 "localhost" DNS 常优先解析到 ::1，
// 但 Chromium --remote-debugging-port 只监听 IPv4 127.0.0.1（非双栈），会导致 ECONNREFUSED（2026-07 实测）。
// ORIGIN 仍用 localhost 字符串——它只是 WS 握手 Origin 头，需跟 launch-cursor.mjs 的 --remote-allow-origins 保持一致，与连接目标无关。
const CDP_HOST = '127.0.0.1';
function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('CDP returned a non-JSON response')); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error(`Cursor debug port ${CDP_PORT} did not respond. Was Cursor started with --remote-debugging-port=${CDP_PORT}?`)));
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
    if (!exact) throw new Error(`Cursor CDP target disappeared: ${options.targetId}`);
    return exact;
  }
  const purpose = options.purpose || 'fifo';
  return pages
    .map((page, index) => ({ page, index, score: scoreCursorPageCandidate(page, purpose) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.page || null;
}

export function summarizeCdpPages(list) {
  const pages = (Array.isArray(list) ? list : []).filter((target) => target && target.type === 'page');
  const agents = pages.find((page) => isAgentsWindowTitle(page.title));
  const first = agents || pages[0] || null;
  return {
    pageCount: pages.length,
    pageTitles: pages.map((page) => String(page.title || '')),
    agentsWindowPresent: !!agents,
    page: first && first.url ? String(first.url).slice(0, 60) : '',
  };
}

const NORMAL_AGENTS_PRESENTATION_REFRESH_MS = 5 * 60 * 1000;

function shouldRecoverNormalAgentsPresentation({
  runtimeMode,
  workspaceAction,
  cursorPid,
  lastPresentation,
  platform = process.platform,
  now = Date.now(),
  refreshMs = NORMAL_AGENTS_PRESENTATION_REFRESH_MS,
} = {}) {
  if (platform !== 'win32' || runtimeMode !== 'normal') return false;
  if (!['reused-agents-window', 'reused-agents-repository'].includes(workspaceAction)) return false;
  if (!Number.isInteger(Number(cursorPid)) || Number(cursorPid) <= 0) return false;
  if (!lastPresentation
    || lastPresentation.applied !== true
    || lastPresentation.action !== 'show'
    || Number(lastPresentation.pid) !== Number(cursorPid)) {
    return true;
  }
  const previousAt = Date.parse(String(lastPresentation.at || ''));
  if (!Number.isFinite(previousAt)) return true;
  return Number(now) - previousAt >= Math.max(0, Number(refreshMs) || 0);
}

async function inspectPageTarget(page) {
  const c = makeClient(page.webSocketDebuggerUrl);
  const probeMs = Number(process.env.CURSOR_BRIDGE_PAGE_PROBE_TIMEOUT || 5000);
  try {
    await Promise.race([
      c.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out connecting to the CDP target')), probeMs)),
    ]);
    const raw = await Promise.race([
      evalJS(c, EXPR_PAGE_CAPABILITIES),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out probing the CDP target')), probeMs)),
    ]);
    return { ...page, capabilities: JSON.parse(raw || '{}') };
  } catch (error) {
    return { ...page, capabilities: null, probeError: error.message };
  } finally {
    c.close();
  }
}

function pagesWithFlavor(pages, flavor) {
  return (Array.isArray(pages) ? pages : []).filter((page) => page && page.capabilities && page.capabilities.uiFlavor === flavor);
}

function selectPageForUiPreference(inspected, options = {}) {
  const pages = Array.isArray(inspected) ? inspected.filter(Boolean) : [];
  const usable = pages.filter((page) => page.capabilities && page.capabilities.hasWritableInput);
  if (options.preferAgentsV2 === true) {
    const agentsV2 = pagesWithFlavor(usable, 'agents_v2');
    if (agentsV2.length) return selectCursorPageCandidate(agentsV2, { purpose: options.purpose });
    if (options.targetId) return selectCursorPageCandidate(pages, options);
  }
  if (options.preferLegacy === true) {
    const legacy = pagesWithFlavor(usable, 'legacy');
    if (legacy.length) return selectCursorPageCandidate(legacy, { purpose: options.purpose });
  }
  return selectCursorPageCandidate(
    usable.length ? usable : pages.filter((page) => /workbench/i.test(page.url || '') || page.capabilities),
    options,
  ) || pages[0] || null;
}

function isAgentsWorkspaceBindError(error) {
  return !!(error && /Cursor Agents workspace binding failed/.test(String(error.message || '')));
}

async function findPage(options = {}) {
  const list = await httpJson('/json/list');
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('No Cursor workbench page target was found');
  if (options.targetId && options.preferAgentsV2 !== true && options.preferLegacy !== true) {
    return selectCursorPageCandidate(pages, options);
  }
  const inspected = await Promise.all(pages.map(inspectPageTarget));
  return selectPageForUiPreference(inspected, options) || pages[0];
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
  ws.on('close', () => failAll('CDP WebSocket closed because the page or renderer disappeared'));
  ws.on('error', (e) => failAll('CDP WebSocket error: ' + (e && e.message)));
  const CMD_TIMEOUT = Number(process.env.CURSOR_BRIDGE_CMD_TIMEOUT || 30000);
  const send = (method, params = {}) => {
    const myId = ++id;
    return new Promise((res, rej) => {
    const t = setTimeout(() => { if (pending.delete(myId)) rej(new Error(`CDP command timed out: ${method} (${CMD_TIMEOUT}ms)`)); }, CMD_TIMEOUT);
      pending.set(myId, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      try { ws.send(JSON.stringify({ id: myId, method, params })); }
      catch (e) { clearTimeout(t); pending.delete(myId); rej(e); }
    });
  };
  return { ready, send, close: () => { try { ws.close(); } catch {} } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJS(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('Page exception: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
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
const CHAT_PANEL_NEXT_STEP = 'Complete or close the current Customize/Settings dialog, open Cursor\'s main Agent/Chat panel or New Chat, then retry the same request.';

function classifyChatPanelDiagnostic(snapshot = {}) {
  const evidence = {
    writableInputVisible: snapshot.writableInputVisible === true || snapshot.hasWritableInput === true,
    inputCandidateCount: Number.isFinite(Number(snapshot.inputCandidateCount)) ? Number(snapshot.inputCandidateCount) : 0,
    settingsOrCustomizeVisible: snapshot.settingsOrCustomizeVisible === true,
    modalVisible: snapshot.modalVisible === true,
    modalLabel: snapshot.modalLabel ? String(snapshot.modalLabel) : null,
    signInControlVisible: snapshot.signInControlVisible === true,
    signInVisible: snapshot.signInVisible === true,
    agentSurfaceVisible: snapshot.agentSurfaceVisible === true,
    composerCount: Number.isFinite(Number(snapshot.composerCount)) ? Number(snapshot.composerCount) : 0,
    visibilityState: String(snapshot.visibilityState || 'unknown'),
    focused: typeof snapshot.focused === 'boolean' ? snapshot.focused : null,
    pageTitle: snapshot.pageTitle ? String(snapshot.pageTitle) : null,
    probeError: snapshot.probeError ? String(snapshot.probeError) : null,
    inputStateChanged: snapshot.inputStateChanged === true,
  };
  let state = 'composer_input_unavailable';
  let needsAction = 'open_new_chat';
  let message = 'Cursor shows an Agent/Chat surface, but no writable input was detected.';
  if (evidence.signInVisible) {
    state = 'sign_in_required';
    needsAction = 'sign_in_to_cursor';
    message = 'Cursor is showing a sign-in surface instead of a writable Agent/Chat input.';
  } else if (evidence.settingsOrCustomizeVisible) {
    state = 'settings_or_customize_open';
    needsAction = 'complete_or_close_configuration';
    message = 'Cursor is showing Customize/Settings instead of a writable Agent/Chat input.';
  } else if (evidence.modalVisible) {
    state = 'modal_dialog_open';
    needsAction = 'complete_or_close_dialog';
    message = 'A visible Cursor dialog is blocking access to the Agent/Chat input.';
  } else if (evidence.probeError || ['hidden', 'prerender', 'unloaded'].includes(evidence.visibilityState)) {
    state = 'cursor_window_unavailable';
    needsAction = 'make_cursor_window_available';
    message = 'The selected Cursor page is unavailable or not visible.';
  } else if (evidence.inputStateChanged) {
    state = 'input_state_changed';
    needsAction = 'open_new_chat';
    message = 'Cursor\'s Agent/Chat input changed while the request was being prepared.';
  } else if (!evidence.agentSurfaceVisible && evidence.composerCount === 0) {
    state = 'agent_chat_panel_not_open';
    needsAction = 'open_agent_chat_panel';
    message = 'Cursor\'s main Agent/Chat panel is not open.';
  }
  return {
    schemaVersion: 1,
    code: 'CURSOR_CHAT_PANEL_UNAVAILABLE',
    state,
    message,
    needsAction,
    nextStep: CHAT_PANEL_NEXT_STEP,
    retryable: true,
    evidence,
  };
}

function createChatPanelUnavailableError(snapshot) {
  const uiDiagnostic = classifyChatPanelDiagnostic(snapshot);
  const error = new Error(`${uiDiagnostic.code}: ${uiDiagnostic.message} ${uiDiagnostic.nextStep}`);
  error.code = uiDiagnostic.code;
  error.uiDiagnostic = uiDiagnostic;
  return error;
}
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
  const readLines=node=>String(node&&(node.innerText||node.textContent)||'').split(/\\r?\\n/)
    .map(line=>line.trim()).filter(Boolean);
  const readTitle=node=>{
    const titleNode=node&&node.querySelector('.ui-tray-header__title');
    const stableTitle=String(titleNode&&(titleNode.innerText||titleNode.textContent)||'').trim();
    if(stableTitle)return stableTitle;
    return readLines(node).find(line=>/^LLM provider error$/i.test(line))||'';
  };
  const trays=[...document.querySelectorAll('.ui-tray.ui-notification-tray[data-visible="true"]')];
  const tray=trays.find(node=>/^LLM provider error$/i.test(readTitle(node)));
  if(!tray)return JSON.stringify({found:false});
  const title=readTitle(tray)||'LLM provider error';
  const lines=readLines(tray);
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

const EXPR_VISIBLE_COMPOSER = `(function(){
  const composers=[...document.querySelectorAll('.composer-bar[data-composer-id]')]
    .filter(e=>e.offsetParent!==null&&e.dataset.composerId);
  if(composers.length!==1){
    return JSON.stringify({ok:false,state:composers.length?'ambiguous_composers':'composer_missing',count:composers.length});
  }
  const composer=composers[0];
  return JSON.stringify({
    ok:true,
    id:'local:'+composer.dataset.composerId,
    composerId:composer.dataset.composerId,
    status:composer.dataset.composerStatus||null
  });
})()`;

function exprClickBoundComposerStop(agentId) {
  const expected = JSON.stringify(String(agentId));
  return `(function(){
    const expectedComposerId=String(${expected}).replace(/^local:/,'');
    const composers=[...document.querySelectorAll('.composer-bar[data-composer-id]')]
      .filter(e=>e.offsetParent!==null&&e.dataset.composerId===expectedComposerId);
    if(composers.length!==1){
      return JSON.stringify({clicked:false,state:'composer_identity_mismatch',count:composers.length});
    }
    const composer=composers[0];
    if(composer.dataset.composerStatus!=='generating'){
      return JSON.stringify({clicked:false,state:'composer_not_generating',status:composer.dataset.composerStatus||null,composerId:composer.dataset.composerId});
    }
    // Agents Window 的 Stop 可能在 composer-bar 外的输入条里；必须先核对该 composer 身份，
    // 再要求整页只有一个精确 Stop 控件，禁止模糊点击。
    const generationButtons=[...document.querySelectorAll('button.ui-prompt-input-submit-button[data-state="stop"][aria-label="Stop generation"]')]
      .filter(button=>button.offsetParent!==null&&!button.disabled);
    const commandButtons=[...document.querySelectorAll('button.ui-shell-tool-call__glass-stop[aria-label="Stop command"]')]
      .filter(button=>button.offsetParent!==null&&!button.disabled);
    const buttons=[...generationButtons,...commandButtons];
    if(buttons.length===1){
      buttons[0].click();
      return JSON.stringify({clicked:true,state:'clicked',composerId:composer.dataset.composerId,control:generationButtons.length?'stop_generation':'stop_command'});
    }
    const iconButtons=[...composer.querySelectorAll('.anysphere-icon-button')]
      .filter(button=>button.offsetParent!==null&&button.querySelector('.codicon-debug-stop,.codicon-stop'));
    const toolbarIcons=iconButtons.filter(button=>!button.closest('.composer-messages-container,.composer-react-transcript-root'));
    const iconPool=toolbarIcons.length?toolbarIcons:iconButtons;
    if(iconPool.length>=1){
      iconPool[iconPool.length-1].click();
      return JSON.stringify({clicked:true,state:'clicked',composerId:composer.dataset.composerId,control:'debug_stop_icon',count:iconPool.length});
    }
    return JSON.stringify({clicked:false,state:buttons.length?'ambiguous_stop_controls':'stop_control_missing',count:buttons.length,composerId:composer.dataset.composerId});
  })()`;
}
// "New Agent" 新对话钮中心坐标。新版 Cursor Agents 只有可见文本，旧版主要依赖 aria-label。
const EXPR_FIND_NEWAGENT = `(function(){const b=[...document.querySelectorAll('button,[role=button],a.action-label,.codicon')].find(e=>{if(e.offsetParent===null||e.closest('.glass-sidebar-agent-menu-btn'))return false;const s=(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+(e.innerText||'');return /(?:^|\\s)New (?:Agent|Chat)(?:\\s|$)/i.test(s);});if(!b)return '';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`;

const MODEL_PICKER_VISIBLE_BODY = `
  const visible=(node)=>!!(node&&(node.offsetParent!==null||(node.getClientRects&&node.getClientRects().length>0)));
  const composers=[...document.querySelectorAll('.composer-bar[data-composer-id],.composer-bar,.ui-prompt-input-root')].filter(visible);
  const composer=composers[composers.length-1]||document;
`;

const EXPR_MODEL_PICKER_TRIGGER = `(function(){
  ${MODEL_PICKER_VISIBLE_BODY}
  const triggerSelector='.ui-model-picker__trigger,.vscode-model-picker__trigger';
  const candidates=[...composer.querySelectorAll(triggerSelector)].filter(visible);
  const trigger=candidates[candidates.length-1]||[...document.querySelectorAll(triggerSelector)].filter(visible).pop();
  if(!trigger)return JSON.stringify({found:false,state:'trigger_missing'});
  const rect=trigger.getBoundingClientRect();
  const text=String(trigger.querySelector('.ui-model-picker__trigger-text,.vscode-model-picker__trigger-text')?.innerText||trigger.innerText||'').replace(/\\s+/g,' ').trim();
  const detail=String(trigger.querySelector('.ui-model-picker__trigger-variant-suffix,.vscode-model-picker__trigger-variant-suffix')?.innerText||'').replace(/\\s+/g,' ').trim();
  return JSON.stringify({found:true,state:'ready',text,detail,x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
})()`;

const EXPR_MODEL_PICKER_ROWS = `(function(){
  ${MODEL_PICKER_VISIBLE_BODY}
  const menus=[...document.querySelectorAll('[data-testid="model-picker-menu"],[data-testid*="model-parameters"],[data-testid*="parameter-submenu"],[data-component="menu-popup"][data-submenu]')].filter(visible);
  const rows=[];
  const seen=new Set();
  for(const menu of menus){
    for(const row of menu.querySelectorAll('[data-component="menu-row"],[data-component="menu-submenu-trigger"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]')){
      if(!visible(row)||seen.has(row))continue;
      seen.add(row);
      const rect=row.getBoundingClientRect();
      const text=String(row.innerText||row.textContent||'').replace(/\\s+/g,' ').trim();
      if(!text)continue;
      const menuTestId=String(menu.getAttribute('data-testid')||'').toLowerCase();
      let kind='control';
      if(row.querySelector('.ui-model-picker__item-content-name,.vscode-model-picker__item-content-name'))kind='model';
      else if(/^model(?:\\s|$)/i.test(text)&&row.getAttribute('aria-haspopup')==='menu')kind='model_control';
      else if(/^effort(?:\\s|$)/i.test(text)&&row.getAttribute('aria-haspopup')==='menu')kind='effort_control';
      else if(menuTestId.includes('parameter-submenu')||row.closest('[data-submenu]'))kind='parameter';
      else if(menuTestId.includes('model-picker-menu')||menuTestId.includes('model-selection'))kind='model';
      rows.push({
        text,
        kind,
        selected:row.getAttribute('data-selected')==='true'||row.getAttribute('aria-checked')==='true'||!!row.querySelector('.ui-model-picker__item-check,.ui-model-picker__param-check'),
        disabled:row.getAttribute('data-disabled')==='true'||row.getAttribute('aria-disabled')==='true',
        hasSubmenu:row.getAttribute('aria-haspopup')==='menu',
        submenu:!!row.closest('[data-submenu]'),
        x:Math.round(rect.x+rect.width/2),
        y:Math.round(rect.y+rect.height/2),
      });
    }
  }
  return JSON.stringify({open:menus.length>0,rows});
})()`;

function normalizeModelPickerText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/extra[\s_-]*high/g, 'xhigh')
    .replace(/[^a-z0-9]+/g, '');
}

function selectModelPickerRow(rows, requested, kind = 'model') {
  const wanted = normalizeModelPickerText(requested);
  if (!wanted) return null;
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.disabled !== true && (kind === 'any' || row.kind === kind))
    .map((row) => {
      const normalized = normalizeModelPickerText(row.text);
      let score = normalized === wanted ? 1000 : 0;
      if (kind !== 'parameter') {
        if (!score && normalized.startsWith(wanted)) score = 800;
        if (!score && wanted.startsWith(normalized)) score = 700;
        if (!score && normalized.includes(wanted)) score = 600;
      }
      return { row, score, distance: Math.abs(normalized.length - wanted.length) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.distance - b.distance);
  if (candidates.length === 0) return null;
  if (candidates.length > 1
      && candidates[0].score === candidates[1].score
      && candidates[0].distance === candidates[1].distance) return null;
  return candidates[0].row;
}

function createModelSelectionError(message, failureClass, retryable, diagnostic = {}) {
  const error = new Error(message);
  error.code = `CURSOR_MODEL_${String(failureClass || 'PROBE_ERROR').toUpperCase()}`;
  error.modelSelectionFailure = { failureClass, retryable, ...diagnostic };
  return error;
}

// Cursor currently ships two editors in every version: the workbench and the
// Agents Window. Agents Window repo rows used to be
// section.glass-sidebar-workspace-section-root; 3.16.17 dropped that wrapper
// and keeps the repo identity on .ui-sidebar-section-head. Collect both.
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
    icon:String(typeof (e&&e.icon)==='string'?e.icon:(e&&e.icon&&((e.icon.id)||(e.icon.props&&e.icon.props.id)||(e.icon.type&&e.icon.type.id)))||''),
    durable:true
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
      workspaceId:String(readScalar(section&&section.id)||''),workspaceLabel:String(readScalar(section&&section.displayName)||''),
      durable:true
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
    let globalSelectAgent=null;
    let globalSelectedAgentId=null;
    let sectionIdByAgentId=null;
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
              if(p&&typeof p.onSelectAgent==='function'&&!globalSelectAgent){
                globalSelectAgent=p.onSelectAgent;
                globalSelectedAgentId=p.selectedAgentId!==undefined?p.selectedAgentId:p.committedSelectedAgentId;
              }
              if(p&&p.sectionIdByAgentId&&!sectionIdByAgentId)sectionIdByAgentId=p.sectionIdByAgentId;
              const selectAgent=p&&(typeof p.onSelectAgent==='function'
                ?p.onSelectAgent
                :(p.rowHandlers&&typeof p.rowHandlers.onSelect==='function'?p.rowHandlers.onSelect:null));
              if(p&&p.section&&Array.isArray(p.section.headers)&&selectAgent&&!seen.has(p)){
                seen.add(p);found.push({
                  section:p.section,
                  selectedAgentId:p.selectedAgentId!==undefined?p.selectedAgentId:p.committedSelectedAgentId,
                  onSelectAgent:selectAgent
                });
              }
            }
          }
        }
      }
    }
    found.globalSelectAgent=globalSelectAgent;
    found.globalSelectedAgentId=globalSelectedAgentId;
    found.sectionIdByAgentId=sectionIdByAgentId;
    return found;
  };
  const findAdapter=()=>{
    const v2=findV2Props();
    if(v2.length){
      return {
        kind:'agents_v2',
        entries:()=>{
          const entries=[];const seen=new Set();let index=0;
          let selectedRaw=String(readScalar(v2.globalSelectedAgentId)||'').replace(/^local:/,'');
          for(const p of v2){
            const selectedId=readScalar(v2.globalSelectedAgentId)||readScalar(p.selectedAgentId);
            if(!selectedRaw&&selectedId)selectedRaw=String(selectedId).replace(/^local:/,'');
            for(const header of p.section.headers){
              const entry=normalizeV2(header,selectedId,index++,p.section);
              if(entry.id&&!seen.has(entry.id)){seen.add(entry.id);entries.push(entry);}
            }
          }
          const selectedId=selectedRaw?'local:'+selectedRaw:'';
          if(selectedId&&!seen.has(selectedId)){
            const composer=[...document.querySelectorAll('.composer-bar[data-composer-id]')]
              .find(node=>String(node.dataset&&node.dataset.composerId||'').replace(/^local:/,'')===selectedRaw&&node.offsetParent!==null);
            if(composer){
              const status=String(composer.dataset&&composer.dataset.composerStatus||'').toLowerCase();
              let icon=status||'draft';
              if(/in_progress|running|generating/.test(status))icon='loading';
              else if(status==='done'||status==='completed')icon='check-circled';
              else if(/needs_attention/.test(status))icon='needs-attention';
              else if(/failed|error/.test(status))icon='warning';
              else if(/cancel/.test(status))icon='circle-slash';
              seen.add(selectedId);
              entries.push({
                id:selectedId,label:'',searchText:'',timestamp:0,isSelected:true,
                showSpinner:/in_progress|running|generating/.test(status),icon,
                workspaceId:String(v2.sectionIdByAgentId instanceof Map?v2.sectionIdByAgentId.get(selectedRaw)||'':v2.sectionIdByAgentId&&readScalar(v2.sectionIdByAgentId[selectedRaw])||''),
                workspaceLabel:'',durable:!!(v2.sectionIdByAgentId&&(v2.sectionIdByAgentId instanceof Map?v2.sectionIdByAgentId.has(selectedRaw):v2.sectionIdByAgentId[selectedRaw]!==undefined)),
                registeredBySectionMap:true
              });
            }
          }
          if(v2.sectionIdByAgentId){
            const registered=v2.sectionIdByAgentId instanceof Map?[...v2.sectionIdByAgentId.entries()]:Object.entries(v2.sectionIdByAgentId);
            for(const pair of registered){
              const raw=String(pair&&pair[0]||'').replace(/^local:/,'');
              if(!raw)continue;
              const id='local:'+raw;
              if(seen.has(id))continue;
              seen.add(id);
              entries.push({
                id,label:'',searchText:'',timestamp:0,isSelected:id===selectedId,
                showSpinner:false,icon:'registered',workspaceId:String(readScalar(pair[1])||''),workspaceLabel:'',
                durable:true,registeredBySectionMap:true
              });
            }
          }
          return entries;
        },
        open:async id=>{
          const raw=String(id||'').replace(/^local:/,'');
          if(String(readScalar(v2.globalSelectedAgentId)||'').replace(/^local:/,'')===raw)return true;
          if(v2.some(p=>String(readScalar(p.selectedAgentId)||'').replace(/^local:/,'')===raw))return true;
          for(const p of v2){
            const header=p.section.headers.find(h=>String(readScalar(h&&h.id)||'')===raw);
            if(header){return (await p.onSelectAgent(header))!==false;}
          }
          const registered=v2.sectionIdByAgentId&&(v2.sectionIdByAgentId instanceof Map?v2.sectionIdByAgentId.has(raw):v2.sectionIdByAgentId[raw]!==undefined);
          if(registered&&typeof v2.globalSelectAgent==='function'){
            return (await v2.globalSelectAgent(raw,{preserveSidebarAction:true}))!==false;
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
  const visible=node=>!!(node&&(node.offsetParent!==null||(typeof node.getClientRects==='function'&&node.getClientRects().length>0)));
  const label=node=>String(node&&(node.getAttribute&&(
    node.getAttribute('aria-label')||node.getAttribute('title'))||node.innerText||node.textContent)||'').replace(/\\s+/g,' ').trim();
  const input=pickInput();
  const inputCandidateCount=[...document.querySelectorAll(${JSON.stringify(CURSOR_INPUT_SELECTOR)})].filter(visible).length;
  const hasV2Sidebar=!!document.querySelector('.glass-sidebar-agent-list-container');
  const hasLegacyInput=!!document.querySelector('.aislash-editor-input');
  const hasLegacyHistory=!!document.querySelector('.compact-agent-history-react-menu-label')||
    [...document.querySelectorAll('button,[role=button],a.action-label,.codicon')].some(e=>/Show Chat History|Chat History|Agent History/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')));
  const dialogs=[...document.querySelectorAll('[role="dialog"],dialog[open],.monaco-dialog-box,.quick-input-widget')].filter(visible);
  const dialog=dialogs[dialogs.length-1]||null;
  const dialogHeading=dialog&&dialog.querySelector('h1,h2,h3,[role="heading"]');
  const dialogLabel=dialog?String(dialog.getAttribute('aria-label')||dialog.getAttribute('title')||label(dialogHeading)||'').slice(0,120):null;
  const pageTitle=String(document.title||'').replace(/\\s+/g,' ').trim();
  const pagePath=String(globalThis.location&&globalThis.location.pathname||'');
  const headings=[...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
    .filter(node=>visible(node)&&!node.closest('.markdown-root,.composer-messages-container,.composer-react-transcript-root,.aichat-container'))
    .map(label).filter(Boolean).slice(0,40);
  const configurationText=[pageTitle,pagePath,...headings,label(dialogHeading)].join(' ');
  const configurationSelector='.ui-customize-view,.settings-editor,.settings-body,.preferences-editor,[class*="settings-editor"],[class*="preferences-editor"],[data-testid*="customize"]';
  const settingsOrCustomizeVisible=[...document.querySelectorAll(configurationSelector)].some(visible)||/(?:settings?|customize|preferences|设置|設定|自定义|自訂)/i.test(configurationText);
  const authControls=[...document.querySelectorAll('button,a,[role="button"],[role="link"]')]
    .filter(node=>visible(node)&&!node.closest('.markdown-root,.composer-messages-container,.composer-react-transcript-root'));
  const signInPattern=/(?:sign|log)\\s*in(?:\\s+to\\s+cursor)?|authenticate(?:\\s+cursor)?|continue with (?:google|github|email|sso)|登录|登入/i;
  const signInControlVisible=authControls.some(node=>signInPattern.test(label(node)));
  const signInVisible=authControls.some(node=>signInPattern.test(label(node))&&!node.closest(configurationSelector));
  const composerCount=[...document.querySelectorAll('.composer-bar[data-composer-id],.composer-bar,.ui-prompt-input-root')].filter(visible).length;
  const agentSurfaceVisible=composerCount>0||[...document.querySelectorAll('.glass-sidebar-agent-list-container,.compact-agent-history-react-menu-label,.aichat-container')].some(visible)||authControls.some(node=>/(?:New (?:Agent|Chat)|(?:Chat|Agent) History)/i.test(label(node)));
  const uiFlavor=hasV2Sidebar||(input&&input.classList&&input.classList.contains('ui-prompt-input-editor__input'))?'agents_v2':hasLegacyInput?'legacy':'unknown';
  return JSON.stringify({
    hasWritableInput:!!input,inputCandidateCount,uiFlavor,
    agentAdapterKind:hasV2Sidebar?'agents_v2':hasLegacyHistory?'legacy':'none',
    hasComposer:!!document.querySelector('.composer-bar[data-composer-id]'),
    modalVisible:!!dialog,modalLabel:dialogLabel,
    settingsOrCustomizeVisible,signInControlVisible,signInVisible,agentSurfaceVisible,composerCount,
    visibilityState:String(document.visibilityState||'unknown'),
    visible:document.visibilityState==='visible',focused:typeof document.hasFocus==='function'&&document.hasFocus(),
    documentTitle:pageTitle,pageTitle:pageTitle.slice(0,160)
  });
})()`;

const EXPR_HISTORY_ENTRIES = `(function(){${REACT_ADAPTER_BODY}
  if(!a)return JSON.stringify({ok:false,error:'REACT_ADAPTER_UNAVAILABLE'});
  return JSON.stringify({ok:true,kind:a.kind,entries:a.entries()});
})()`;

function exprOpenAgent(agentId) {
  const id = JSON.stringify(String(agentId));
  return `(async function(){${REACT_ADAPTER_BODY}
    if(!a)return 'REACT_ADAPTER_UNAVAILABLE';
    return (await a.open(${id}))?'OPENED':'AGENT_NOT_FOUND';
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

function listNewAgentEntries(beforeEntries, afterEntries) {
  const before = new Set((beforeEntries || []).map((entry) => entry && entry.id).filter(Boolean));
  return (afterEntries || []).filter((entry) => entry && entry.id && !before.has(entry.id));
}

function normalizeAgentIdentityId(id) {
  return String(id || '').replace(/^local:/i, '');
}

function selectUniqueNewAgentEntry(beforeEntries, afterEntries) {
  const fresh = listNewAgentEntries(beforeEntries, afterEntries);
  if (fresh.length === 1) return fresh[0];
  const selected = fresh.filter((entry) => entry.isSelected === true);
  return selected.length === 1 ? selected[0] : null;
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

function isDurablyRegisteredParallelEntry(entry) {
  return !!entry
    && entry.durable !== false
    && (entry.showSpinner || classifyParallelTerminalIcon(entry.icon) !== 'unknown');
}

function selectPromotedFifoEntry(beforeEntries, currentAgentId, afterEntries) {
  if (!Array.isArray(beforeEntries) || !Array.isArray(afterEntries)) return null;
  if (currentAgentId && afterEntries.some((entry) => entry && entry.id === currentAgentId)) return null;
  const candidate = selectNewAgentEntry(beforeEntries, afterEntries);
  if (!candidate || candidate.id === currentAgentId || candidate.isSelected !== true) return null;
  return isDurablyRegisteredParallelEntry(candidate) ? candidate : null;
}

function selectPromotedParallelEntry(beforeEntries, provisionalAgentId, afterEntries) {
  if (!Array.isArray(beforeEntries) || !Array.isArray(afterEntries)) return null;
  const fresh = listNewAgentEntries(beforeEntries, afterEntries);
  if (provisionalAgentId) {
    const exact = afterEntries.find((entry) => entry && entry.id === provisionalAgentId) || null;
    if (exact) return isDurablyRegisteredParallelEntry(exact) ? exact : null;
    const normalized = normalizeAgentIdentityId(provisionalAgentId);
    const promoted = fresh.filter((entry) =>
      entry.isSelected === true
      && normalizeAgentIdentityId(entry.id) === normalized
      && isDurablyRegisteredParallelEntry(entry));
    if (promoted.length === 1) return promoted[0];
    if (promoted.length > 1) return null;
  }
  const selected = fresh.filter((entry) => entry.isSelected === true && isDurablyRegisteredParallelEntry(entry));
  if (selected.length === 1) return selected[0];
  if (!provisionalAgentId) {
    const durable = fresh.filter(isDurablyRegisteredParallelEntry);
    if (durable.length === 1) return durable[0];
  }
  return null;
}

function uncertainSubmissionReservationScope(job, error) {
  if (error && error.requiresGlobalReservation) return 'global';
  return job && job.readOnly ? 'agent' : 'paths';
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
    message: `CCE confirmed that workspace ${lifecycle.projectPath || agentsWorkspace.workspace || ''} is available in Cursor Agents.`,
    needsAction: null,
    nextStep: null,
    retryable: false,
  };
}

function lifecycleFromEnsureResult(result, fallbackRuntimeMode) {
  return {
    adapterPid: result.adapterPid ?? process.pid,
    supervisorPid: result.supervisorPid ?? null,
    reusedSupervisor: !!result.reusedSupervisor,
    createdSupervisor: !!result.createdSupervisor,
    launchReason: result.launchReason || result.status,
    status: result.status,
    spawnMethod: result.spawnMethod || null,
    lifecycleMode: result.lifecycleMode || null,
    persistent: result.persistent === true,
    degradedReason: result.degradedReason || null,
    spawnErrorCode: result.spawnErrorCode ?? null,
    supervisorErrorKind: result.supervisorErrorKind || null,
    supervisorError: result.supervisorError || null,
    supervisorStderr: result.supervisorStderr || null,
    supervisorSpawnCwd: result.supervisorSpawnCwd || null,
    lifecycleStorageMode: result.lifecycleStorageMode || null,
    spawnAttempts: result.spawnAttempts ?? null,
    capabilities: result.capabilities || null,
    cursorPid: result.cursorPid || null,
    runtimeMode: result.runtimeMode || fallbackRuntimeMode,
    projectPath: result.projectPath || null,
    targetId: result.targetId || null,
    workspaceAction: result.workspaceAction || null,
    presentation: result.presentation || null,
    windowGuard: result.windowGuard || null,
    startupWindowGuard: result.startupWindowGuard || null,
    message: result.message || null,
    needsAction: result.needsAction || null,
    nextStep: result.nextStep || null,
    retryable: result.retryable === true,
    cursorExecutable: result.cursorExecutable || null,
    cursorExecutableSource: result.cursorExecutableSource || null,
    runtimeFingerprint: result.runtimeFingerprint || null,
    runtimeScript: result.runtimeScript || null,
    runtimeUpgradeDeferred: result.runtimeUpgradeDeferred === true,
  };
}

function lifecycleFailureSummary(lifecycle, fallback) {
  if (!lifecycle) return fallback;
  const diagnostic = [
    `status=${lifecycle.status || 'unknown'}`,
    `lifecycleMode=${lifecycle.lifecycleMode || 'unknown'}`,
    `degradedReason=${lifecycle.degradedReason || 'none'}`,
    `spawnErrorCode=${lifecycle.spawnErrorCode ?? 'none'}`,
    `supervisorErrorKind=${lifecycle.supervisorErrorKind || 'none'}`,
    `spawnAttempts=${lifecycle.spawnAttempts ?? 'none'}`,
  ].join(' ');
  const original = lifecycle.supervisorError
    ? `Original supervisor error: ${lifecycle.supervisorError}`
    : null;
  return [lifecycle.message || fallback, `[${diagnostic}]`, original].filter(Boolean).join(' ');
}

function releaseAdapterWorkingDirectory({ targetDir = null, chdir = process.chdir } = {}) {
  // Do not create the lifecycle directory here. On Codex hosts that directory inherits
  // AppContainer ACLs, while the WMI-launched Supervisor runs outside the sandbox. The lifecycle
  // client owns first creation through its outside-job bootstrap. The Node executable directory is
  // stable, already exists, and safely releases the plugin cache cwd without creating state.
  const target = targetDir ? ensureLifecycleDir(targetDir) : dirname(process.execPath);
  chdir(target);
  return target;
}

class CursorBridge {
  constructor(options = {}) {
    this.adapterStartCwd = resolve(options.adapterStartCwd || process.cwd());
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
    this.modelPreferencesFile = options.modelPreferencesFile === null
      ? null
      : resolve(options.modelPreferencesFile || resolveCursorModelPreferencesFile());
    this.modelPreferences = readCursorModelPreferences(this.modelPreferencesFile);
    this.sessionFile = options.sessionFile === null
      ? null
      : resolve(options.sessionFile || resolveCursorSessionRegistryFile());
    this.sessionInstanceId = String(
      options.sessionInstanceId || `cursor-adapter-${createCursorSessionId().slice('cursor-session-'.length)}`,
    );
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

  sessionRegistryView() {
    return {
      sessionStorageFile: this.sessionFile,
      sessionStoragePersistent: !!this.sessionFile,
      sessionStorageLocation: this.sessionFile ? 'user-config' : 'disabled',
    };
  }

  _readSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) throw cursorSessionError('SESSION_REQUIRED', 'session_id must not be empty');
    if (!this.sessionFile) throw cursorSessionError('SESSION_STORAGE_DISABLED', 'persistent session storage is disabled');
    return readCursorSessionRegistry(this.sessionFile).sessions[id] || null;
  }

  _sessionView(session) {
    if (!session) return null;
    return {
      sessionId: session.id,
      sessionState: session.state,
      projectPath: session.projectPath,
      workspaceKey: session.workspaceKey,
      agentId: session.agentId || null,
      agentLabel: session.agentLabel || null,
      turnIndex: Number(session.turnIndex || 0),
      activeTaskId: session.activeTaskId || null,
      lastTask: session.lastTask || null,
      modelPreference: session.modelPreference || null,
      readOnly: session.scopeEnvelope && session.scopeEnvelope.readOnly === true,
      allowedPaths: session.scopeEnvelope && Array.isArray(session.scopeEnvelope.allowedPaths)
        ? session.scopeEnvelope.allowedPaths
        : [],
      createdAt: session.createdAt || null,
      updatedAt: session.updatedAt || null,
      closedAt: session.closedAt || null,
      recoveryState: session.recoveryState || null,
      attention: session.attention || null,
    };
  }

  _claimNewSession({ taskId, projectPath, readOnly, allowedPaths, modelPreference, requestId, timeoutMs }) {
    if (!this.sessionFile) throw cursorSessionError('SESSION_STORAGE_DISABLED', 'persistent session storage is disabled');
    const sessionId = createCursorSessionId();
    const now = new Date().toISOString();
    const session = {
      id: sessionId,
      state: 'creating',
      projectPath,
      workspaceKey: this.workspaceKey,
      agentId: null,
      agentLabel: null,
      modelPreference: modelPreference ? { ...modelPreference } : null,
      scopeEnvelope: { readOnly, allowedPaths: [...allowedPaths] },
      turnIndex: 1,
      epoch: 1,
      activeTaskId: taskId,
      lastRequestId: requestId || null,
      lastTask: null,
      lease: {
        taskId,
        instanceId: this.sessionInstanceId,
        epoch: 1,
        expiresAt: new Date(Date.now() + timeoutMs + 60000).toISOString(),
      },
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      recoveryState: null,
      attention: null,
    };
    updateCursorSessionRegistry(this.sessionFile, (registry) => {
      if (registry.sessions[sessionId]) throw cursorSessionError('SESSION_ID_COLLISION', sessionId);
      registry.sessions[sessionId] = session;
    }, { now });
    return session;
  }

  _claimExistingSession({ sessionId, taskId, projectPath, readOnly, allowedPaths, requestId, timeoutMs }) {
    if (!this.sessionFile) throw cursorSessionError('SESSION_STORAGE_DISABLED', 'persistent session storage is disabled');
    const nowMs = Date.now();
    let expiredLease = false;
    const result = updateCursorSessionRegistry(this.sessionFile, (registry) => {
      const session = registry.sessions[sessionId];
      if (!session) throw cursorSessionError('SESSION_NOT_FOUND', sessionId);
      if (requestId && session.lastRequestId === requestId) {
        return { duplicate: true, session: { ...session } };
      }
      if (!sameSessionProject(session.projectPath, projectPath)) {
        throw cursorSessionError('SESSION_WORKSPACE_MISMATCH', `session is bound to ${session.projectPath}`);
      }
      if (session.state === 'closed') throw cursorSessionError('SESSION_CLOSED', sessionId);
      const leaseExpiresAt = Date.parse(session.lease && session.lease.expiresAt || '');
      if (session.activeTaskId || session.state === 'busy' || session.state === 'creating') {
        if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= nowMs) {
          expiredLease = true;
          session.state = 'needs_attention';
          session.recoveryState = 'expired_sender_lease';
          session.attention = 'The previous sender lease expired. Reconcile the exact Cursor Agent before continuing; no prompt was resent.';
          session.updatedAt = new Date(nowMs).toISOString();
          return { duplicate: false, session: { ...session } };
        }
        throw cursorSessionError('SESSION_BUSY', `active task ${session.activeTaskId || 'unknown'}`);
      }
      if (session.state !== 'ready') {
        throw cursorSessionError('SESSION_NOT_READY', `state=${session.state}; recovery=${session.recoveryState || 'none'}`);
      }
      if (!session.agentId) throw cursorSessionError('SESSION_AGENT_NOT_BOUND', sessionId);
      const envelope = session.scopeEnvelope || { readOnly: false, allowedPaths: [] };
      if (envelope.readOnly === true) {
        if (readOnly !== true || allowedPaths.length > 0) {
          throw cursorSessionError('SESSION_SCOPE_EXPANSION', 'a read-only session must remain explicitly read-only');
        }
      } else {
        if (readOnly === true || allowedPaths.length === 0) {
          throw cursorSessionError('SESSION_SCOPE_REQUIRED', 'a writable continuation must repeat an allowed_paths subset');
        }
        const outside = allowedPaths.find((candidate) =>
          !(envelope.allowedPaths || []).some((parent) => sessionPathContains(parent, candidate)));
        if (outside) throw cursorSessionError('SESSION_SCOPE_EXPANSION', `${outside} is outside the session envelope`);
      }
      const epoch = Number(session.epoch || 0) + 1;
      session.state = 'busy';
      session.turnIndex = Number(session.turnIndex || 0) + 1;
      session.epoch = epoch;
      session.activeTaskId = taskId;
      session.lastRequestId = requestId || null;
      session.lease = {
        taskId,
        instanceId: this.sessionInstanceId,
        epoch,
        expiresAt: new Date(nowMs + timeoutMs + 60000).toISOString(),
      };
      session.updatedAt = new Date(nowMs).toISOString();
      session.recoveryState = null;
      session.attention = null;
      return { duplicate: false, session: { ...session } };
    }, { now: new Date(nowMs).toISOString() });
    if (expiredLease) {
      throw cursorSessionError('SESSION_RECONCILE_REQUIRED', 'the previous sender lease expired; no prompt was sent');
    }
    return result;
  }

  _bindSessionAgent(job) {
    if (!job || !job.sessionId || !job.agentId || !this.sessionFile) return;
    updateCursorSessionRegistry(this.sessionFile, (registry) => {
      const session = registry.sessions[job.sessionId];
      if (!session || session.activeTaskId !== job.id || Number(session.epoch) !== Number(job.sessionEpoch)) return;
      session.agentId = job.agentId;
      session.agentLabel = job.agentLabel || session.agentLabel || null;
      session.state = 'busy';
      session.updatedAt = new Date().toISOString();
    });
    job.sessionState = 'busy';
  }

  _settleSessionJob(job, outcome, options = {}) {
    if (!job || !job.sessionId || !this.sessionFile) return;
    const now = new Date().toISOString();
    updateCursorSessionRegistry(this.sessionFile, (registry) => {
      const session = registry.sessions[job.sessionId];
      if (!session || session.activeTaskId !== job.id || Number(session.epoch) !== Number(job.sessionEpoch)) return;
      if (job.agentId) session.agentId = job.agentId;
      if (job.agentLabel) session.agentLabel = job.agentLabel;
      session.lastTask = {
        taskId: job.id,
        turnIndex: job.sessionTurn,
        status: outcome,
        finishedAt: job.finishedAt || now,
        error: job.error || null,
        uiDiagnostic: job.uiDiagnostic || null,
        terminalEvidence: job.terminalEvidence || null,
        resultUnavailable: job.resultUnavailable === true,
      };
      session.updatedAt = now;
      if (options.needsAttention === true) {
        session.state = 'needs_attention';
        session.recoveryState = job.recoveryState || outcome;
        session.attention = options.attention || job.error || 'The exact Cursor Agent requires reconciliation before another turn.';
        return;
      }
      session.activeTaskId = null;
      session.lease = null;
      session.recoveryState = null;
      session.attention = null;
      session.state = session.agentId ? 'ready' : 'failed';
    }, { now });
    job.sessionState = options.needsAttention === true ? 'needs_attention' : (job.agentId ? 'ready' : 'failed');
  }

  _safeSettleSessionJob(job, outcome, options = {}) {
    try {
      this._settleSessionJob(job, outcome, options);
    } catch (error) {
      job.sessionState = 'needs_attention';
      job.sessionError = error instanceof Error ? error.message : String(error);
    }
  }

  sessionStatus(sessionId) {
    const session = this._readSession(sessionId);
    return {
      found: !!session,
      ...this.sessionRegistryView(),
      ...(session ? this._sessionView(session) : { sessionId: String(sessionId || '') }),
    };
  }

  async _reconcileSession(sessionId) {
    const initial = this._readSession(sessionId);
    if (!initial) return { found: false, action: 'reconcile', sessionId };
    if (initial.state === 'ready' || initial.state === 'closed' || initial.state === 'failed') {
      return { found: true, changed: false, action: 'reconcile', ...this._sessionView(initial) };
    }
    if (!initial.agentId) {
      return {
        found: true,
        changed: false,
        action: 'reconcile',
        state: 'agent_missing',
        attention: 'No exact agentId is available. Confirm the Cursor task state manually before explicit abandon.',
        ...this._sessionView(initial),
      };
    }
    const projectPath = this._lastLifecycle && this._lastLifecycle.projectPath || this.projectPath || null;
    if (!sameSessionProject(initial.projectPath, projectPath)) {
      throw cursorSessionError('SESSION_WORKSPACE_MISMATCH', `session is bound to ${initial.projectPath}`);
    }
    await this._ensureCursor();
    const probe = {
      agentId: initial.agentId,
      targetId: this._lastLifecycle && this._lastLifecycle.targetId,
      execution: 'parallel_agent',
      effectiveExecution: 'parallel_agent',
      lastRecoveryAt: null,
      recoveryState: null,
      error: null,
    };
    const observed = await this._readStableParallelEntry(probe);
    let result;
    updateCursorSessionRegistry(this.sessionFile, (registry) => {
      const session = registry.sessions[sessionId];
      if (!session) {
        result = { found: false, action: 'reconcile', sessionId };
        return;
      }
      if (Number(session.epoch || 0) !== Number(initial.epoch || 0)
        || session.activeTaskId !== initial.activeTaskId) {
        result = { found: true, changed: false, action: 'reconcile', state: 'stale_observation', ...this._sessionView(session) };
        return;
      }
      const now = new Date().toISOString();
      if (!observed.stable || !observed.entry) {
        session.state = 'needs_attention';
        session.recoveryState = probe.recoveryState || 'history_unavailable';
        session.attention = observed.error || 'The exact Agent state is not stable.';
        session.updatedAt = now;
        result = { found: true, changed: false, action: 'reconcile', state: session.recoveryState, ...this._sessionView(session) };
        return;
      }
      const entry = observed.entry;
      if (entry.showSpinner) {
        session.state = 'needs_attention';
        session.recoveryState = 'running_unowned';
        session.attention = 'The exact Cursor Agent is still running without an attached adapter. Do not submit another turn.';
        session.updatedAt = now;
        result = { found: true, changed: false, action: 'reconcile', state: 'running_unowned', ...this._sessionView(session) };
        return;
      }
      const terminalClass = classifyParallelTerminalIcon(entry.icon);
      if (!['completed', 'cancelled', 'failed'].includes(terminalClass)) {
        session.state = 'needs_attention';
        session.recoveryState = terminalClass === 'needs_attention' ? 'cursor_needs_attention' : 'idle_unconfirmed';
        session.attention = `The exact Cursor Agent has no confirmed terminal state: ${entry.icon || 'unknown'}`;
        session.updatedAt = now;
        result = { found: true, changed: false, action: 'reconcile', state: session.recoveryState, ...this._sessionView(session) };
        return;
      }
      session.lastTask = {
        taskId: session.activeTaskId || session.lastTask && session.lastTask.taskId || null,
        turnIndex: session.turnIndex,
        status: terminalClass,
        finishedAt: now,
        error: terminalClass === 'failed' ? `stable_history_icon:${entry.icon}` : null,
        terminalEvidence: `stable_history_icon:${entry.icon}`,
        resultUnavailable: terminalClass === 'completed',
      };
      session.activeTaskId = null;
      session.lease = null;
      session.state = 'ready';
      session.recoveryState = terminalClass === 'completed' ? 'reconciled_result_uncollected' : null;
      session.attention = terminalClass === 'completed'
        ? 'The interrupted turn completed in Cursor, but its reply was not persisted. Inspect that Agent before the next turn.'
        : null;
      session.updatedAt = now;
      result = { found: true, changed: true, action: 'reconcile', state: terminalClass, ...this._sessionView(session) };
    });
    return result;
  }

  async sessionControl(sessionId, options = {}) {
    const id = String(sessionId || '').trim();
    if (!id) throw cursorSessionError('SESSION_REQUIRED', 'session_id must not be empty');
    const action = String(options.action || '').trim().toLowerCase();
    if (!['reconcile', 'close', 'forget', 'abandon'].includes(action)) {
      throw cursorSessionError('SESSION_ACTION_UNSUPPORTED', 'expected reconcile, close, forget, or abandon');
    }
    if (action === 'reconcile') return this._reconcileSession(id);
    let result;
    updateCursorSessionRegistry(this.sessionFile, (registry) => {
      const session = registry.sessions[id];
      if (!session) {
        result = { found: false, sessionId: id, action };
        return;
      }
      if (action === 'forget') {
        if (options.confirm !== true) throw cursorSessionError('SESSION_CONFIRM_REQUIRED', 'forget requires confirm=true');
        if (session.state !== 'closed') throw cursorSessionError('SESSION_NOT_CLOSED', 'close the session before forgetting it');
        delete registry.sessions[id];
        result = { found: true, changed: true, action, sessionId: id, state: 'forgotten' };
        return;
      }
      if (action === 'abandon') {
        if (options.confirm !== true || options.acknowledgeMayStillWrite !== true || !String(options.reason || '').trim()) {
          throw cursorSessionError('SESSION_ABANDON_CONFIRM_REQUIRED', 'abandon requires confirm=true, acknowledge_may_still_write=true, and a non-empty reason');
        }
        session.lastTask = {
          taskId: session.activeTaskId || session.lastTask && session.lastTask.taskId || null,
          turnIndex: session.turnIndex,
          status: 'abandoned',
          finishedAt: new Date().toISOString(),
          error: String(options.reason).trim(),
          terminalEvidence: 'explicit_session_abandon_acknowledgement',
          resultUnavailable: true,
        };
        session.activeTaskId = null;
        session.lease = null;
        session.state = 'closed';
        session.closedAt = session.lastTask.finishedAt;
        session.updatedAt = session.closedAt;
        session.recoveryState = 'released_unconfirmed';
        session.attention = 'The Bridge mapping was closed without proving that the Cursor Agent stopped; it may still run or write.';
        result = { found: true, changed: true, action, warning: session.attention, ...this._sessionView(session) };
        return;
      }
      if (session.activeTaskId || ['busy', 'creating', 'needs_attention'].includes(session.state)) {
        throw cursorSessionError('SESSION_CLOSE_BLOCKED', 'an active or uncertain Agent must be resolved before close');
      }
      if (session.state === 'closed') {
        result = { found: true, changed: false, action, ...this._sessionView(session) };
        return;
      }
      session.state = 'closed';
      session.closedAt = new Date().toISOString();
      session.updatedAt = session.closedAt;
      result = { found: true, changed: true, action, ...this._sessionView(session) };
    });
    return result;
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
        'external-launch-required',
        'spawn-blocked',
      ]);
      if (!lifecycle || !recoverableStatuses.has(lifecycle.status)) throw error;
      return {
        previousProjectPath,
        ...this.workspaceView(),
        bindingPersisted: true,
        ready: false,
        status: lifecycle.status,
        message: lifecycleFailureSummary(lifecycle, 'CCE initialization is not complete, but the workspace binding was saved.'),
        nextStep: lifecycle.nextStep || 'Resolve the reported condition, then run the same initialization command again.',
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
      message: `CCE is ready to use workspace ${saved.projectPath}.`,
      nextStep: 'You can now use cursor_context_engine or cursor_do directly.',
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

  _refreshModelPreferences() {
    if (!this.modelPreferencesFile) return false;
    const next = readCursorModelPreferences(this.modelPreferencesFile);
    const changed = JSON.stringify(next) !== JSON.stringify(this.modelPreferences);
    this.modelPreferences = next;
    return changed;
  }

  modelPreferencesView() {
    this._refreshModelPreferences();
    return {
      modelPreferencesFile: this.modelPreferencesFile,
      modelPreferencesPersistAcrossRestart: !!this.modelPreferencesFile,
      modelPreferenceTargets: [...CURSOR_MODEL_TARGETS],
      availableEfforts: [...CURSOR_MODEL_EFFORTS],
      modelPreferences: {
        cce: this.modelPreferences.targets.cce,
        cursor_do: this.modelPreferences.targets.cursor_do,
      },
      modelPreferencesUpdatedAt: this.modelPreferences.updatedAt,
    };
  }

  configureModelPreferences(options = {}) {
    this.modelPreferences = updateCursorModelPreferences(this.modelPreferencesFile, options);
    return this.modelPreferencesView();
  }

  _modelPreferenceFor(target) {
    this._refreshModelPreferences();
    const preference = this.modelPreferences.targets[target];
    return preference ? { ...preference } : null;
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

  async recoverNormalAgentsPresentation(lifecycle = this._lastLifecycle, now = Date.now()) {
    if (!shouldRecoverNormalAgentsPresentation({
      runtimeMode: this.runtimeMode,
      workspaceAction: lifecycle?.workspaceAction,
      cursorPid: lifecycle?.cursorPid,
      lastPresentation: this._lastPresentation,
      now,
    })) {
      return null;
    }
    const presentation = await this.applyRuntimePresentation('show');
    if (lifecycle && typeof lifecycle === 'object') lifecycle.presentation = presentation;
    return presentation;
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
    if (!text) throw new Error('query must not be empty');
    if (text.length > 20000) throw new Error('query exceeds the 20,000-character limit');
    if (this._hasGlobalReservation()) {
      throw new Error('A global Cursor reservation has an unconfirmed Stop state; resolve blockingTaskIds from cursor_status first');
    }
    await this._ensureCursor();
    const job = this._enqueue('context_engine', buildContextEnginePrompt(text), {
      timeoutMs: QUERY_TIMEOUT,
      newChat: true,
      execution: 'fifo',
      readOnly: true,
      allowedPaths: [],
      modelPreference: this._modelPreferenceFor('cce'),
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
    if (!text) throw new Error('prompt must not be empty');
    if (text.length > 100000) throw new Error('prompt exceeds the 100,000-character limit');
    if (this._hasGlobalReservation()) {
      throw new Error('A global Cursor reservation has an unconfirmed Stop state; no new task may be submitted until it is explicitly recovered or released');
    }
    const sessionMode = normalizeCursorSessionMode(options.sessionMode, 'isolated');
    if (!sessionMode) {
      throw cursorSessionError('SESSION_MODE_INVALID', `expected ${CURSOR_SESSION_MODES.join(', ')}`);
    }
    const sessionId = String(options.sessionId || '').trim();
    if (sessionMode === 'continue' && !sessionId) {
      throw cursorSessionError('SESSION_REQUIRED', 'session_mode=continue requires session_id');
    }
    if (sessionMode !== 'continue' && sessionId) {
      throw cursorSessionError('SESSION_ID_UNEXPECTED', 'session_id is accepted only with session_mode=continue');
    }
    const requestId = normalizeSessionRequestId(options.requestId);
    if (sessionMode === 'isolated' && requestId) {
      throw cursorSessionError('SESSION_REQUEST_ID_UNEXPECTED', 'request_id is accepted only for a persistent session turn');
    }

    const execution = String(options.execution || (sessionMode === 'isolated' ? 'fifo' : 'parallel_agent'));
    if (execution !== 'fifo' && execution !== 'parallel_agent') {
      throw new Error(`Unsupported execution value ${execution}; expected fifo or parallel_agent`);
    }
    if (sessionMode !== 'isolated' && execution !== 'parallel_agent') {
      throw cursorSessionError('SESSION_EXECUTION_INVALID', 'persistent sessions require execution=parallel_agent and never fall back to FIFO');
    }
    const readOnly = options.readOnly === true;
    const timeoutMs = Math.max(30000, Math.min(900000, Number(options.timeoutMs || 600000)));
    const allowedPaths = Array.isArray(options.allowedPaths)
      ? options.allowedPaths.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (readOnly && allowedPaths.length > 0) {
      throw new Error('read_only=true cannot be combined with allowed_paths because a read-only task cannot declare a write scope');
    }
    if (execution === 'parallel_agent' && !readOnly && allowedPaths.length === 0) {
      throw new Error('A parallel_agent write task must provide allowed_paths; set read_only=true explicitly for a read-only task');
    }
    if (execution === 'parallel_agent' && !readOnly) {
      this._validateParallelAllowedPaths(allowedPaths);
      this._assertNoParallelPathConflict(allowedPaths);
    }
    if (sessionMode === 'continue' && options.readOnlySpecified !== true && options.allowedPathsSpecified !== true) {
      throw cursorSessionError('SESSION_SCOPE_REQUIRED', 'repeat read_only=true or an allowed_paths subset for every continued turn');
    }

    await this._ensureCursor();
    const projectPath = this._lastLifecycle && this._lastLifecycle.projectPath || this.projectPath || null;
    if (sessionMode !== 'isolated' && !projectPath) {
      throw cursorSessionError('SESSION_WORKSPACE_REQUIRED', 'initialize one workspace before creating or continuing a session');
    }

    const contract = String(options.completionContract || '').trim();
    let fullPrompt = text + DO_LANGUAGE_CONTRACT;
    if (readOnly) fullPrompt += '\n\nRead-only boundary: Do not modify, create, or delete files, and do not run commands that change workspace state.';
    if (allowedPaths.length > 0) {
      fullPrompt += '\n\nAllowed modification scope (do not cross this boundary):\n' + allowedPaths.map((x) => '- ' + x).join('\n');
    }
    fullPrompt += contract ? '\n\nAcceptance and reporting contract:\n' + contract : DO_DEFAULT_CONTRACT;

    const taskId = this._nextTaskId();
    let session = null;
    let duplicate = false;
    let modelPreference = this._modelPreferenceFor('cursor_do');
    if (sessionMode === 'create') {
      session = this._claimNewSession({
        taskId,
        projectPath,
        readOnly,
        allowedPaths,
        modelPreference,
        requestId,
        timeoutMs,
      });
    } else if (sessionMode === 'continue') {
      const claimed = this._claimExistingSession({
        sessionId,
        taskId,
        projectPath,
        readOnly,
        allowedPaths,
        requestId,
        timeoutMs,
      });
      session = claimed.session;
      duplicate = claimed.duplicate === true;
      modelPreference = session.modelPreference || null;
      if (duplicate) {
        const existing = this.tasks.get(session.activeTaskId || session.lastTask && session.lastTask.taskId || '');
        return existing
          ? { duplicate: true, ...this._taskView(existing, true) }
          : { duplicate: true, ...this._sessionView(session) };
      }
    }

    const job = this._enqueue('do', fullPrompt, {
      taskId,
      timeoutMs,
      newChat: sessionMode !== 'continue',
      execution,
      readOnly,
      allowedPaths,
      preferLegacyUi: options.preferLegacyUi === true,
      modelPreference,
      projectPath,
      sessionMode,
      sessionId: session && session.id || null,
      sessionTurn: session && session.turnIndex || null,
      sessionEpoch: session && session.epoch || null,
      sessionState: session && session.state || null,
      requestId,
      agentId: sessionMode === 'continue' ? session && session.agentId : null,
      agentLabel: sessionMode === 'continue' ? session && session.agentLabel : null,
    });
    if (options.background !== false) return this._taskView(job);
    await job.promise;
    return this._taskView(job, true);
  }

  _assertNoParallelPathConflict(allowedPaths) {
    if (this._hasGlobalReservation()) {
      throw new Error('A global Cursor reservation has an unconfirmed Stop state; no new parallel_agent write task may be submitted');
    }
    const live = [...this.tasks.values()].filter((job) =>
      job.execution === 'parallel_agent' && !job.readOnly && !isTerminalTask(job));
    for (const job of live) {
      const overlap = allowedPaths.some((a) => job.allowedPaths.some((b) => pathsOverlap(a, b)));
      if (overlap) throw new Error(`parallel_agent allowed_paths overlap task ${job.id}; use fifo or split the work into non-overlapping paths`);
    }
  }

  _validateParallelAllowedPaths(allowedPaths) {
    for (const raw of allowedPaths) {
      const slash = String(raw).replace(/\\/g, '/');
      if (/[*?\[\]{}!]/.test(slash)) throw new Error(`parallel_agent allowed_paths do not accept globs: ${raw}`);
      if (/^[a-zA-Z]:\//.test(slash) || slash.startsWith('/')) {
        throw new Error(`parallel_agent allowed_paths must use workspace-relative paths: ${raw}`);
      }
      const normalized = normalizeAllowedPath(slash);
      if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`parallel_agent allowed_paths must not be empty or escape the workspace: ${raw}`);
      }
    }
  }

  _nextTaskId() {
    return `cursor-${Date.now().toString(36)}-${this.nextTaskId++}`;
  }

  _enqueue(kind, prompt, options) {
    const id = options.taskId || this._nextTaskId();
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
      preferLegacyUi: options.preferLegacyUi === true,
      execution: options.execution || 'fifo',
      effectiveExecution: options.execution || 'fifo',
      readOnly: options.readOnly === true,
      allowedPaths: options.allowedPaths || [],
      modelPreference: options.modelPreference ? { ...options.modelPreference } : null,
      modelSelection: options.modelPreference ? { configured: true, applied: false, ...options.modelPreference } : null,
      projectPath: options.projectPath || this._lastLifecycle && this._lastLifecycle.projectPath || this.projectPath || null,
      sessionMode: options.sessionMode || 'isolated',
      sessionId: options.sessionId || null,
      sessionTurn: options.sessionTurn || null,
      sessionEpoch: options.sessionEpoch || null,
      sessionState: options.sessionState || null,
      requestId: options.requestId || null,
      responseBaseline: null,
      status: 'queued',
      phase: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      sentAt: null,
      agentId: options.agentId || null,
      provisionalAgentId: null,
      agentLabel: options.agentLabel || null,
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
      uiDiagnostic: null,
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
    this._safeSettleSessionJob(job, 'completed');
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
    if (e.uiDiagnostic) job.uiDiagnostic = e.uiDiagnostic;
    if (e.terminalEvidence) job.terminalEvidence = e.terminalEvidence;
    job.status = 'failed';
    job.phase = 'failed';
    job.finishedAt = new Date().toISOString();
    job.recoveryState = null;
    job.cancelRequested = false;
    job.reservationScope = null;
    this._safeSettleSessionJob(job, 'failed');
    if (!job.settled) {
      job.settled = true;
      job.reject(e);
    }
  }

  _cancelJob(job, reason, options = {}) {
    if (isTerminalTask(job)) return this._taskView(job, true);
    const message = String(reason || 'Task cancelled').trim() || 'Task cancelled';
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
    this._safeSettleSessionJob(job, 'cancelled', {
      needsAttention: options.underlyingStopConfirmed !== true && job.sendState === 'sent',
      attention: 'Cancellation did not prove that the exact Cursor Agent stopped.',
    });
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
    this._safeSettleSessionJob(job, 'needs_attention', { needsAttention: true });
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
          adapterStartCwd: this.adapterStartCwd,
          ...(this.projectPath ? { projectPath: this.projectPath } : {}),
        });
        this._lastLifecycle = lifecycleFromEnsureResult(rr, this.runtimeMode);
        if (!rr.ok && rr.status === 'workspace-not-ready' && rr.projectPath) {
          const agentsWorkspace = await this._findAgentsWorkspace(rr.projectPath);
          if (agentsWorkspace) {
            this._lastLifecycle = promoteAgentsWorkspaceLifecycle(this._lastLifecycle, agentsWorkspace);
          }
        }
        if (rr.ok && rr.lifecycleMode === 'attached' && rr.workspaceAction === 'reused-agents-window' && rr.projectPath) {
          const agentsWorkspace = await this._findAgentsWorkspace(rr.projectPath);
          if (agentsWorkspace) {
            this._lastLifecycle = promoteAgentsWorkspaceLifecycle(this._lastLifecycle, agentsWorkspace);
          } else {
            this._lastLifecycle = {
              ...this._lastLifecycle,
              status: 'workspace-not-ready',
              message: `Cursor is reachable, but Cursor Bridge could not verify workspace ${rr.projectPath} in the attached Agents Window.`,
              needsAction: 'open_workspace_in_cursor',
              nextStep: `Open workspace ${rr.projectPath} in Cursor, then retry the same operation.`,
              retryable: true,
            };
          }
        }
        if (this.runtimeMode === 'minimal') {
          this._lastPresentation = rr.presentation
            ? { ...rr.presentation, at: new Date().toISOString() }
            : await this.applyRuntimePresentation('hide');
        } else {
          await this.recoverNormalAgentsPresentation(this._lastLifecycle);
        }
        const life = 'adapterPid=' + this._lastLifecycle.adapterPid + ' supervisorPid=' + this._lastLifecycle.supervisorPid + ' reused=' + this._lastLifecycle.reusedSupervisor + ' reason=' + this._lastLifecycle.launchReason;
        if ((!rr.ok || this._lastLifecycle.status === 'workspace-not-ready') && this._lastLifecycle.status !== 'agents-workspace-ready') {
          const lifecycleError = new Error([
            lifecycleFailureSummary(this._lastLifecycle, rr.message || `Cursor lifecycle failed: ${rr.status}`),
            rr.nextStep,
          ].filter(Boolean).join(' '));
          lifecycleError.lifecycle = this._lastLifecycle;
          throw lifecycleError;
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
        console.error('🪟 Cursor self-healing launch: ' + (rr.message || rr.status) + ' | ' + life);
      } catch (e) {
      console.error('⚠️ Cursor self-healing failed; CCE or delegation was stopped to avoid driving the wrong workspace:', e.message);
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
            const submitted = await this._withUiLock(() =>
              job.sessionMode === 'continue'
                ? this._submitSessionTurn(job)
                : this._submitParallelAgent(job));
            if (submitted.fallbackReason) {
              if (job.sessionMode !== 'isolated') {
                throw cursorSessionError(
                  'SESSION_CONTINUITY_UNAVAILABLE',
                  `${submitted.fallbackReason}; persistent sessions never fall back to FIFO`,
                );
              }
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
              try {
                this._bindSessionAgent(job);
              } catch (error) {
                if (job.sendState === 'sent' || job.sentAt) error.sent = true;
                throw error;
              }
              job.sentAt = job.sentAt || new Date().toISOString();
              job.phase = 'running';
              job.reservationScope = job.readOnly ? 'agent' : 'paths';
              if (shouldScheduleParallelOriginRestore(job)
                  && !this.parallelRestoreAgentId && submitted.previousSelectedId) {
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
          this._orphanParallelJob(job, new Error(`Unable to confirm that the Cursor Agent stopped: ${stopped.error || stopped.state}`));
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
        this._cancelJob(job, job.cancelReason || error.message || 'Task cancelled', {
                underlyingStopConfirmed: true,
              });
            } else {
              job.cancelRequested = false;
      this._orphanParallelJob(job, new Error('Cancellation was requested, but Cursor could not be confirmed stopped; the reservation remains held'));
              job.recoveryState = 'cancel_unconfirmed';
            }
          } else if (error && error.confirmedTerminal) {
            this.activeParallel.delete(job.id);
            this._failJob(job, error);
          } else if (error && error.sent) {
      job.error = `Submission state is uncertain; monitoring continues by agentId: ${error.message}`;
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
    let page = await findPage({
      targetId: options.targetId || (this._lastLifecycle && this._lastLifecycle.targetId),
      purpose: 'fifo',
      preferAgentsV2: options.preferLegacyUi !== true,
      preferLegacy: options.preferLegacyUi === true,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      options.targetId = page.id;
      options.targetUiFlavor = page.capabilities && page.capabilities.uiFlavor || options.targetUiFlavor || null;
      const c = makeClient(page.webSocketDebuggerUrl);
      await c.ready;
      try {
        this._throwIfCancelledBeforeSend(options);
        await this._ensureChatPanel(c);
        const historyBefore = this._canBindFifoHistory(options)
          ? await this._snapshotAgentEntries(c)
          : null;
        if (historyBefore) options.historyBeforeEntries = historyBefore;
        if (options.newChat !== false) {
          try {
            await this._newChat(c, {
              uiFlavor: options.targetUiFlavor,
              projectPath: options.projectPath || this._lastLifecycle && this._lastLifecycle.projectPath || this.projectPath,
            });
          } catch (error) {
            if (attempt === 0 && options.targetUiFlavor === 'agents_v2' && isAgentsWorkspaceBindError(error)) {
              const fallback = await findPage({ purpose: 'fifo', preferLegacy: true });
              if (fallback && fallback.id !== page.id) {
                options.fallbackReason = 'agents_window_unbound_use_workbench';
                page = fallback;
                continue;
              }
            }
            throw error;
          }
        }
        await this._bindFifoAgentAfterComposerReady(c, options, historyBefore);
        await this._bindFifoComposerIdentity(c, options);
        this._throwIfCancelledBeforeSend(options);
        await this._applyModelPreference(c, options.modelPreference, options);
        this._throwIfCancelledBeforeSend(options);
        const filled = await evalJS(c, exprFill(prompt));
        if (filled === 'NO_INPUT') await this._throwChatPanelUnavailableAfterNoInput(c);
      if (filled === 'NO_INPUT' || filled === 'EXEC_FAIL') throw new Error('Failed to enter the query because the input state was invalid');
        await sleep(450);
        this._throwIfCancelledBeforeSend(options);
        let baseline = { messageCount: 0 };
        try { baseline = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch {}
        const providerErrorBaseline = providerErrorSignature(await this._readProviderError(c));
        options.sendState = 'dispatching';
        try {
          await chord(c, 0, 'Enter', 'Enter', 13);
          await this._confirmSubmission(c, baseline.messageCount || 0, providerErrorBaseline);
          options.sendState = 'sent';
          options.sentAt = options.sentAt || new Date().toISOString();
          await this._bindFifoAgentAfterSend(c, options, historyBefore, providerErrorBaseline);
          await this._bindFifoComposerIdentity(c, options);
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
          error.sent = true;
          throw error;
        }
      } finally { c.close(); }
    }
  }

  _throwIfCancelledBeforeSend(job) {
    if (!job || !job.cancelRequested || job.sendState === 'dispatching' || job.sendState === 'sent') return;
      const error = new Error(job.cancelReason || 'Task cancelled');
    error.cancelled = true;
    error.stopConfirmed = true;
    error.preSend = true;
    throw error;
  }

  async _readModelPickerTrigger(c) {
    try {
      return JSON.parse(await evalJS(c, EXPR_MODEL_PICKER_TRIGGER) || '{}');
    } catch {
      return { found: false, state: 'trigger_unreadable' };
    }
  }

  async _readModelPickerRows(c) {
    try {
      const snapshot = JSON.parse(await evalJS(c, EXPR_MODEL_PICKER_ROWS) || '{}');
      return { open: snapshot.open === true, rows: Array.isArray(snapshot.rows) ? snapshot.rows : [] };
    } catch {
      return { open: false, rows: [] };
    }
  }

  async _clickModelPickerPoint(c, point) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
      throw new Error('Cursor model picker returned an invalid target');
    }
    const x = Number(point.x);
    const y = Number(point.y);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async _hoverModelPickerPoint(c, point) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return;
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number(point.x), y: Number(point.y) });
  }

  async _openModelPicker(c) {
    const trigger = await this._readModelPickerTrigger(c);
    if (!trigger.found) {
      throw new Error('Cursor model picker is unavailable in the active Agent composer');
    }
    let snapshot = await this._readModelPickerRows(c);
    if (!snapshot.open) {
      await this._clickModelPickerPoint(c, trigger);
      await sleep(450);
      snapshot = await this._readModelPickerRows(c);
    }
    if (!snapshot.open) throw new Error('Cursor model picker did not open');
    return { trigger, ...snapshot };
  }

  async _closeModelPicker(c) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this._readModelPickerRows(c);
      if (!snapshot.open) return;
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await sleep(150);
    }
    if ((await this._readModelPickerRows(c)).open) throw new Error('Cursor model picker did not close after selection');
  }

  async _openModelPickerControl(c, snapshot, controlKind) {
    const control = (snapshot && snapshot.rows || []).find((row) => row.kind === controlKind && row.disabled !== true);
    if (!control) return snapshot;
    await this._clickModelPickerPoint(c, control);
    await sleep(400);
    let next = await this._readModelPickerRows(c);
    const expectedKind = controlKind === 'model_control' ? 'model' : 'parameter';
    if (!next.rows.some((row) => row.kind === expectedKind)) {
      await this._hoverModelPickerPoint(c, control);
      await sleep(350);
      next = await this._readModelPickerRows(c);
    }
    return next;
  }

  async _findModelPickerModel(c, snapshot, requestedModel) {
    let modelRow = selectModelPickerRow(snapshot && snapshot.rows, requestedModel, 'model');
    if (modelRow) return { snapshot, modelRow };
    const expanded = await this._openModelPickerControl(c, snapshot, 'model_control');
    modelRow = selectModelPickerRow(expanded && expanded.rows, requestedModel, 'model');
    return { snapshot: expanded, modelRow };
  }

  _inspectModelPickerRows(snapshot, requested, kind) {
    const rows = (snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [])
      .filter((row) => row && row.disabled !== true && row.kind === kind);
    const wanted = normalizeModelPickerText(requested);
    const exact = rows.filter((row) => normalizeModelPickerText(row.text) === wanted);
    return {
      snapshot,
      row: exact.length === 1 ? exact[0] : null,
      ambiguous: exact.length > 1,
      available: rows.map((row) => row.text),
    };
  }

  async _waitForModelPickerMatch(c, requested, kind, job, options = {}) {
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 700));
    const pollMs = Math.max(10, Number(options.pollMs ?? 100));
    const stableMs = Math.max(0, Number(options.stableMs ?? 250));
    const deadline = Date.now() + timeoutMs;
    let stableSignature = null;
    let stableSince = 0;
    let last = this._inspectModelPickerRows({ open: false, rows: [] }, requested, kind);
    do {
      this._throwIfCancelledBeforeSend(job);
      last = this._inspectModelPickerRows(await this._readModelPickerRows(c), requested, kind);
      if (last.row) return { ...last, state: 'matched' };
      const signature = JSON.stringify(last.available);
      if (last.available.length > 0) {
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= stableMs) {
          return { ...last, state: last.ambiguous ? 'ambiguous' : 'unsupported' };
        }
      } else {
        stableSignature = null;
        stableSince = 0;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return { ...last, state: last.ambiguous ? 'ambiguous' : 'not_rendered' };
  }

  async _selectedEffortRow(c, modelRow, effort, job) {
    const requested = cursorEffortUiValue(effort);
    const snapshot = await this._readModelPickerRows(c);
    const immediate = this._inspectModelPickerRows(snapshot, requested, 'parameter');
    if (immediate.row) return { ...immediate, state: 'matched', attempts: ['visible'] };

    const attempts = [];
    const effortControl = (snapshot.rows || [])
      .find((row) => row.kind === 'effort_control' && row.disabled !== true);
    if (effortControl) {
      this._throwIfCancelledBeforeSend(job);
      attempts.push('effort_control');
      await this._clickModelPickerPoint(c, effortControl);
      const result = await this._waitForModelPickerMatch(c, requested, 'parameter', job, { timeoutMs: 700 });
      if (result.state !== 'not_rendered') return { ...result, attempts };
    }

    this._throwIfCancelledBeforeSend(job);
    attempts.push('model_hover');
    await this._hoverModelPickerPoint(c, modelRow);
    let result = await this._waitForModelPickerMatch(c, requested, 'parameter', job, { timeoutMs: 700 });
    if (result.state !== 'not_rendered') return { ...result, attempts };

    if (modelRow && modelRow.hasSubmenu) {
      this._throwIfCancelledBeforeSend(job);
      attempts.push('model_click');
      await this._clickModelPickerPoint(c, modelRow);
      result = await this._waitForModelPickerMatch(c, requested, 'parameter', job, { timeoutMs: 1100 });
    }
    return { ...result, attempts };
  }

  async _waitForSelectedModelPickerRow(c, requested, kind, job, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    do {
      this._throwIfCancelledBeforeSend(job);
      const inspected = this._inspectModelPickerRows(await this._readModelPickerRows(c), requested, kind);
      if (inspected.row && inspected.row.selected) return inspected.row;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return null;
  }

  async _applyModelPreference(c, preference, job) {
    if (!preference) {
      if (job) job.modelSelection = null;
      return null;
    }
    const requestedModel = String(preference.model || '').trim();
    const requestedEffort = preference.effort ? normalizeCursorModelEffort(preference.effort, '') : null;
    let modelRow = null;
    let effectiveEffort = null;
    let primaryError = null;
    try {
      const opened = await this._openModelPicker(c);
      let located = await this._findModelPickerModel(c, opened, requestedModel);
      modelRow = located.modelRow;
      if (!modelRow) {
        throw createModelSelectionError(
          `Configured Cursor model is unavailable or ambiguous: ${requestedModel}`,
          'model_unavailable',
          false,
          { available: (located.snapshot.rows || []).filter((row) => row.kind === 'model').map((row) => row.text) },
        );
      }

      let effortPickerReopened = false;
      const resolveEffort = async () => {
        let outcome = await this._selectedEffortRow(c, modelRow, requestedEffort, job);
        if (!outcome.row && outcome.state === 'not_rendered' && !effortPickerReopened) {
          effortPickerReopened = true;
          await this._closeModelPicker(c);
          const reopened = await this._openModelPicker(c);
          located = await this._findModelPickerModel(c, reopened, requestedModel);
          modelRow = located.modelRow;
          if (!modelRow) {
            throw createModelSelectionError(
              `Cursor model row disappeared while applying effort: ${requestedModel}`,
              'model_unavailable',
              true,
            );
          }
          outcome = await this._selectedEffortRow(c, modelRow, requestedEffort, job);
          outcome.attempts = ['picker_reopen', ...(outcome.attempts || [])];
        }
        return outcome;
      };
      const throwEffortFailure = (outcome) => {
        const failureClass = outcome.state === 'ambiguous'
          ? 'effort_ambiguous'
          : outcome.state === 'unsupported' ? 'effort_unsupported' : 'effort_menu_not_rendered';
        const message = failureClass === 'effort_menu_not_rendered'
          ? `Cursor effort menu did not render for model ${requestedModel}`
          : failureClass === 'effort_ambiguous'
            ? `Cursor model ${requestedModel} exposes ambiguous effort ${requestedEffort}`
            : `Cursor model ${requestedModel} does not expose effort ${requestedEffort}`;
        throw createModelSelectionError(
          message,
          failureClass,
          failureClass === 'effort_menu_not_rendered',
          { available: outcome.available || [], attempts: outcome.attempts || [] },
        );
      };

      if (requestedEffort && modelRow.hasSubmenu) {
        const selectedEffort = await resolveEffort();
        if (!selectedEffort.row) throwEffortFailure(selectedEffort);
        if (!selectedEffort.row.selected || !modelRow.selected) {
          this._throwIfCancelledBeforeSend(job);
          await this._clickModelPickerPoint(c, selectedEffort.row);
          await sleep(550);
        }
      } else if (!modelRow.selected) {
        this._throwIfCancelledBeforeSend(job);
        await this._clickModelPickerPoint(c, modelRow);
        await sleep(550);
      }

      let trigger = await this._readModelPickerTrigger(c);
      if (!trigger.found || !normalizeModelPickerText(trigger.text).includes(normalizeModelPickerText(requestedModel))) {
        const reopened = await this._openModelPicker(c);
        located = await this._findModelPickerModel(c, reopened, requestedModel);
        const selected = selectModelPickerRow(located.snapshot.rows.filter((row) => row.selected), requestedModel, 'model');
        if (!selected) {
          throw createModelSelectionError(
            `Cursor did not confirm configured model ${requestedModel}`,
            'model_not_confirmed',
            true,
          );
        }
        modelRow = selected;
      }

      if (requestedEffort) {
        const reopened = await this._openModelPicker(c);
        located = await this._findModelPickerModel(c, reopened, requestedModel);
        modelRow = located.modelRow;
        if (!modelRow) {
          throw createModelSelectionError(
            `Cursor model row disappeared while applying effort: ${requestedModel}`,
            'model_unavailable',
            true,
          );
        }
        const effortOutcome = await resolveEffort();
        if (!effortOutcome.row) throwEffortFailure(effortOutcome);
        let effortRow = effortOutcome.row;
        if (!effortRow.selected) {
          effortRow = await this._waitForSelectedModelPickerRow(
            c,
            cursorEffortUiValue(requestedEffort),
            'parameter',
            job,
          );
        }
        if (!effortRow || !effortRow.selected) {
          throw createModelSelectionError(
            `Cursor did not confirm effort ${requestedEffort} for model ${requestedModel}`,
            'effort_not_confirmed',
            true,
          );
        }
        effectiveEffort = requestedEffort;
      }
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error(String(error));
      let failure = primaryError.modelSelectionFailure;
      if (!failure) {
        const pickerUnavailable = /model picker (?:is unavailable|did not open)/i.test(primaryError.message);
        failure = {
          failureClass: pickerUnavailable ? 'picker_did_not_open' : 'probe_error',
          retryable: true,
        };
      }
      const diagnostic = {
        configured: true,
        applied: false,
        requestedModel,
        requestedEffort,
        failureClass: failure.failureClass,
        retryable: failure.retryable === true,
        errorCode: primaryError.code || `CURSOR_MODEL_${String(failure.failureClass).toUpperCase()}`,
        available: failure.available || [],
        attempts: failure.attempts || [],
        runtimeMode: this.runtimeMode,
        lastError: primaryError.message,
        failedAt: new Date().toISOString(),
      };
      primaryError.modelSelection = diagnostic;
      if (job) job.modelSelection = diagnostic;
      throw primaryError;
    } finally {
      try {
        await this._closeModelPicker(c);
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        if (!primaryError) {
          const error = createModelSelectionError(message, 'picker_cleanup_failed', true);
          const diagnostic = {
            configured: true,
            applied: false,
            requestedModel,
            requestedEffort,
            failureClass: 'picker_cleanup_failed',
            retryable: true,
            errorCode: error.code,
            available: [],
            attempts: [],
            runtimeMode: this.runtimeMode,
            lastError: message,
            failedAt: new Date().toISOString(),
          };
          error.modelSelection = diagnostic;
          if (job) job.modelSelection = diagnostic;
          throw error;
        }
        if (primaryError.modelSelection) primaryError.modelSelection.cleanupError = message;
        if (job && job.modelSelection) job.modelSelection.cleanupError = message;
      }
    }

    const trigger = await this._readModelPickerTrigger(c);
    const result = {
      configured: true,
      applied: true,
      requestedModel,
      requestedEffort,
      effectiveModel: modelRow.text || trigger.text,
      effectiveEffort,
      pickerDetail: trigger.detail || null,
      verifiedAt: new Date().toISOString(),
    };
    if (job) job.modelSelection = result;
    return result;
  }

  async _readChatPanelDiagnostic(c) {
    try {
      return JSON.parse(await evalJS(c, EXPR_PAGE_CAPABILITIES) || '{}');
    } catch (error) {
      return { probeError: error instanceof Error ? error.message : String(error) };
    }
  }

  async _ensureChatPanel(c) {
    const snapshot = await this._readChatPanelDiagnostic(c);
    if (snapshot.modalVisible !== true && snapshot.hasWritableInput === true) return snapshot;
    throw createChatPanelUnavailableError(snapshot);
  }

  async _throwChatPanelUnavailableAfterNoInput(c) {
    const snapshot = await this._readChatPanelDiagnostic(c);
    throw createChatPanelUnavailableError({
      ...snapshot,
      inputStateChanged: snapshot.hasWritableInput === true,
    });
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
    if (!(await this._ensureHistoryOpen(c))) throw new Error('Cursor Agent list adapter is unavailable');
    try {
      const snapshot = JSON.parse(await evalJS(c, EXPR_HISTORY_ENTRIES));
    if (!snapshot.ok) throw new Error(snapshot.error || 'Agent History React adapter is unavailable');
      return snapshot.entries || [];
    } finally {
      if (!keepOpen) await this._closeHistory(c);
    }
  }

  _canBindFifoHistory(job) {
    return !!job;
  }

  async _snapshotAgentEntries(c) {
    try {
      return await this._readAgentEntries(c);
    } catch {
      return null;
    }
  }

  async _resolveNewAgent(c, beforeEntries, options = {}) {
    if (!Array.isArray(beforeEntries)) return null;
    try {
      const candidate = selectNewAgentEntry(beforeEntries, await this._readAgentEntries(c));
      if (!candidate) return null;
      if (options.requireActive
        && !candidate.showSpinner
        && classifyParallelTerminalIcon(candidate.icon) === 'unknown') {
        return null;
      }
      return candidate;
    } catch {
      return null;
    }
  }

  _applyAgentIdentity(job, agent) {
    if (!job || !agent || !agent.id) return;
    job.agentId = agent.id;
    job.agentLabel = agent.label || job.agentLabel || null;
  }

  async _bindFifoComposerIdentity(c, job) {
    if (!this._canBindFifoHistory(job) || (job && job.agentId)) return;
    try {
      const snapshot = JSON.parse(await evalJS(c, EXPR_VISIBLE_COMPOSER) || '{}');
      if (snapshot && snapshot.ok && snapshot.id) this._applyAgentIdentity(job, { id: snapshot.id });
    } catch {}
  }

  async _bindFifoAgentAfterComposerReady(c, job, beforeEntries) {
    if (!this._canBindFifoHistory(job) || !Array.isArray(beforeEntries)) return;
    if (job.newChat === false) {
      const selected = beforeEntries.find((entry) => entry && entry.isSelected && entry.id);
      if (selected) this._applyAgentIdentity(job, selected);
      return;
    }
    for (let i = 0; i < 5 && !job.agentId; i++) {
      const agent = await this._resolveNewAgent(c, beforeEntries, { requireActive: false });
      if (agent) {
        this._applyAgentIdentity(job, agent);
        return;
      }
      await sleep(350);
    }
    if (job.agentId) return;
    try {
      const after = await this._readAgentEntries(c);
      const selected = (after || []).find((entry) => entry && entry.isSelected && entry.id);
      if (selected) this._applyAgentIdentity(job, selected);
    } catch {}
  }

  async _bindFifoAgentAfterSend(c, job, beforeEntries, providerErrorBaseline) {
    if (!this._canBindFifoHistory(job) || !Array.isArray(beforeEntries)) return;
    for (let i = 0; i < 24; i++) {
      await sleep(350);
      await this._throwIfNewProviderError(c, providerErrorBaseline);
      let entries = null;
      try { entries = await this._readAgentEntries(c); } catch {}
      if (!Array.isArray(entries)) continue;
      const promoted = selectPromotedFifoEntry(beforeEntries, job.agentId, entries);
      if (promoted) {
        job.provisionalAgentId = job.agentId || null;
        this._applyAgentIdentity(job, promoted);
        return;
      }
      const current = job.agentId ? entries.find((entry) => entry && entry.id === job.agentId) : null;
      if (current && isDurablyRegisteredParallelEntry(current)) return;
      if (!job.agentId) {
        const candidate = selectNewAgentEntry(beforeEntries, entries);
        if (candidate && isDurablyRegisteredParallelEntry(candidate)) {
          this._applyAgentIdentity(job, candidate);
          return;
        }
      }
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
      const error = new Error(`Cursor did not accept the submission (submit_not_accepted: ${clicked || 'unknown'}); the prompt remains in the input and no orphan task was created`);
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
      return { fallbackReason: `parallel_agent prerequisite is unavailable: ${e.message}` };
      }
      const previousSelectedId = (before.find((e) => e.isSelected) || {}).id || null;
      this._throwIfCancelledBeforeSend(job);
      let createdForWorkspace = false;
      try {
        createdForWorkspace = job.targetUiFlavor === 'agents_v2' && job.projectPath
          ? await this._newChat(c, { uiFlavor: job.targetUiFlavor, projectPath: job.projectPath })
          : await this._clickNewAgent(c, false);
      } catch (error) {
        if (isAgentsWorkspaceBindError(error)) {
      return { fallbackReason: 'Agents Window could not bind the current repository; downgraded to FIFO/workbench before submission' };
        }
        throw error;
      }
      if (!createdForWorkspace) {
      return { fallbackReason: 'Cursor New Agent button was not found; downgraded to FIFO before submission' };
      }

      let provisionalAgent = null;
      // Cursor may register a local:<UUID> draft before submission. Keep that identity provisional:
      // publishing it as agentId would let cancel/reap callers observe an ID that can still be replaced.
      for (let i = 0; i < 5 && !provisionalAgent; i++) {
        try { provisionalAgent = selectUniqueNewAgentEntry(before, await this._readAgentEntries(c)); } catch {}
        if (!provisionalAgent) await sleep(350);
      }
      if (provisionalAgent) job.provisionalAgentId = provisionalAgent.id;

      await this._closeHistory(c);
      await this._ensureChatPanel(c);
      this._throwIfCancelledBeforeSend(job);
      await this._applyModelPreference(c, job.modelPreference, job);
      this._throwIfCancelledBeforeSend(job);
      const filled = await evalJS(c, exprFill(job.prompt));
      if (filled === 'NO_INPUT') await this._throwChatPanelUnavailableAfterNoInput(c);
    if (filled === 'NO_INPUT' || filled === 'EXEC_FAIL') throw new Error('Failed to enter the parallel_agent task');
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
      let agent = null;
      let ambiguousAgentIds = [];
      for (let i = 0; i < 40 && !agent; i++) {
        await sleep(350);
        await this._throwIfNewProviderError(c, providerErrorBaseline);
        try {
          const entries = await this._readAgentEntries(c);
          if (!job.provisionalAgentId) {
            provisionalAgent = selectUniqueNewAgentEntry(before, entries);
            if (provisionalAgent) job.provisionalAgentId = provisionalAgent.id;
          }
          agent = selectPromotedParallelEntry(before, job.provisionalAgentId, entries);
          if (!agent) {
            const fresh = listNewAgentEntries(before, entries);
            const selectedDurable = fresh.filter((entry) => entry.isSelected === true && isDurablyRegisteredParallelEntry(entry));
            if (selectedDurable.length > 1) ambiguousAgentIds = selectedDurable.map((entry) => entry.id);
          }
        } catch {}
      }
      if (!agent) {
      const e = new Error(ambiguousAgentIds.length > 1
        ? `The task was submitted, but multiple durable Agent History rows matched (${ambiguousAgentIds.join(', ')}); identity was not guessed and the reservation remains held`
        : job.provisionalAgentId
          ? `Cursor Agent draft ${job.provisionalAgentId} was submitted but did not promote to one durable Agent History row; the reservation remains held and automatic resubmission is forbidden`
          : 'The task may have been submitted, but a unique agentId could not be captured from Agent History; the reservation remains held and automatic resubmission is forbidden');
        e.sent = true;
        e.requiresGlobalReservation = !!job.provisionalAgentId || ambiguousAgentIds.length > 1;
        e.recoveryState = ambiguousAgentIds.length > 1
          ? 'ambiguous_agent_identity'
          : job.provisionalAgentId ? 'awaiting_durable_history' : 'unbound_agent';
        throw e;
      }
      this._applyAgentIdentity(job, agent);
      return { agent, previousSelectedId };
    } catch (e) {
      if (sent) e.sent = true;
      throw e;
    } finally {
      await this._closeHistory(c);
      c.close();
    }
  }

  async _readResponseSnapshot(c) {
    let snapshot = { messageCount: 0, replyLength: 0, replyHash: 0, stop: 0 };
    try { snapshot = JSON.parse(await evalJS(c, EXPR_SNAP) || '{}'); } catch {}
    return {
      messageCount: Number(snapshot.messageCount || 0),
      replyLength: Number(snapshot.replyLength || 0),
      replyHash: Number(snapshot.replyHash || 0),
      stop: Number(snapshot.stop || 0),
    };
  }

  async _captureSessionResponseBaseline(c, timeoutMs = 15000, pollMs = 250) {
    const deadline = Date.now() + timeoutMs;
    let lastKey = '';
    while (Date.now() < deadline) {
      const snapshot = await this._readResponseSnapshot(c);
      const key = snapshot.messageCount > 0 && snapshot.replyLength > 0 && snapshot.stop === 0
        ? `${snapshot.messageCount}:${snapshot.replyLength}:${snapshot.replyHash}`
        : '';
      if (key && key === lastKey) {
        return {
          messageCount: snapshot.messageCount,
          replyLength: snapshot.replyLength,
          replyHash: snapshot.replyHash,
        };
      }
      lastKey = key;
      await sleep(pollMs);
    }
    throw cursorSessionError('SESSION_BASELINE_UNAVAILABLE', 'the previous completed reply did not hydrate to a stable snapshot before continuation');
  }

  async _submitSessionTurn(job) {
    if (!job.agentId) throw cursorSessionError('SESSION_AGENT_NOT_BOUND', job.sessionId || 'unknown session');
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
      const entries = await this._readAgentEntries(c, true);
      const target = entries.find((entry) => entry && entry.id === job.agentId);
      if (!target) {
        throw cursorSessionError('SESSION_AGENT_NOT_FOUND', `Agent History does not contain ${job.agentId}`);
      }
      const previousSelectedId = (entries.find((entry) => entry.isSelected) || {}).id || null;
      if (!target.isSelected) {
        const opened = await evalJS(c, exprOpenAgent(job.agentId));
        if (opened !== 'OPENED') {
          throw cursorSessionError('SESSION_AGENT_OPEN_FAILED', `${job.agentId}: ${opened}`);
        }
      }
      await this._closeHistory(c);
      await this._waitForSelectedAgent(c, job.agentId);
      await this._ensureChatPanel(c);
      this._throwIfCancelledBeforeSend(job);
      await this._applyModelPreference(c, job.modelPreference, job);
      this._throwIfCancelledBeforeSend(job);
      job.responseBaseline = await this._captureSessionResponseBaseline(c);
      const providerErrorBaseline = providerErrorSignature(await this._readProviderError(c));
      const filled = await evalJS(c, exprFill(job.prompt));
      if (filled === 'NO_INPUT') await this._throwChatPanelUnavailableAfterNoInput(c);
      if (filled === 'NO_INPUT' || filled === 'EXEC_FAIL') {
        throw cursorSessionError('SESSION_INPUT_FAILED', 'failed to enter the continued task');
      }
      await sleep(350);
      this._throwIfCancelledBeforeSend(job);
      job.sendState = 'dispatching';
      await chord(c, 0, 'Enter', 'Enter', 13);
      await this._confirmSubmission(c, job.responseBaseline.messageCount, providerErrorBaseline);
      sent = true;
      job.sendState = 'sent';
      job.sentAt = new Date().toISOString();
      return {
        agent: { id: job.agentId, label: target.label || job.agentLabel || null },
        previousSelectedId,
      };
    } catch (error) {
      if (sent) error.sent = true;
      throw error;
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
        let entries = await this._readAgentEntries(c);
        let entry = entries.find((e) => e.id === job.agentId) || null;
        if (!entry && (job.execution === 'fifo' || job.effectiveExecution === 'fifo')) {
          const promoted = selectPromotedFifoEntry(job.historyBeforeEntries, job.agentId, entries);
          if (promoted) {
            job.provisionalAgentId = job.agentId || null;
            this._applyAgentIdentity(job, promoted);
            entry = promoted;
          }
        }
        if (entry && entry.registeredBySectionMap && classifyParallelTerminalIcon(entry.icon) === 'unknown') {
          const opened = await evalJS(c, exprOpenAgent(job.agentId));
          if (opened === 'OPENED') {
            await sleep(350);
            entries = await this._readAgentEntries(c);
            entry = entries.find((e) => e.id === job.agentId) || entry;
          }
        }
        return entry;
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
        if (transientErrors >= 45) throw new Error(`Agent History remained unreadable: ${e.message}`);
        continue;
      }
      if (!entry) {
        missingPolls++;
        if (missingPolls >= 45) throw new Error(`Agent History continued to omit ${job.agentId}`);
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
        throw new Error(`Cursor Agent ${job.agentId} is waiting for user action`);
          }
          if (terminalClass === 'cancelled') {
            await this._withJobLock(job, async () => {
              if (!this._monitorOwns(job, generation)) return;
              job.terminalEvidence = `stable_history_icon:${entry.icon}`;
        this._cancelJob(job, `Cursor Agent ${job.agentId} reached a stable cancelled terminal state`, {
                underlyingStopConfirmed: true,
              });
            });
            return;
          }
        const error = new Error(`Cursor Agent ${job.agentId} reached stable failure state ${entry.icon}`);
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
        job.error = `Result collection attempt ${collectionAttempts} did not complete; retrying: ${error.message}`;
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
    const detail = lastCollectionError ? `; last collection error: ${lastCollectionError}` : '';
    throw new Error(`Cursor parallel_agent task timed out (${job.timeoutMs}ms)${detail}`);
  }

  async _requestExactAgentSelection(c, agentId) {
    if (!(await this._ensureHistoryOpen(c))) return 'REACT_ADAPTER_UNAVAILABLE';
    try {
      return await evalJS(c, exprOpenAgent(agentId));
    } finally {
      await this._closeHistory(c);
    }
  }

  async _waitForSelectedAgent(c, agentId, timeoutMs = 15000, retryDelayMs = 2500, pollMs = 250) {
    const deadline = Date.now() + timeoutMs;
    const retryAt = Date.now() + retryDelayMs;
    let retried = false;
    while (Date.now() < deadline) {
      const entries = await this._readAgentEntries(c);
      const target = entries.find((e) => e.id === agentId);
      if (target && target.isSelected) return true;
      if (!retried && Date.now() >= retryAt) {
        retried = true;
        await this._requestExactAgentSelection(c, agentId);
      }
      await sleep(pollMs);
    }
    throw new Error(`After opening ${agentId}, it could not be confirmed as the selected Agent`);
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
      if (opened !== 'OPENED') throw new Error(`Unable to open ${job.agentId}: ${opened}`);
      await this._closeHistory(c);
      await this._waitForSelectedAgent(c, job.agentId);

      let answer = '';
      let lastKey = '';
      let stable = 0;
      // Agent History 已给出完成图标，但打开会话后的 Markdown/虚拟列表仍可能延迟挂载。
      // 给视图约 24 秒稳定时间，并允许只有一个可见 Markdown（常见于用户 prompt 不是 markdown 的情况）。
      for (let i = 0; i < 80; i++) {
        const snap = await this._readResponseSnapshot(c);
        const candidate = String(await evalJS(c, EXPR_EXTRACT) || '').trim();
        const hasNewTurn = isSessionTurnReplyReady(job.responseBaseline, snap);
        if (candidate && hasNewTurn && Number(snap.stop || 0) === 0) {
          const key = `${snap.replyLength}:${snap.replyHash}`;
          if (key === lastKey) stable++; else { lastKey = key; stable = 0; }
          if (stable >= 1) { answer = candidate; break; }
        }
        await sleep(300);
      }
      if (!answer) throw new Error(`${job.agentId} was opened, but no final assistant reply was found`);

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
    const message = error instanceof Error ? error.message : String(error || 'The Cursor Agent terminated, but its final reply could not be collected');
    job.status = 'needs_attention';
    job.phase = 'orphaned';
    job.finishedAt = null;
    job.error = message;
    job.result = null;
    job.resultUnavailable = true;
    job.terminalEvidence = evidence || 'stable_completed_history_icon';
    job.recoveryState = 'terminal_result_uncollected';
              job.reservationScope = uncertainSubmissionReservationScope(job, error);
              job.recoveryState = error.recoveryState || 'monitoring_uncertain_submission';
    this._safeSettleSessionJob(job, 'terminal_result_uncollected', { needsAttention: true });
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
    this._safeSettleSessionJob(job, 'abandoned', {
      needsAttention: true,
      attention: 'The Bridge released the task reservation without proving that the Cursor Agent stopped. This session cannot continue safely.',
    });
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
      job.error = `Failed to recheck Agent History: ${error.message}`;
      return { stable: false, error: error.message, entry: null };
    }
    job.lastRecoveryAt = new Date().toISOString();
    if (!first || !second) {
      job.recoveryState = 'agent_missing';
      return { stable: false, error: 'The bound agentId was not found in Agent History', entry: second || first || null };
    }
    const stable = first.id === second.id
      && first.showSpinner === second.showSpinner
      && String(first.icon || '') === String(second.icon || '');
    return { stable, entry: second, error: stable ? null : 'Agent History state is not yet stable' };
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
      const task = this._cancelJob(job, `Cursor Agent ${job.agentId} reached a cancelled terminal state`, { underlyingStopConfirmed: true });
      return { changed: true, state: 'cancelled', task };
    }
    if (terminalClass === 'failed') {
      const error = new Error(`Cursor Agent ${job.agentId} reached stable failure state ${icon}`);
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
        next: 'The underlying Agent is stably complete, but its final reply has not been collected. Retry with reap, or explicitly abandon only if a missing reply is acceptable.',
          task: this._taskView(job, true),
        };
      }
    }
    job.status = 'needs_attention';
    job.phase = 'orphaned';
    job.recoveryState = 'idle_unconfirmed';
    return { changed: false, state: 'idle_unconfirmed', task: this._taskView(job, true) };
  }

  async _readVisibleComposer(c) {
    try {
      return JSON.parse(await evalJS(c, EXPR_VISIBLE_COMPOSER) || '{}');
    } catch {
      return { ok: false, state: 'composer_evaluate_failed' };
    }
  }

  async _stopBoundAgentViaComposer(c, job) {
    let clickResult;
    try { clickResult = JSON.parse(await evalJS(c, exprClickBoundComposerStop(job.agentId))); }
    catch (error) { clickResult = { clicked: false, state: 'stop_evaluate_failed', error: error.message }; }
    if (!clickResult.clicked) {
      const snap = await this._readVisibleComposer(c);
      if (snap.ok && snap.id === job.agentId && snap.status && snap.status !== 'generating') {
        if (/cancel/.test(String(snap.status))) {
          return { confirmed: true, clicked: false, state: 'already_cancelled', icon: snap.status };
        }
        return { confirmed: false, clicked: false, state: 'target_not_generating', icon: snap.status };
      }
      return { confirmed: false, ...clickResult };
    }

    let stableTerminal = 0;
    let lastSignature = '';
    let status = null;
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      const snap = await this._readVisibleComposer(c);
      if (!snap.ok) status = 'detached';
      else if (snap.id !== job.agentId) status = 'replaced';
      else status = snap.status || null;
      let stopCount = null;
      try {
        const pageSnap = JSON.parse(await evalJS(c, EXPR_SNAP) || '{}');
        stopCount = Number(pageSnap.stop);
      } catch {}
      const terminal = (status && status !== 'generating') || stopCount === 0;
      const signature = terminal ? `${job.agentId}:${status || 'stopped'}:${stopCount}` : '';
      if (terminal && signature === lastSignature) stableTerminal++; else stableTerminal = terminal ? 1 : 0;
      lastSignature = signature;
      if (stableTerminal >= 2) break;
    }
    const confirmed = isTargetedStopConfirmed(clickResult, stableTerminal);
    return {
      confirmed,
      clicked: true,
      state: confirmed ? 'stopped' : status && status !== 'generating' ? 'stop_unconfirmed' : 'composer_missing_after_stop',
      icon: status,
      click: clickResult,
    };
  }

  async _stopBoundAgentViaHistory(c, job, options = {}) {
    const restorePrevious = options.restorePrevious === true;
    let previousSelectedId = null;
    try {
      const entries = await this._readAgentEntries(c, true);
      const target = entries.find((entry) => entry.id === job.agentId);
      previousSelectedId = (entries.find((entry) => entry.isSelected) || {}).id || null;
      if (!target) return { confirmed: false, state: 'agent_missing' };
      if (!target.showSpinner) {
        const terminalClass = classifyParallelTerminalIcon(target.icon);
        if (terminalClass === 'cancelled') {
          return { confirmed: true, clicked: false, state: 'already_cancelled', icon: target.icon || null };
        }
        return { confirmed: false, clicked: false, state: 'target_not_generating', icon: target.icon || null };
      }
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
        if (restorePrevious && previousSelectedId && previousSelectedId !== job.agentId && await this._ensureHistoryOpen(c)) {
          await evalJS(c, exprOpenAgent(previousSelectedId));
          await this._closeHistory(c);
          await this._waitForSelectedAgent(c, previousSelectedId);
        }
      } catch {}
      await this._closeHistory(c);
    }
  }

  async _stopBoundAgentOnClient(c, job, options = {}) {
    if (!job || !job.agentId) return { confirmed: false, state: 'unbound_agent' };
    const preferComposer = options.preferComposer === true
      || job.execution === 'fifo'
      || job.effectiveExecution === 'fifo';
    if (preferComposer) {
      const composerStop = await this._stopBoundAgentViaComposer(c, job);
      if (composerStop.confirmed || composerStop.clicked) return composerStop;
    }
    let historyResult;
    try {
      historyResult = await this._stopBoundAgentViaHistory(c, job, options);
    } catch (error) {
      historyResult = { confirmed: false, state: 'history_unavailable', error: error.message };
    }
    if (historyResult.confirmed
      || !['adapter_unavailable', 'agent_missing', 'history_unavailable', 'unbound_agent'].includes(historyResult.state)
        && !/适配器不可用|REACT_ADAPTER|Agent History/.test(String(historyResult.error || ''))) {
      return historyResult;
    }
    if (preferComposer) return historyResult;
    return this._stopBoundAgentViaComposer(c, job);
  }

  async _stopParallelAgent(job) {
    if (!job.agentId) return { confirmed: false, state: 'unbound_agent' };
    return this._withUiLock(async () => {
      const page = await findPage({ targetId: job.targetId, purpose: 'parallel_agent' });
      const c = makeClient(page.webSocketDebuggerUrl);
      await c.ready;
      try {
        return await this._stopBoundAgentOnClient(c, job, { restorePrevious: true });
      } finally {
        c.close();
      }
    });
  }

  async taskControl(taskId, options = {}) {
    const id = String(taskId || '').trim();
    if (!id) throw new Error('task_id must not be empty');
    const job = this.tasks.get(id);
    if (!job) return { found: false, taskId: id };
    const action = String(options.action || 'reap').trim().toLowerCase();
    if (!['reap', 'cancel', 'abandon'].includes(action)) {
      throw new Error(`Unsupported action=${action}; expected reap, cancel, or abandon`);
    }
    const reason = String(options.reason || '').trim();
    const expectedAgentId = String(options.expectedAgentId || '').trim();
    if (action !== 'reap' && options.confirm !== true) throw new Error(`${action} requires confirm=true`);
    const submittingCancelWithoutPublishedId = action === 'cancel'
      && job.phase === 'submitting'
      && !expectedAgentId;
    if (job.agentId && action !== 'reap' && !submittingCancelWithoutPublishedId && expectedAgentId !== job.agentId) {
      throw new Error(`expected_agent_id does not match; the task is bound to ${job.agentId}`);
    }
    // cancel latch 必须在第一个 await 之前写入，避免 submitting 期间等待 job lock 而错过发送前门禁。
    if (action === 'cancel' && !isTerminalTask(job)) {
      job.cancelRequested = true;
    job.cancelReason = reason || (job.execution === 'parallel_agent' ? 'User requested Cursor Agent cancellation' : 'User requested FIFO task cancellation');
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
        result.next = job.agentId
        ? 'FIFO is bound to an agentId, but reap applies only to parallel_agent. Use cancel for a targeted stop, or abandon after confirmation.'
        : 'The FIFO orphan has no agentId that can be safely rebound. Confirm that it stopped in the Cursor UI before explicitly abandoning it.';
      }
      return { found: true, action, ...result };
    }
    if (isTerminalTask(job)) {
      return { found: true, action, changed: false, state: job.status, alreadyTerminal: true, task: this._taskView(job, true) };
    }

    if (action === 'abandon') {
      if (options.acknowledgeMayStillWrite !== true) {
      throw new Error('abandon requires acknowledge_may_still_write=true');
      }
    if (!options.reason) throw new Error('abandon requires a non-empty reason');
      if (job.phase !== 'orphaned' && job.phase !== 'cancelling' && job.status !== 'needs_attention') {
      throw new Error('abandon is allowed only for tasks in needs_attention, orphaned, or cancelling state');
      }
      return {
        found: true,
        action,
        changed: true,
        state: 'abandoned',
      warning: 'The Bridge released its reservation, but cannot prove that the underlying Cursor Agent stopped; it may still write files.',
        task: this._abandonJob(job, options.reason),
      };
    }

    if (job.status === 'queued') {
      return {
        found: true,
        action,
        changed: true,
        state: 'cancelled',
        task: this._cancelJob(job, options.reason || 'Queued task cancelled', { underlyingStopConfirmed: true }),
      };
    }
    if (job.phase === 'orphaned' && !job.agentId) {
      job.cancelRequested = false;
      return {
        found: true,
        action,
        changed: false,
        state: 'cancel_unconfirmed',
        next: 'The task is orphaned without a safely targetable identity and still holds the global reservation. Confirm that it stopped in the Cursor UI before explicitly abandoning it.',
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
        next: 'The Bridge latched the cancellation request. It will stop before submission, or bind the agentId and issue a targeted stop if the message was already sent.',
        task: this._taskView(job, true),
      };
    }
    const canTargetStop = job.execution === 'parallel_agent' || !!job.agentId;
    if (canTargetStop && (job.execution === 'parallel_agent' || job.phase === 'orphaned')) {
      if (job.execution === 'parallel_agent') {
        this._invalidateParallelMonitor(job);
        const reaped = await this._reapParallelJobLocked(job, { reattach: false });
        if (isTerminalTask(job)) return { found: true, action, ...reaped };
      }
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
          job.error = `Unable to confirm that the Cursor Agent stopped: ${stopped.error || stopped.state}`;
      return {
        found: true,
        action,
        changed: false,
        state: 'cancel_unconfirmed',
        stop: stopped,
            next: 'After confirming that the Cursor UI has stopped, retry cancel. Use abandon only when explicitly accepting the risk.',
        task: this._taskView(job, true),
      };
    }
    if (job.agentId) {
      job.phase = 'cancelling';
      job.recoveryState = 'cancel_pending_stop';
      return {
        found: true,
        action,
        changed: true,
        state: 'cancel_pending_stop',
        next: 'The Bridge latched the cancellation request. The running FIFO task will be stopped through its bound agentId without clicking an ambiguous Stop control.',
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
      next: 'FIFO has no safely targetable agentId, so the Bridge will not click an ambiguous Stop control. The task becomes a global orphan reservation; confirm that it stopped manually before abandoning it.',
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
    }).catch((e) => console.error('⚠️ Failed to restore the original Cursor Agent: ' + e.message));
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
        if (job.agentId) {
          let stopped;
          try {
            stopped = await this._stopBoundAgentOnClient(c, job, { restorePrevious: false });
          } catch (error) {
            stopped = { confirmed: false, state: 'stop_error', error: error.message };
          }
          const e = new Error(job.cancelReason || 'Task cancelled');
          e.cancelled = true;
          e.stopConfirmed = stopped.confirmed === true;
          e.stop = stopped;
          if (stopped.confirmed) job.terminalEvidence = `targeted_stop:${job.agentId}`;
          throw e;
        }
        // 未绑定身份的 FIFO 禁止用宽泛 Stop/Cancel 选择器猜测性点击其他会话或工作台控件。
        const e = new Error(job.cancelReason || 'Task cancelled');
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
        ? `; task_id=${job.id}. Inspect it with cursor_status(task_id) and follow the recovery flow`
        : '';
      throw new Error(`Cursor task timed out (${timeoutMs}ms) before generation was confirmed stopped with a complete assistant reply${taskHint}`);
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
      modelPreference: job.modelPreference,
      modelSelection: job.modelSelection,
      projectPath: job.projectPath,
      sessionMode: job.sessionMode || 'isolated',
      sessionId: job.sessionId || null,
      sessionTurn: job.sessionTurn || null,
      sessionState: job.sessionState || null,
      sessionError: job.sessionError || null,
      requestId: job.requestId || null,
      agentId: job.agentId,
      provisionalAgentId: job.provisionalAgentId || null,
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
      uiDiagnostic: job.uiDiagnostic,
      sendState: job.sendState,
      reservationScope: job.reservationScope,
      reservationHeld: this.activeParallel.has(job.id),
      blocksFifo: this.activeParallel.has(job.id) && !isTerminalTask(job),
      blocksAll: this.activeParallel.has(job.id) && !isTerminalTask(job) && job.reservationScope === 'global',
    };
    if (includeResult || isTerminalTask(job)) view.result = job.result;
    if (job.phase === 'orphaned') {
      if (job.recoveryState === 'terminal_result_uncollected') {
      view.attention = 'Agent History proves that the underlying task ended, but its final reply has not been collected. Retry with reap, or explicitly abandon only if a missing reply is acceptable.';
      } else {
        view.attention = job.agentId
          ? (job.execution === 'parallel_agent'
          ? 'Use cursor_task_control(action=reap) to recheck the original agentId. Use cancel when a stop is needed, and abandon only after manual confirmation while accepting residual write risk.'
          : 'FIFO is bound to an agentId. Use cursor_task_control(action=cancel) with the exact expected_agent_id for a targeted stop.')
        : 'This orphan has no agentId that can be safely rebound and globally blocks new delegation. Confirm that it stopped in the Cursor UI, then explicitly release it with cursor_task_control(action=abandon).';
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
      if (!job) return { found: false, taskId: String(taskId), ...this.workspaceView(), ...this.delegationView(), ...this.runtimeModeView(), ...this.modelPreferencesView(), ...this.sessionRegistryView() };
      return { found: true, ...this.workspaceView(), ...this.delegationView(), ...this.runtimeModeView(), ...this.modelPreferencesView(), ...this.sessionRegistryView(), ...this._taskView(job, true) };
    }
    const parallelRunning = this.activeParallel.size;
    const uiBusy = this.busy;
    const globalBlocked = this._hasGlobalReservation();
    const common = {
      pluginVersion: PLUGIN_VERSION,
      statusPath: 'json-list',
      ...this.workspaceView(),
      ...this.delegationView(),
      ...this.runtimeModeView(),
      ...this.modelPreferencesView(),
      ...this.sessionRegistryView(),
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
        lifecycleMode: null,
        persistent: null,
        degradedReason: null,
        spawnErrorCode: null,
        capabilities: null,
        cursorPid: null,
        runtimeMode: this.runtimeMode,
        presentation: null,
      },
    };
    try {
      const ver = await httpJson('/json/version');
      const list = await httpJson('/json/list');
      return { connected: true, ...common, browser: ver.Browser, ...summarizeCdpPages(list) };
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
        'Persistent continuity is explicit: session_mode=create starts one durable top-level Agent association, and session_mode=continue requires its exact session_id. Omission keeps the existing isolated behavior. ' +
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
          session_mode: { type: 'string', enum: [...CURSOR_SESSION_MODES], default: 'isolated', description: 'isolated preserves the current clean-task behavior. create starts an update-safe persistent session. continue sends one new turn to the exact session_id.' },
          session_id: { type: 'string', description: 'Required only for session_mode=continue. This stable Bridge ID is not a Cursor agentId.' },
          request_id: { type: 'string', description: 'Optional idempotency key for a persistent session turn. Repeating the latest key returns its existing task/session instead of sending again.' },
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
      name: 'cursor_session_control',
      description:
        'Recover, close, or forget one exact persistent cursor_do session. reconcile checks the exact Agent twice and never resends. close prevents future sends but does not stop or delete the Cursor Agent. ' +
        'An active or uncertain session cannot be closed. abandon is the explicit last resort when exact stop evidence is unavailable. forget requires confirm=true and is allowed only after close; it deletes only the Bridge mapping.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The exact session ID returned by cursor_do(session_mode=create).' },
          action: { type: 'string', enum: ['reconcile', 'close', 'forget', 'abandon'], description: 'reconcile reads the exact Agent state; close ends safe continuity; forget removes a closed mapping; abandon releases an uncertain mapping without stop proof.' },
          confirm: { type: 'boolean', default: false, description: 'Required for forget and abandon.' },
          reason: { type: 'string', description: 'Required and non-empty for abandon.' },
          acknowledge_may_still_write: { type: 'boolean', default: false, description: 'Required for abandon; acknowledges that the underlying Cursor Agent may still run or write.' },
        },
        required: ['session_id', 'action'],
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
      name: 'cursor_model',
      description:
        'Show, set, or reset persistent Cursor model defaults for CCE and cursor_do. Settings are independent per target and survive host tasks, MCP restarts, and Cursor Bridge restarts until the user explicitly changes or resets them. ' +
        'When configured, Bridge applies the model and optional effort in every newly created Cursor Agent before sending the prompt, then verifies the visible selection. A persistent session freezes that preference and reapplies it on continued turns instead of inheriting later global changes. An unavailable, ambiguous, unsupported, or unconfirmed selection fails before prompt submission instead of silently falling back to Auto. ' +
        'Use set/reset only when the user explicitly asks to change these defaults; use show for read-only inspection.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'set', 'reset'], description: 'show reads current defaults; set persists a model and optional effort; reset restores Cursor default selection for the target.' },
          target: { type: 'string', enum: ['cce', 'cursor_do', 'both'], description: 'Required for set/reset. CCE and cursor_do keep independent defaults; both changes both targets together.' },
          model: { type: 'string', description: 'Required for set. Use a model ID or display name currently available in the signed-in Cursor account.' },
          effort: { type: 'string', enum: [...CURSOR_MODEL_EFFORTS], description: 'Optional reasoning effort for set. Omit it to use that model\'s Cursor default.' },
        },
        required: ['action'],
      },
    },
    {
      name: 'cursor_status',
      description: 'Read-only snapshot of Cursor connectivity, queued/running work, reservations, execution availability, persistent model/effort defaults, sessions, and normal/minimal runtime presentation. Pass task_id for its configured and effective model selection, or session_id for the durable association; never pass both. This tool never switches Agents, reconciles, or stops work.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'A task ID returned by cursor_do.' },
          session_id: { type: 'string', description: 'A persistent session ID returned by cursor_do(session_mode=create).' },
        },
      },
    },
  ].filter(Boolean);
}

const ADAPTER_START_CWD = process.cwd();
const bridge = new CursorBridge({ adapterStartCwd: ADAPTER_START_CWD });
const server = new Server(
  { name: 'cursor-bridge', version: PLUGIN_VERSION },
  { capabilities: { tools: { listChanged: true } } },
);

async function ensureBridgeCursor(targetBridge, reason) {
  targetBridge._refreshPersistedRuntimeMode();
  const { ensureCursorRunning } = await import('./launch-cursor.mjs');
  const r = await ensureCursorRunning({
    reason,
    runtimeMode: targetBridge.runtimeMode,
    adapterStartCwd: targetBridge.adapterStartCwd,
    ...(targetBridge.projectPath ? { projectPath: targetBridge.projectPath } : {}),
  });
  targetBridge._lastLifecycle = lifecycleFromEnsureResult(r, targetBridge.runtimeMode);
  if (targetBridge.runtimeMode === 'minimal') {
    targetBridge._lastPresentation = r.presentation
      ? { ...r.presentation, at: new Date().toISOString() }
      : await targetBridge.applyRuntimePresentation('hide');
  }
  return r;
}

function toolErrorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error && error.uiDiagnostic) {
    const payload = {
      error: { code: error.code || error.uiDiagnostic.code || 'CURSOR_BRIDGE_ERROR', message },
      uiDiagnostic: error.uiDiagnostic,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
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
        sessionMode: args && args.session_mode,
        sessionId: args && args.session_id,
        requestId: args && args.request_id,
        readOnlySpecified: !!(args && Object.hasOwn(args, 'read_only')),
        allowedPathsSpecified: !!(args && Object.hasOwn(args, 'allowed_paths')),
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
    if (name === 'cursor_session_control') {
      const result = await bridge.sessionControl(args && args.session_id, {
        action: args && args.action,
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
    if (name === 'cursor_model') {
      const result = bridge.configureModelPreferences({
        action: args && args.action,
        target: args && args.target,
        model: args && args.model,
        effort: args && args.effort,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'cursor_status') {
      if (args && args.task_id && args.session_id) {
        throw cursorSessionError('STATUS_SELECTOR_AMBIGUOUS', 'pass task_id or session_id, not both');
      }
      const statusMs = Math.max(1000, Number(process.env.CURSOR_BRIDGE_STATUS_TIMEOUT || 8000));
      let result;
      try {
        result = await Promise.race([
          args && args.session_id
            ? Promise.resolve(bridge.sessionStatus(args.session_id))
            : bridge.status(args && args.task_id),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`cursor_status_timeout_${statusMs}`)), statusMs)),
        ]);
      } catch (error) {
        result = {
          connected: false,
          pluginVersion: PLUGIN_VERSION,
          statusPath: 'json-list',
          error: error instanceof Error ? error.message : String(error),
          ...bridge.workspaceView(),
          ...bridge.delegationView(),
          ...bridge.runtimeModeView(),
          ...bridge.sessionRegistryView(),
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'cursor_launch') {
      const r = await ensureBridgeCursor(bridge, 'cursor_launch');
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: !r.ok };
    }
        throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
      return toolErrorResult(error);
  }
});

async function main() {
  console.error('🚀 Starting cursor-bridge (direct CDP on port ' + CDP_PORT + ')...');
  const releasedCwd = releaseAdapterWorkingDirectory();
    console.error(`🔓 MCP working directory released from the plugin cache: ${releasedCwd}`);
  // Prewarm both runtime modes before the MCP handshake completes. In minimal mode this claims
  // Cursor's default single-instance slot with CDP enabled, then the PID-scoped guard keeps its
  // windows hidden. That prevents later "Open in Cursor" actions from stealing the slot without 9223.
  const startupEnsure = shouldAutoLaunchCursor()
    ? ensureBridgeCursor(bridge, 'adapter-startup')
      .then((r) => {
        console.error(
        '🪟 Startup Cursor check: ' + (r.message || r.status)
          + ' | adapterPid=' + bridge._lastLifecycle.adapterPid
          + ' supervisorPid=' + bridge._lastLifecycle.supervisorPid
          + ' reused=' + bridge._lastLifecycle.reusedSupervisor
          + ' reason=' + bridge._lastLifecycle.launchReason,
        );
        return r;
      })
      .catch((error) => {
      console.error('⚠️ Startup Cursor launch failed; continuing and retrying on demand:', error.message);
        return null;
      })
    : Promise.resolve(null);
  await server.connect(new StdioServerTransport());
  console.error('✅ MCP connected.');
  void startupEnsure;
}

// 仅在直接运行（node server.mjs）时启 MCP；被 import（如 test 脚本）时只导出 CursorBridge/bridge。
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
  process.on('SIGINT', () => process.exit(0));
main().catch((e) => { console.error('❌ Fatal error:', e); process.exit(1); });
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
  isSessionTurnReplyReady,
  shouldScheduleParallelOriginRestore,
  buildToolDefinitions,
  CURSOR_MODEL_EFFORTS,
  CURSOR_MODEL_TARGETS,
  normalizeCursorModelEffort,
  normalizeModelPickerText,
  selectModelPickerRow,
  pathsOverlap,
  scoreCursorPageCandidate,
  selectCursorPageCandidate,
  selectPageForUiPreference,
  classifyChatPanelDiagnostic,
  createChatPanelUnavailableError,
  toolErrorResult,
  selectNewAgentEntry,
  selectUniqueNewAgentEntry,
  selectPromotedParallelEntry,
  selectPromotedFifoEntry,
  EXPR_VISIBLE,
  EXPR_FIND_NEWAGENT,
  EXPR_MODEL_PICKER_TRIGGER,
  EXPR_MODEL_PICKER_ROWS,
  exprCreateAgentForWorkspace,
  exprInspectWorkspaceRepository,
  EXPR_PAGE_CAPABILITIES,
  EXPR_HISTORY_ENTRIES,
  EXPR_PROVIDER_ERROR,
  EXPR_CLICK_SEND,
  exprFill,
  exprOpenAgent,
  exprClickSelectedAgentStop,
  EXPR_VISIBLE_COMPOSER,
  exprClickBoundComposerStop,
  isTargetedStopConfirmed,
  updateStableEntryObservation,
  classifyParallelTerminalIcon,
  isDurablyRegisteredParallelEntry,
  uncertainSubmissionReservationScope,
  providerErrorSignature,
  createProviderError,
  promoteAgentsWorkspaceLifecycle,
  shouldRecoverNormalAgentsPresentation,
  releaseAdapterWorkingDirectory,
  lifecycleFailureSummary,
  PLUGIN_VERSION,
};
