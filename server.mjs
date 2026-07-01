#!/usr/bin/env node
/**
 * cursor-bridge — MCP server（CDP 直驱架构）
 *
 * 让 Claude Code 调 Cursor IDE 里的 agent 检索（语义搜索 + Instant Grep，agent 自动编排）。
 * Cursor 的语义搜索【没有纯检索接口/独立 UI】（2026-06-08 CDP 实测：
 *   window.vscode 是 sandbox preload 无 command API；Ctrl+Shift+F 是普通全文搜索），
 *   只能跑 agent 拿（用户拍板 B1）。故走 @Codebase/agent chat：填查询 → Enter → 等完成 → 抓回复。
 *
 * 架构（CDP 直驱，无需 console+WS 回连）：
 *   Claude Code --(MCP stdio)--> 本 server --(CDP 9223 Runtime.evaluate + Input)--> Cursor 渲染进程
 *   server 每次查询新建 CDP 连接（串行，GUI 单输入框），直接驱动 DOM + 真实键盘。
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
import { WebSocket } from 'ws';
import http from 'http';
import { pathToFileURL } from 'url';

const CDP_PORT = Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223);
const ORIGIN = `http://localhost:${CDP_PORT}`;
const QUERY_TIMEOUT = Number(process.env.CURSOR_BRIDGE_TIMEOUT || 180000);

// 只读检索 prompt：Cursor agent 当精准定位器用，约束操作类型（不读正文/不改码/不长篇），由 CC 拿清单后自己读真文件。
const SEARCH_PREFIX =
  '只做代码检索定位：列出与下面意图相关的文件路径 + 行号范围（形如 Assets/Scripts/X.cs:120-180），' +
  '逐行列出即可。不要读取文件正文、不要修改任何代码、不要展开长篇解释。\n\n意图：';

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
// 生成中/完成信号：stop 钮（codicon-stop/debug-stop/aria含Stop）数 + 最长 markdown 长度
const EXPR_SNAP = `(function(){
  const md=[...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')];
  let mdMax=0; for(const m of md){const t=(m.innerText||'').length; if(t>mdMax)mdMax=t;}
  const stop=[...document.querySelectorAll('[class*=codicon-stop],[class*=debug-stop],[aria-label*=Stop],[aria-label*=stop],[aria-label*=Cancel],[title*=Stop]')].filter(e=>e.offsetParent!==null).length;
  return JSON.stringify({mdMax, stop});
})()`;
// 抓答案：最长 markdown-root 的纯文本
const EXPR_EXTRACT = `(function(){
  const md=[...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')].filter(e=>e.offsetParent!==null);
  let best=''; for(const m of md){const t=(m.innerText||'').trim(); if(t.length>best.length)best=t;}
  return best;
})()`;
// "New Agent" 新对话钮中心坐标（aria-label 含 New Agent/New Chat）；返回 JSON 坐标或空串。
const EXPR_FIND_NEWAGENT = `(function(){const b=[...document.querySelectorAll('button,[role=button],a.action-label,.codicon')].find(e=>e.offsetParent!==null&&/New Agent|New Chat/i.test(e.getAttribute('aria-label')||''));if(!b)return '';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`;

class CursorBridge {
  constructor() { this.busy = false; this.queue = []; this._healing = null; }

  async search(query) {
    await this._ensureCursor();
    return new Promise((resolve, reject) => { this.queue.push({ query, resolve, reject }); this._drain(); });
  }

  // 自愈：每次查询前委托 ensureCursorRunning。并发去重。失败静默降级（_run 报清晰错）。
  // 统一走 ensureCursorRunning 复用其【单一身份校验来源】（cdpUp + cdpIsCursor）——避免热路径裸 /json/version 检查
  // 绕过身份校验、在别的 IDE 占 9223 时驱动错应用（2026-06-08 review #6）。
  _ensureCursor() {
    if (this._healing) return this._healing;
    this._healing = (async () => {
      try {
        const { ensureCursorRunning } = await import('./launch-cursor.mjs');
        const rr = await ensureCursorRunning();
        if (rr.status === 'already') return;                                  // 已就绪且确认是 Cursor
        if (rr.status === 'port-not-cursor') { console.error('⚠️ ' + rr.message); return; }  // 不强连错 IDE，让 _run 自然报错
        console.error('🪟 cursor 自愈拉起：' + (rr.message || rr.status));
      } catch (e) { console.error('⚠️ cursor 自愈失败（降级，按需手动启动）：', e.message); }
      finally { this._healing = null; }
    })();
    return this._healing;
  }
  async _drain() {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    const job = this.queue.shift();
    try { job.resolve(await this._run(job.query)); }
    catch (e) { job.reject(e); }
    finally { this.busy = false; this._drain(); }
  }

  async _run(query) {
    const page = await findPage();
    const c = makeClient(page.webSocketDebuggerUrl);
    await c.ready;
    try {
      // 1) 确保 chat 面板打开（Ctrl+L toggle：不可见才开）
      let vis = await evalJS(c, EXPR_VISIBLE);
      if (!vis) { await chord(c, 2, 'L', 'KeyL', 76); await sleep(1300); vis = await evalJS(c, EXPR_VISIBLE); }
      if (!vis) throw new Error('无法打开 Cursor chat 面板（.aislash-editor-input 不可见）。Cursor 是否登录且窗口正常？');
      // 1.5) 开新对话（避免上下文累积 + 回复区干净，extract 不串旧对话）；找不到钮则跳过沿用当前
      await this._newChat(c);
      // 2) 填查询
      const filled = await evalJS(c, exprFill(SEARCH_PREFIX + query));
      if (filled === 'NO_INPUT' || filled === 'EXEC_FAIL') throw new Error('填入查询失败（输入框状态异常）');
      await sleep(450);
      // 3) Enter 发送
      await chord(c, 0, 'Enter', 'Enter', 13);
      // 4) 等完成（stop 钮 >0 出现过 → 归 0）
      return await this._waitComplete(c);
    } finally { c.close(); }
  }

  // 清空对话上下文：定位 "New Agent" 钮后【Alt+click】——Alt 修饰使其执行 Replace Agent（清空旧对话），
  // 而非新建（aria 标注 "New Agent (Ctrl+N) / [Alt] Replace Agent"）。2026-06-08 实测回复区 markdown DOM 清空
  // 2719→17，避免 extract 串旧对话。找不到钮则跳过沿用当前（不阻断查询）。
  async _newChat(c) {
    try {
      const pos = await evalJS(c, EXPR_FIND_NEWAGENT);
      if (!pos) return false;
      const { x, y } = JSON.parse(pos);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 1 });   // modifiers:1 = Alt → Replace Agent
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 1 });
      await sleep(1100);   // 等新对话初始化（输入框重建 + 回复区清空）
      return true;
    } catch { return false; }
  }

  async _waitComplete(c) {
    const start = Date.now();
    const INTERVAL = 1000;
    let sawStop = false;        // 观察到生成中（stop 钮出现过）
    let lastMd = 0, stableMd = 0;
    await sleep(1200);          // 给发送后 stop 钮起来留时间
    while (Date.now() - start < QUERY_TIMEOUT) {
      let s; try { s = JSON.parse(await evalJS(c, EXPR_SNAP)); } catch { s = { stop: 0, mdMax: 0 }; }
      if (s.stop > 0) sawStop = true;

      // 主路径：生成过且停止钮归 0 + 有实质回复 → 完成
      if (sawStop && s.stop === 0 && s.mdMax > 40) {
        await sleep(800);      // 宽限：最后一次 DOM 追加
        const ans = await evalJS(c, EXPR_EXTRACT);
        if (ans && ans.length > 0) return ans;
      }
      // 兜底：始终没采到 stop 钮（信号失效）但文本稳定 → 完成
      if (!sawStop && s.mdMax > 80) {
        if (s.mdMax === lastMd) { stableMd++; if (stableMd >= 6) { const ans = await evalJS(c, EXPR_EXTRACT); if (ans) return ans; } }
        else { stableMd = 0; lastMd = s.mdMax; }
      }
      await sleep(INTERVAL);
    }
    // 超时：有内容则返回当前，否则报错（绝不返回空）
    const ans = await evalJS(c, EXPR_EXTRACT);
    if (ans && ans.length > 40) return ans;
    throw new Error(`Cursor 查询超时 (${QUERY_TIMEOUT}ms) 未产生实质回复`);
  }

  async status() {
    try {
      const ver = await httpJson('/json/version');
      const page = await findPage();
      return { connected: true, busy: this.busy, queued: this.queue.length, cdpPort: CDP_PORT, browser: ver.Browser, page: (page.url || '').slice(0, 60) };
    } catch (e) {
      return { connected: false, busy: this.busy, queued: this.queue.length, cdpPort: CDP_PORT, error: e.message };
    }
  }
}

const bridge = new CursorBridge();
const server = new Server({ name: 'cursor-bridge', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'cursor_search',
      description:
        '用 Cursor IDE 里的 agent 检索（语义搜索 + Instant Grep，agent 自动编排）定位本项目代码。' +
        '适合需要 Cursor 原生 embedding 语义召回质量的代码定位。' +
        '前提：Cursor 带 --remote-debugging-port=9223 启动、已登录、打开本项目。' +
        '注意：① 经 GUI 遥控 agent，单次约 ~90s（实测 66~175s 波动）且串行（一次一个）；' +
        '② Cursor 是 agent 非纯检索，prompt 已约束只列 path:行号、不读正文/不改代码，但非技术隔离，别当沙箱；' +
        '③ 因单次较慢且串行，建议并行/后台使用——与其它工作并行推进，别在主线阻塞等它返回。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言检索意图，例如 "where is battle damage calculated" 或 "灵宠捕获逻辑在哪"' },
        },
        required: ['query'],
      },
    },
    {
      name: 'cursor_status',
      description: '检查 cursor-bridge 与 Cursor CDP（9223）的连接/队列状态。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cursor_launch',
      description:
        '确保 Cursor 带 CDP 调试口(9223)在运行：未运行则自动拉起（带 --remote-debugging-port + --remote-allow-origins + 打开本项目建索引）；已带 flag 则直接返回。' +
        '返回 status：already / launched / running-no-debug（在跑但没带 flag，需先彻底退出 Cursor）/ port-not-cursor（9223 被别的 IDE 占）/ no-exe / timeout。',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'cursor_search') {
      const result = await bridge.search(String((args && args.query) || ''));
      return { content: [{ type: 'text', text: String(result) }] };
    }
    if (name === 'cursor_status') {
      return { content: [{ type: 'text', text: JSON.stringify(await bridge.status(), null, 2) }] };
    }
    if (name === 'cursor_launch') {
      const { ensureCursorRunning } = await import('./launch-cursor.mjs');
      const r = await ensureCursorRunning();
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
  if (process.env.CURSOR_BRIDGE_NO_AUTOLAUNCH !== '1') {
    (async () => {
      try {
        const { ensureCursorRunning } = await import('./launch-cursor.mjs');
        const r = await ensureCursorRunning();
        console.error('🪟 启动即确保 Cursor：' + (r.message || r.status));
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
export { CursorBridge, bridge };
