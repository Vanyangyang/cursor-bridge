import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROUTING_STATE_TTL_MS = 10 * 60 * 1000;
export const MAX_CONTEXT_MODE_DENIALS = 2;
const ROUTING_LOCK_RETRY_MS = 5;
const ROUTING_LOCK_CLEAR_ATTEMPTS = 50;

const CONTEXT_MODE_TOOL_PATTERN = /^(?:mcp__plugin_context-mode_context-mode|mcp__context-mode)__ctx_(?:batch_execute|execute|execute_file|search)$/;
const CCE_TOOL_PATTERN = /^(?:mcp__plugin_cursor-bridge_cursor-bridge|mcp__cursor-bridge)__cursor_(?:context_engine|search|search_deep)$/;

const OPT_OUT_PATTERN = /(?:不要|不再|不|无需|不用|禁止|别|不想|避免|跳过)(?:使用|调用|启动|用)?\s*(?:cursor|cce)|(?:do not|don't|dont|without|never|avoid|skip)\s+(?:(?:use|using|call|calling|start|starting)\s+)?(?:cursor|cce)|\bno\s+(?:cursor|cce)\b/i;
const EXTERNAL_INFO_PATTERN = /(?:最新|当前版本|官方文档|外部文档|互联网|网页搜索|web\s*search|latest|current\s+(?:api|docs?|version)|official\s+(?:api|docs?|documentation)|external\s+documentation)/i;
const OPERATIONAL_PATTERN = /(?:运行|执行|查看|分析|修复).{0,12}(?:测试|日志|构建|编译|git\s*(?:状态|差异|历史))|(?:run|inspect|analy[sz]e|fix).{0,20}(?:tests?|logs?|build|compile|git\s+(?:status|diff|log))/i;
const DIRECT_LOCATION_PATTERN = /(?:第\s*\d+\s*行|line\s*\d+|(?:^|[\s"'`])(?:[A-Za-z]:[\\/]|\.?\.?[\\/])?[^\s"'`]+\.(?:cs|ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|cpp|c|h|json|ya?ml|toml|md|unity|prefab|asset|uss|uxml|shader|mat|anim|controller|asmdef)(?=$|[\s"'`,;:]))/i;
const DIRECT_SYMBOL_PATTERN = /`[A-Za-z_$][A-Za-z0-9_$.:#-]*`|\b(?:I[A-Z][A-Za-z0-9_]*|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9_]*)+|[A-Z][A-Za-z0-9_]*(?:Service|Manager|Controller|Repository|Factory|Provider|Handler|Store|System|Module|Component))\b/;
const DIRECT_ACTION_PATTERN = /(?:修改|改成|替换|删除|读取|打开|查看|检查|只告诉我|edit|change|replace|delete|remove|read|open|show|view|inspect|tell me only)/i;
const RELATIONSHIP_PATTERN = /(?:调用链|调用方|被谁调用|引用|数据流|完整链路|跨模块|上下游|call\s+chain|callers?|callees?|references?|data\s+flow|cross[- ]module|end[- ]to[- ]end)/i;

const SEMANTIC_SIGNALS = [
  ['ownership', /(?:谁(?:来)?(?:持有|负责|管理|拥有|维护)|由谁(?:持有|负责|管理|维护)|状态.{0,12}(?:归谁|谁持有|谁负责)|所有权)/i],
  ['flow', /(?:完整|端到端|全量).{0,10}(?:链路|流程|数据流)|(?:调用链|数据流|依赖链|保存链路|存档链路|生命周期|上下游|跨模块|跨文件)/i],
  ['lifecycle', /从.{0,50}(?:加载|读取|创建|注册|生产).{0,100}(?:运行时|消费|解析|使用).{0,100}(?:保存|写回|持久化|落盘)/i],
  ['registration', /(?:接口|interface).{0,40}(?:实现|注册|解析|绑定)|(?:注册|依赖注入).{0,40}(?:实现|解析|绑定)/i],
  ['location', /(?:哪里|何处|在哪(?:里)?).{0,40}(?:实现|定义|注册|处理|持有)/i],
  ['behavior', /(?:如何|怎么).{0,40}(?:流转|传递|进入|保存|加载|注册|解析|工作)/i],
  ['ownership', /\b(?:who|what)\s+(?:owns|holds|manages|maintains|is\s+responsible\s+for)\b/i],
  ['flow', /\b(?:call\s+chain|callers?|callees?|references?|data\s+flow|ownership\s+boundary|cross[- ]module|cross[- ]file|end[- ]to[- ]end|full\s+(?:flow|chain|lifecycle)|save\/?load\s+flow|producer.{0,30}consumer)\b/i],
  ['lifecycle', /\bload\b.{0,100}\b(?:runtime|use|consume)\b.{0,100}\b(?:save|persist|write\s+back)\b/i],
  ['registration', /\b(?:interface|implementation|registration|dependency\s+injection)\b.{0,60}\b(?:resolve|wire|register|implement|bind)/i],
  ['location', /\bwhere\s+is\b.{0,80}\b(?:implemented|defined|registered|handled|owned)\b/i],
  ['behavior', /\bhow\s+does\b.{0,80}\b(?:work|flow|propagate|persist|load|save|resolve)\b/i],
];

export function classifyCcePrompt(rawPrompt) {
  const prompt = String(rawPrompt || '').trim();
  if (prompt.length < 6) return { match: false, reason: 'too_short' };
  if (OPT_OUT_PATTERN.test(prompt)) return { match: false, reason: 'cursor_opt_out' };
  if (EXTERNAL_INFO_PATTERN.test(prompt)) return { match: false, reason: 'external_information' };
  if (OPERATIONAL_PATTERN.test(prompt)) return { match: false, reason: 'operational_task' };

  const matched = SEMANTIC_SIGNALS.find(([, pattern]) => pattern.test(prompt));
  if (!matched) return { match: false, reason: 'no_semantic_signal' };

  const hasDirectLocation = DIRECT_LOCATION_PATTERN.test(prompt) || DIRECT_SYMBOL_PATTERN.test(prompt);
  const hasDirectAction = DIRECT_ACTION_PATTERN.test(prompt);
  if (hasDirectLocation && hasDirectAction && !RELATIONSHIP_PATTERN.test(prompt)) {
    return { match: false, reason: 'direct_known_location' };
  }

  return { match: true, reason: matched[0] };
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

export function routingStateRoot(options = {}) {
  if (options.stateRoot) return resolve(options.stateRoot);
  const configured = String(options.env?.CLAUDE_PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA ?? '').trim();
  return configured ? join(resolve(configured), 'cce-routing-state') : join(tmpdir(), 'cursor-bridge-cce-routing');
}

export function routingStatePath(sessionId, options = {}) {
  const safeSessionId = sanitizeSessionId(sessionId);
  if (!safeSessionId) return null;
  return join(routingStateRoot(options), `${safeSessionId}.json`);
}

export function routingClearPath(sessionId, options = {}) {
  const stateFile = routingStatePath(sessionId, options);
  return stateFile ? `${stateFile}.clear` : null;
}

function markClearIntent(sessionId, options = {}) {
  const clearFile = routingClearPath(sessionId, options);
  if (!clearFile) return false;
  try {
    mkdirSync(dirname(clearFile), { recursive: true });
    writeFileSync(clearFile, `${Date.now()}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function clearStateAndIntent(sessionId, options = {}) {
  removeState(sessionId, options);
  const clearFile = routingClearPath(sessionId, options);
  if (!clearFile) return;
  try {
    rmSync(clearFile, { force: true });
  } catch {
    // A surviving clear marker keeps the route failed open.
  }
}

function removeState(sessionId, options = {}) {
  const file = routingStatePath(sessionId, options);
  if (!file) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // Routing is advisory and must fail open.
  }
}

function writeState(sessionId, state, options = {}) {
  const file = routingStatePath(sessionId, options);
  if (!file) return false;
  if (options.failWrites) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function sleepSync(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    // Very old runtimes may not expose Atomics.wait; the next retry remains safe.
  }
}

function withStateLock(sessionId, options, callback, lockOptions = {}) {
  const file = routingStatePath(sessionId, options);
  if (!file) return { acquired: false, value: null };
  const lockFile = `${file}.lock`;
  const attempts = Math.max(1, Number(lockOptions.attempts || 1));
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return { acquired: false, value: null };
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let descriptor = null;
    try {
      descriptor = openSync(lockFile, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') return { acquired: false, value: null };
      if (attempt + 1 < attempts) sleepSync(ROUTING_LOCK_RETRY_MS);
      continue;
    }

    try {
      return { acquired: true, value: callback() };
    } catch {
      return { acquired: true, value: null };
    } finally {
      try {
        closeSync(descriptor);
      } catch {
        // Lock cleanup below remains best effort.
      }
      try {
        rmSync(lockFile, { force: true });
      } catch {
        // Lock contention and cleanup failures must fail open.
      }
    }
  }

  return { acquired: false, value: null };
}

export function readRoutingState(sessionId, options = {}) {
  const file = routingStatePath(sessionId, options);
  const clearFile = routingClearPath(sessionId, options);
  if (clearFile && existsSync(clearFile)) return null;
  if (!file || !existsSync(file)) return null;
  const now = Number(options.now ?? Date.now());
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isFinite(state.expiresAt) || state.expiresAt <= now) {
      removeState(sessionId, options);
      return null;
    }
    return state;
  } catch {
    removeState(sessionId, options);
    return null;
  }
}

function userPromptDecision(input, options = {}) {
  const sessionId = input.session_id;
  const classification = classifyCcePrompt(input.prompt ?? input.message ?? '');
  if (!classification.match) {
    markClearIntent(sessionId, options);
    withStateLock(
      sessionId,
      options,
      () => clearStateAndIntent(sessionId, options),
      { attempts: ROUTING_LOCK_CLEAR_ATTEMPTS },
    );
    return null;
  }

  const now = Number(options.now ?? Date.now());
  withStateLock(
    sessionId,
    options,
    () => {
      const clearFile = routingClearPath(sessionId, options);
      if (clearFile) rmSync(clearFile, { force: true });
      const written = writeState(sessionId, {
        createdAt: now,
        expiresAt: now + ROUTING_STATE_TTL_MS,
        reason: classification.reason,
        denials: 0,
      }, options);
      if (!written) removeState(sessionId, options);
    },
    { attempts: ROUTING_LOCK_CLEAR_ATTEMPTS },
  );

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        '<cce_routing priority="project-semantics">This prompt is a high-confidence project-semantic question about unknown ownership, behavior, relationships, or lifecycle. Call cursor_context_engine exactly once with the user\'s natural-language intent before generic context-mode collection or blind local discovery. Let Cursor choose the investigation depth. If CCE is unavailable, denied, fails, or returns NOT_FOUND, continue with one bounded local fallback. Do not submit the same lookup to both systems in parallel.</cce_routing>',
    },
  };
}

function preToolUseDecision(input, options = {}) {
  const sessionId = input.session_id;
  const toolName = String(input.tool_name || '');

  if (CCE_TOOL_PATTERN.test(toolName)) {
    markClearIntent(sessionId, options);
    withStateLock(
      sessionId,
      options,
      () => clearStateAndIntent(sessionId, options),
      { attempts: ROUTING_LOCK_CLEAR_ATTEMPTS },
    );
    return null;
  }

  if (!CONTEXT_MODE_TOOL_PATTERN.test(toolName)) return null;

  const decision = withStateLock(sessionId, options, () => {
    const state = readRoutingState(sessionId, options);
    if (!state) {
      clearStateAndIntent(sessionId, options);
      return null;
    }
    const denials = Number(state.denials || 0);
    if (denials >= MAX_CONTEXT_MODE_DENIALS) {
      removeState(sessionId, options);
      return null;
    }

    if (!writeState(sessionId, { ...state, denials: denials + 1 }, options)) {
      removeState(sessionId, options);
      return null;
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'This is a high-confidence project-semantic question. Call cursor_context_engine once before using context-mode collection. CCE chooses its own search depth; if that attempt fails or returns NOT_FOUND, a bounded local fallback is allowed.',
      },
    };
  });
  return decision.acquired ? decision.value : null;
}

export function handleHookInput(input, options = {}) {
  if (!input || typeof input !== 'object') return null;
  if (input.hook_event_name === 'UserPromptSubmit') return userPromptDecision(input, options);
  if (input.hook_event_name === 'PreToolUse') return preToolUseDecision(input, options);
  return null;
}

async function runFromStdin() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return;
    const result = handleHookInput(JSON.parse(raw));
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Hooks must never block Claude Code because of an internal failure.
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runFromStdin();
}
