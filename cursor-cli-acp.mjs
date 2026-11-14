import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { createCliConfigScope } from './cursor-cli-config.mjs';
import { resolveCliWorkspace } from './cursor-cli-workspace.mjs';
import {
  cleanCliText,
  isFastCliVariant,
  normalizeCliEffortName,
  readCursorCliIdentity,
  resolveCursorCliLauncher,
  stopCliProcessTree,
  stripFastCliSuffix,
  summarizeCliStderr,
} from './cursor-cli.mjs';

export const DEFAULT_ACP_IDLE_MS = 900_000;
export const DEFAULT_ACP_MAX_AGE_MS = 3_600_000;
export const DEFAULT_ACP_CAPABILITY_FAIL_TTL_MS = 300_000;
export const DEFAULT_ACP_POOL_SIZE = 1;
export const DEFAULT_ACP_CANCEL_GRACE_MS = 3_000;
export const DEFAULT_ACP_CLOSE_TIMEOUT_MS = 6_000;
export const DEFAULT_ACP_HANDSHAKE_TIMEOUT_MS = 30_000;
export const MAX_ACP_OUTPUT_BYTES = 8 * 1024 * 1024;

export const ACP_THINKING_CONFIG_IDS = new Set([
  'effort',
  'reasoning_effort',
  'thinking',
  'reasoning',
  'thought_level',
]);

function cliError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

function canonicalPath(value) {
  const normalized = path.normalize(String(value || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getAcpDisabledReason(env = process.env) {
  if (String(env?.CURSOR_BRIDGE_CCE_CLI_CHILD || '').trim() === '1') return 'child_process_guard';
  if (String(env?.CURSOR_BRIDGE_CCE_CLI_ACP || '').trim().toLowerCase() === 'off') return 'env_disabled';
  return null;
}

function normalizeModelIdentityKey(value) {
  const cleaned = cleanCliText(value).toLowerCase().trim();
  const stripped = cleaned.startsWith('cursor-') && cleaned.length > 7
    ? cleaned.slice(7)
    : cleaned.startsWith('cursor ') && cleaned.length > 7
      ? cleaned.slice(7)
      : cleaned;
  return stripped.replace(/(\d)[_-](?=\d)/g, '$1.').replace(/[^a-z0-9.]+/g, '');
}

export function parseAcpModelPreference(modelPreference) {
  const base = String(modelPreference?.model || '').trim();
  const effort = normalizeCliEffortName(modelPreference?.effort);
  const requestedFast = isFastCliVariant(base);
  const stem = stripFastCliSuffix(base).replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  if (!base || !stem || /^(?:auto|default)$/i.test(base) || /^(?:auto|default)$/i.test(stem)
    || !effort || !/^(?:minimal|low|medium|high|xhigh|max)$/.test(effort)) {
    throw cliError('CURSOR_CLI_MODEL_REQUIRED', 'An explicit named model and effort are required', {
      confirmedNotSent: true,
      confirmedTerminal: true,
      sent: false,
    });
  }
  const bareStem = stem.startsWith('cursor-') && stem.length > 7 ? stem.slice(7) : stem;
  return {
    base,
    rawEffort: modelPreference.effort,
    effort,
    requestedFast,
    stem,
    bareStem,
    identityKey: normalizeModelIdentityKey(bareStem),
  };
}

function findUniqueConfigOption(configOptions, predicate) {
  if (!Array.isArray(configOptions)) return null;
  const matches = configOptions.filter(opt => opt && typeof opt === 'object' && predicate(opt));
  return matches.length === 1 ? matches[0] : null;
}

function optionEntries(option) {
  return Array.isArray(option?.options) ? option.options.filter(item => item && item.value !== undefined && item.value !== null) : [];
}

export function resolveAcpModelOption(configOptions, parsedPreference) {
  const modelOption = findUniqueConfigOption(configOptions, opt => opt.id === 'model');
  if (!modelOption) return { ok: false, reason: 'missing_model_config' };
  const entries = optionEntries(modelOption).filter(item => {
    const val = cleanCliText(item.value);
    const name = cleanCliText(item.name);
    if (/\[effort=/i.test(val) || /\[effort=/i.test(name)) return false;
    if (isFastCliVariant(val) || isFastCliVariant(name)) return false;
    return true;
  });
  const exactTargets = new Set([parsedPreference.stem.toLowerCase(), parsedPreference.bareStem.toLowerCase()]);
  let matches = entries.filter(item => exactTargets.has(cleanCliText(item.value).toLowerCase()));
  if (matches.length === 0) {
    matches = entries.filter(item =>
      normalizeModelIdentityKey(item.value) === parsedPreference.identityKey
      || (item.name && normalizeModelIdentityKey(item.name) === parsedPreference.identityKey));
  }
  if (matches.length !== 1) return { ok: false, reason: 'model_option_unavailable' };
  return {
    ok: true,
    option: modelOption,
    desiredValue: String(matches[0].value),
    currentValue: modelOption.currentValue == null ? null : String(modelOption.currentValue),
  };
}

export function resolveAcpModelDependentOptions(configOptions, parsedPreference) {
  const modeOption = findUniqueConfigOption(configOptions, opt => opt.id === 'mode');
  if (!modeOption) return { ok: false, reason: 'missing_mode_config' };
  const askMatches = optionEntries(modeOption).filter(item => cleanCliText(item.value).toLowerCase() === 'ask');
  if (askMatches.length !== 1) return { ok: false, reason: 'ask_mode_unavailable' };

  const thinkingOption = findUniqueConfigOption(configOptions, opt => ACP_THINKING_CONFIG_IDS.has(opt.id));
  if (!thinkingOption) return { ok: false, reason: 'thinking_option_unavailable' };
  const effortMatches = optionEntries(thinkingOption).filter(item =>
    normalizeCliEffortName(cleanCliText(item.value)) === parsedPreference.effort
    || (item.name && normalizeCliEffortName(cleanCliText(item.name)) === parsedPreference.effort));
  if (effortMatches.length !== 1) return { ok: false, reason: 'effort_option_unavailable' };

  const fastOptions = Array.isArray(configOptions) ? configOptions.filter(opt => opt && opt.id === 'fast') : [];
  if (fastOptions.length > 1) return { ok: false, reason: 'fast_option_ambiguous' };
  const fastOption = fastOptions[0] || null;
  let desiredFastValue = null;
  if (parsedPreference.requestedFast) {
    if (!fastOption) return { ok: false, reason: 'fast_option_unavailable' };
    const trueMatches = optionEntries(fastOption).filter(item => cleanCliText(String(item.value)).toLowerCase() === 'true');
    if (trueMatches.length !== 1) return { ok: false, reason: 'fast_option_unavailable' };
    desiredFastValue = String(trueMatches[0].value);
  } else if (fastOption) {
    const falseMatches = optionEntries(fastOption).filter(item => cleanCliText(String(item.value)).toLowerCase() === 'false');
    if (falseMatches.length !== 1) return { ok: false, reason: 'fast_option_unavailable' };
    desiredFastValue = String(falseMatches[0].value);
  }

  return {
    ok: true,
    mode: {
      configId: 'mode',
      desiredValue: String(askMatches[0].value),
      currentValue: modeOption.currentValue == null ? null : String(modeOption.currentValue),
    },
    thinking: {
      configId: thinkingOption.id,
      desiredValue: String(effortMatches[0].value),
      currentValue: thinkingOption.currentValue == null ? null : String(thinkingOption.currentValue),
    },
    fast: fastOption ? {
      configId: 'fast',
      desiredValue: desiredFastValue,
      currentValue: fastOption.currentValue == null ? null : String(fastOption.currentValue),
    } : null,
  };
}

export function verifyAcpConfigReadback(configOptions, expected) {
  if (!Array.isArray(configOptions)) return { ok: false, reason: 'config_options_missing' };
  const modeOption = findUniqueConfigOption(configOptions, opt => opt.id === 'mode');
  const modelOption = findUniqueConfigOption(configOptions, opt => opt.id === 'model');
  const thinkingOption = findUniqueConfigOption(configOptions, opt => ACP_THINKING_CONFIG_IDS.has(opt.id));
  const fastOptions = configOptions.filter(opt => opt && opt.id === 'fast');

  if (!modeOption || String(modeOption.currentValue) !== String(expected.modeValue)) {
    return { ok: false, reason: 'mode_readback_mismatch' };
  }
  if (!modelOption || String(modelOption.currentValue) !== String(expected.modelValue)) {
    return { ok: false, reason: 'model_readback_mismatch' };
  }
  if (!thinkingOption || thinkingOption.id !== expected.thinkingConfigId
    || String(thinkingOption.currentValue) !== String(expected.thinkingValue)) {
    return { ok: false, reason: 'thinking_readback_mismatch' };
  }
  if (expected.fastValue !== null && expected.fastValue !== undefined) {
    if (fastOptions.length !== 1 || String(fastOptions[0].currentValue) !== String(expected.fastValue)) {
      return { ok: false, reason: 'fast_readback_mismatch' };
    }
  } else if (fastOptions.length > 0 && String(fastOptions[0].currentValue).toLowerCase() === 'true') {
    return { ok: false, reason: 'fast_readback_mismatch' };
  }
  return { ok: true, reason: null };
}

export function buildPermissionDenialResult(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const rejectOption = options.find(opt => opt && opt.optionId != null && (
    /reject/i.test(String(opt.kind || ''))
    || /reject|deny|decline/i.test(String(opt.optionId || ''))
    || /\b(?:reject|deny|decline)\b/i.test(String(opt.name || ''))
  ));
  if (rejectOption) {
    return { outcome: { outcome: 'selected', optionId: String(rejectOption.optionId) } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

export class CursorCliAcpManager {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.spawn = options.spawn || nodeSpawn;
    this.killTree = options.killTree || null;
    this.inspectIdentity = options.inspectIdentity || readCursorCliIdentity;
    this.resolveLauncher = options.resolveLauncher || resolveCursorCliLauncher;
    this.createScope = options.createScope || createCliConfigScope;
    this.resolveWorkspace = options.resolveWorkspace || resolveCliWorkspace;
    this.enumerateMcpImpl = options.enumerateMcpImpl;
    this.userHome = options.userHome;
    this.now = options.now || (() => Date.now());
    this.poolSize = options.poolSize ?? DEFAULT_ACP_POOL_SIZE;
    this.idleMs = options.idleMs ?? parsePositiveInt(this.env.CURSOR_BRIDGE_CCE_CLI_ACP_IDLE_MS, DEFAULT_ACP_IDLE_MS);
    this.maxAgeMs = options.maxAgeMs ?? parsePositiveInt(this.env.CURSOR_BRIDGE_CCE_CLI_ACP_MAX_AGE_MS, DEFAULT_ACP_MAX_AGE_MS);
    this.capabilityFailTtlMs = options.capabilityFailTtlMs ?? parseNonNegativeInt(
      this.env.CURSOR_BRIDGE_CCE_CLI_ACP_FAIL_TTL_MS,
      DEFAULT_ACP_CAPABILITY_FAIL_TTL_MS,
    );
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_ACP_CANCEL_GRACE_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_ACP_CLOSE_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_ACP_HANDSHAKE_TIMEOUT_MS;

    this.processes = new Map();
    this.capabilityFailures = new Map();
    this.closing = false;
    this.stats = {
      promptsServed: 0,
      fallbacks: 0,
      lastFallbackReason: null,
      lastUnavailableReason: null,
    };
  }

  _buildProcessKey({ cwd, parsedPreference, identityKey }) {
    return JSON.stringify([
      canonicalPath(cwd),
      parsedPreference.identityKey,
      parsedPreference.effort,
      parsedPreference.requestedFast,
      identityKey,
    ]);
  }

  _recordCapabilityFailure(identityKey, reason) {
    this.stats.lastUnavailableReason = reason;
    if (this.capabilityFailTtlMs > 0 && identityKey) {
      this.capabilityFailures.set(identityKey, { reason, atMs: this.now() });
    }
  }

  _getCapabilityFailure(identityKey) {
    if (!identityKey) return null;
    const entry = this.capabilityFailures.get(identityKey);
    if (!entry) return null;
    if (this.capabilityFailTtlMs <= 0 || (this.now() - entry.atMs) >= this.capabilityFailTtlMs) {
      this.capabilityFailures.delete(identityKey);
      return null;
    }
    return entry;
  }

  _clearTimers(proc) {
    if (proc.idleTimer) {
      clearTimeout(proc.idleTimer);
      proc.idleTimer = null;
    }
    if (proc.maxAgeTimer) {
      clearTimeout(proc.maxAgeTimer);
      proc.maxAgeTimer = null;
    }
  }

  _touchIdleTimer(proc) {
    if (proc.idleTimer) {
      clearTimeout(proc.idleTimer);
      proc.idleTimer = null;
    }
    if (proc.state === 'closing' || proc.state === 'closed' || proc.state === 'failed' || proc.state === 'orphaned') return;
    if (!(this.idleMs > 0)) return;
    proc.idleTimer = setTimeout(() => {
      proc.idleTimer = null;
      if (proc.activePrompts.size > 0 || proc.replenishing) return;
      void this._retireProcess(proc, 'idle_timeout');
    }, this.idleMs);
    proc.idleTimer.unref?.();
  }

  _startMaxAgeTimer(proc) {
    if (proc.maxAgeTimer) {
      clearTimeout(proc.maxAgeTimer);
      proc.maxAgeTimer = null;
    }
    if (!(this.maxAgeMs > 0)) return;
    proc.maxAgeTimer = setTimeout(() => {
      proc.maxAgeTimer = null;
      if (proc.activePrompts.size > 0) {
        proc.retireAfterActive = true;
        return;
      }
      void this._retireProcess(proc, 'max_age');
    }, this.maxAgeMs);
    proc.maxAgeTimer.unref?.();
  }

  async _resolveEnvironment({ env, cli, projectPath }) {
    const activeEnv = env || this.env;
    const disabledReason = getAcpDisabledReason(activeEnv);
    if (disabledReason) return { eligible: false, reason: disabledReason };
    if (this.closing) return { eligible: false, reason: 'manager_closing' };
    if (cli?.provider) return { eligible: false, reason: 'local_provider' };

    const workspace = await this.resolveWorkspace(projectPath);
    if (workspace.additionalRoots.length > 0) {
      return { eligible: false, reason: 'multi_root_workspace', workspace };
    }

    const identity = await this.inspectIdentity({
      env: activeEnv,
      ...(cli?.launcher ? { launcher: cli.launcher } : {}),
    });
    if (!identity?.available || !identity?.key) {
      return { eligible: false, reason: identity?.reason || 'CURSOR_CLI_UNAVAILABLE', workspace };
    }
    const launcher = cli?.launcher || identity.launcher || await this.resolveLauncher({ env: activeEnv });
    const cachedFailure = this._getCapabilityFailure(identity.key);
    if (cachedFailure) {
      return { eligible: false, reason: cachedFailure.reason, workspace, identityKey: identity.key };
    }
    return { eligible: true, env: activeEnv, workspace, identityKey: identity.key, launcher };
  }

  _sendRpc(proc, method, params, timeoutMs) {
    if (!proc.child?.stdin || proc.child.stdin.destroyed || proc.child.stdin.writableEnded) {
      return Promise.reject(cliError('CURSOR_CLI_EXIT_ERROR', 'ACP process stdin is closed'));
    }
    const id = ++proc.nextRpcId;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          proc.pendingRpc.delete(id);
          reject(cliError('CURSOR_CLI_TIMEOUT', `Cursor CLI ACP ${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
      }
      proc.pendingRpc.set(id, { resolve, reject, timer });
      try {
        proc.child.stdin.write(payload, 'utf8');
      } catch (cause) {
        proc.pendingRpc.delete(id);
        if (timer) clearTimeout(timer);
        reject(cliError('CURSOR_CLI_EXIT_ERROR', 'Failed to write ACP request', { cause }));
      }
    });
  }

  _sendNotification(proc, method, params) {
    if (!proc.child?.stdin || proc.child.stdin.destroyed || proc.child.stdin.writableEnded) return false;
    try {
      proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  _replyRpcResult(proc, id, result) {
    if (!proc.child?.stdin || proc.child.stdin.destroyed || proc.child.stdin.writableEnded) return;
    try {
      proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n', 'utf8');
    } catch {}
  }

  _replyRpcError(proc, id, code, message) {
    if (!proc.child?.stdin || proc.child.stdin.destroyed || proc.child.stdin.writableEnded) return;
    try {
      proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n', 'utf8');
    } catch {}
  }

  async _cleanupScopeSafely(proc) {
    if (!proc.scope || proc.retainScope) return;
    const scope = proc.scope;
    proc.scope = null;
    await scope.cleanup().catch(error => {
      console.error(`[cursor-bridge] ACP CLI configuration-copy cleanup failed: ${error?.code || 'unknown'}`);
    });
  }

  _handleStdoutLine(proc, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._failAllPending(proc, cliError('CURSOR_CLI_PROTOCOL_ERROR', 'Cursor CLI ACP emitted invalid JSON'));
      void this._retireProcess(proc, 'protocol_error');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this._failAllPending(proc, cliError('CURSOR_CLI_PROTOCOL_ERROR', 'Cursor CLI ACP emitted an invalid message'));
      void this._retireProcess(proc, 'protocol_error');
      return;
    }

    if (msg.id !== undefined && msg.method === undefined && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) {
      const waiter = proc.pendingRpc.get(msg.id);
      if (!waiter) return;
      proc.pendingRpc.delete(msg.id);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (msg.error) {
        const err = cliError('CURSOR_CLI_ACP_RPC_ERROR', String(msg.error.message || 'Cursor CLI ACP error'), {
          rpcCode: msg.error.code,
        });
        waiter.reject(err);
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'session/request_permission') {
        this._replyRpcResult(proc, msg.id, buildPermissionDenialResult(msg.params));
      } else {
        this._replyRpcError(proc, msg.id, -32601, `Method not supported in read-only CCE ACP client: ${msg.method}`);
      }
      return;
    }

    if (msg.method === 'session/update') {
      const sessionId = msg.params?.sessionId;
      const active = sessionId ? proc.activePrompts.get(sessionId) : null;
      const update = msg.params?.update;
      if (active && update && typeof update === 'object' && update.sessionUpdate === 'agent_message_chunk') {
        const text = update.content?.text;
        if (typeof text === 'string' && text.length > 0) {
          active.outputBytes += Buffer.byteLength(text, 'utf8');
          if (active.outputBytes > MAX_ACP_OUTPUT_BYTES) {
            const limitErr = cliError('CURSOR_CLI_OUTPUT_LIMIT', 'Cursor CLI ACP output exceeded the limit');
            active.abortWithError?.(limitErr);
            return;
          }
          active.chunks.push(text);
        }
      }
    }
  }

  _failAllPending(proc, error) {
    for (const [id, waiter] of proc.pendingRpc) {
      proc.pendingRpc.delete(id);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async _terminateProcess(proc, reason = 'shutdown', { closeTimeoutMs = this.closeTimeoutMs } = {}) {
    if (proc.stopPromise) return proc.stopPromise;
    const hadActivePrompt = proc.activePrompts.size > 0;
    proc.state = 'closing';
    this._clearTimers(proc);
    if (this.processes.get(proc.key) === proc) this.processes.delete(proc.key);

    proc.stopPromise = (async () => {
      const child = proc.child;
      let confirmedTerminal = false;
      if (!child || proc.closed) {
        confirmedTerminal = !hadActivePrompt;
      } else {
        const stopped = await stopCliProcessTree(child, { killTree: this.killTree }).then(
          value => value !== false,
          () => false,
        );
        try {
          child.stdin?.end();
        } catch {}
        if (stopped || (!hadActivePrompt && (proc.closed || child.exitCode != null || child.signalCode != null))) {
          confirmedTerminal = await new Promise(resolve => {
            if (proc.closed) {
              resolve(true);
              return;
            }
            let done = false;
            const onClose = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve(true);
            };
            const timer = setTimeout(() => {
              if (done) return;
              done = true;
              child.removeListener('close', onClose);
              resolve(false);
            }, Math.max(10, closeTimeoutMs));
            timer.unref?.();
            child.once('close', onClose);
          });
        }
      }

      if (confirmedTerminal) {
        proc.state = 'closed';
        await this._cleanupScopeSafely(proc);
      } else {
        proc.state = 'orphaned';
        proc.retainScope = true;
      }

      if (proc.pendingRpc.size > 0) {
        this._failAllPending(
          proc,
          cliError('CURSOR_CLI_ACP_CLOSED', `Cursor CLI ACP process terminated (${reason})`, {
            confirmedTerminal,
            confirmedNotSent: false,
            cliProcessId: child?.pid || null,
            ...(!confirmedTerminal ? {
              cliConfigDirectory: proc.scope?.directory || null,
              cliDataDirectory: proc.scope?.dataDirectory || null,
            } : {}),
          }),
        );
      }

      return {
        confirmedTerminal,
        reason,
        cliProcessId: child?.pid || null,
        cliConfigDirectory: proc.scope?.directory || null,
        cliDataDirectory: proc.scope?.dataDirectory || null,
      };
    })();
    return proc.stopPromise;
  }

  async _retireProcess(proc, reason) {
    if (proc && !proc.child && !proc.scope && !proc.stopPromise) {
      proc.cancelledBeforeSpawn = true;
      proc.cancelReason = reason;
      proc.state = 'closing';
      if (this.processes.get(proc.key) === proc) this.processes.delete(proc.key);
      return { confirmedTerminal: true, reason, cliProcessId: null, cliConfigDirectory: null, cliDataDirectory: null };
    }
    const err = cliError('CURSOR_CLI_ACP_RETIRED', `Cursor CLI ACP process retired (${reason})`, {
      confirmedNotSent: true,
      confirmedTerminal: true,
    });
    this._failAllPending(proc, err);
    return this._terminateProcess(proc, reason);
  }

  async _spawnProcess({ key, cwd, launcher, env, parsedPreference, identityKey, onProcess }) {
    const scope = await this.createScope(env, {
      cwd,
      userHome: this.userHome,
      enumerateMcpImpl: this.enumerateMcpImpl,
    });
    const childEnv = {
      ...scope.env,
      CURSOR_BRIDGE_CCE_CLI_CHILD: '1',
      CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
      CURSOR_BRIDGE_DELEGATION: 'off',
    };

    const proc = {
      key,
      cwd,
      parsedPreference,
      identityKey,
      scope,
      launcher,
      child: null,
      state: 'starting',
      createdAtMs: this.now(),
      lastUsedAtMs: this.now(),
      nextRpcId: 0,
      pendingRpc: new Map(),
      activePrompts: new Map(),
      readySessions: [],
      acquiringSession: false,
      replenishing: null,
      setupTail: Promise.resolve(),
      stderr: '',
      pendingStdout: '',
      nonPromptBytes: 0,
      closed: false,
      retainScope: false,
      retireAfterActive: false,
      idleTimer: null,
      maxAgeTimer: null,
      stopPromise: null,
      startupPromise: null,
      capabilityError: null,
    };

    if (this.closing) {
      await this._cleanupScopeSafely(proc);
      throw cliError('CURSOR_CLI_CANCELLED', 'ACP manager is shutting down', { confirmedNotSent: true, confirmedTerminal: true });
    }
    onProcess?.(proc);

    try {
      proc.child = this.spawn(
        launcher.command,
        [...(launcher.args || []), '--workspace', cwd, '--trust', 'acp'],
        {
          cwd,
          env: childEnv,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (cause) {
      await this._cleanupScopeSafely(proc);
      throw cliError('CURSOR_CLI_EXIT_ERROR', 'Failed to spawn Cursor CLI ACP process', {
        cause,
        confirmedNotSent: true,
        confirmedTerminal: true,
      });
    }

    proc.child.stdout.setEncoding('utf8');
    proc.child.stderr.setEncoding('utf8');
    proc.child.stdout.on('data', chunk => {
      if (proc.closed || proc.state === 'closing') return;
      proc.pendingStdout += chunk;
      if (Buffer.byteLength(proc.pendingStdout, 'utf8') > MAX_ACP_OUTPUT_BYTES) {
        const limitErr = cliError('CURSOR_CLI_OUTPUT_LIMIT', 'Cursor CLI ACP stdout line exceeded the limit');
        this._failAllPending(proc, limitErr);
        void this._terminateProcess(proc, 'output_limit');
        return;
      }
      let boundary;
      while ((boundary = proc.pendingStdout.indexOf('\n')) >= 0) {
        const rawLine = proc.pendingStdout.slice(0, boundary).replace(/\r$/, '');
        proc.pendingStdout = proc.pendingStdout.slice(boundary + 1);
        if (!rawLine.trim()) continue;
        if (proc.activePrompts.size === 0) {
          proc.nonPromptBytes += Buffer.byteLength(rawLine, 'utf8');
          if (proc.nonPromptBytes > MAX_ACP_OUTPUT_BYTES) {
            const limitErr = cliError('CURSOR_CLI_OUTPUT_LIMIT', 'Cursor CLI ACP output exceeded the limit');
            this._failAllPending(proc, limitErr);
            void this._terminateProcess(proc, 'output_limit');
            return;
          }
        }
        this._handleStdoutLine(proc, rawLine);
      }
    });
    proc.child.stderr.on('data', chunk => {
      proc.stderr = (proc.stderr + chunk).slice(-4096);
    });
    proc.child.stdin.on('error', cause => {
      if (!proc.closed && proc.state !== 'closing') {
        const detail = summarizeCliStderr(proc.stderr);
        const err = cliError('CURSOR_CLI_EXIT_ERROR', `Cursor CLI ACP stdin failed${detail ? ': ' + detail : ''}`, { cause });
        this._failAllPending(proc, err);
      }
    });
    proc.child.on('error', cause => {
      const err = cliError('CURSOR_CLI_EXIT_ERROR', 'Cursor CLI ACP process error', { cause });
      this._failAllPending(proc, err);
    });
    proc.child.on('close', (code, signal) => {
      if (proc.closed) return;
      proc.closed = true;
      this._clearTimers(proc);
      if (this.processes.get(proc.key) === proc) this.processes.delete(proc.key);

      const detail = summarizeCliStderr(proc.stderr);
      const exitedUnexpectedly = !proc.stopPromise && proc.state !== 'closing' && proc.state !== 'closed';
      if (exitedUnexpectedly) {
        proc.state = 'failed';
        // Any prompt still open on close cannot prove detached descendant termination.
        const hasActivePrompt = proc.activePrompts.size > 0;
        if (hasActivePrompt) proc.retainScope = true;
        const exitError = cliError(
          code === 0 ? 'CURSOR_CLI_PROTOCOL_ERROR' : 'CURSOR_CLI_EXIT_ERROR',
          code === 0
            ? 'Cursor CLI ACP closed before completing the prompt'
            : `Cursor CLI ACP exited unsuccessfully${detail ? ': ' + detail : ''}`,
          {
            exitCode: code,
            signal,
            cliProcessId: proc.child?.pid || null,
            ...(hasActivePrompt
              ? {
                confirmedTerminal: false,
                sent: true,
                confirmedNotSent: false,
                cliConfigDirectory: proc.scope?.directory || null,
                cliDataDirectory: proc.scope?.dataDirectory || null,
              }
              : {
                confirmedTerminal: true,
                confirmedNotSent: true,
                sent: false,
              }),
          },
        );
        this._failAllPending(proc, exitError);
      }
      if (!proc.retainScope && !proc.stopPromise) {
        void this._cleanupScopeSafely(proc);
      }
    });

    this._touchIdleTimer(proc);
    this._startMaxAgeTimer(proc);

    const startupPromise = (async () => {
      const initResult = await this._sendRpc(
        proc,
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            _meta: { parameterizedModelPicker: true },
          },
        },
        this.handshakeTimeoutMs,
      );
      if (!initResult || typeof initResult !== 'object' || initResult.protocolVersion !== 1) {
        const err = cliError('CURSOR_CLI_ACP_UNSUPPORTED', 'Cursor CLI ACP initialize returned an unsupported handshake');
        err.capabilityFailureReason = 'acp_initialize_unsupported';
        throw err;
      }
      proc.state = 'ready';
      const firstSession = await this._createVerifiedSession(proc, parsedPreference);
      proc.readySessions.push(firstSession);
      this._touchIdleTimer(proc);
      return proc;
    })();
    proc.startupPromise = startupPromise;

    try {
      await startupPromise;
      return proc;
    } catch (error) {
      proc.capabilityError = error;
      if (error?.capabilityFailureReason) {
        this._recordCapabilityFailure(identityKey, error.capabilityFailureReason);
      } else if (error?.code === 'CURSOR_CLI_EXIT_ERROR' || error?.code === 'CURSOR_CLI_ACP_RPC_ERROR' || error?.code === 'CURSOR_CLI_TIMEOUT') {
        this._recordCapabilityFailure(identityKey, error.code.toLowerCase());
      }
      await this._terminateProcess(proc, 'startup_failed');
      throw error;
    }
  }

  _enqueueSetup(proc, fn) {
    const run = proc.setupTail.then(fn, fn);
    proc.setupTail = run.catch(() => {});
    return run;
  }

  async _createVerifiedSession(proc, parsedPreference) {
    return this._enqueueSetup(proc, async () => {
      if (proc.closed || proc.state === 'closing' || proc.state === 'failed' || proc.state === 'orphaned') {
        throw cliError('CURSOR_CLI_ACP_CLOSED', 'ACP process is no longer active', { confirmedNotSent: true });
      }
      const created = await this._sendRpc(proc, 'session/new', { cwd: proc.cwd, mcpServers: [] }, this.handshakeTimeoutMs);
      const sessionId = created?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(created?.configOptions)) {
        const err = cliError('CURSOR_CLI_ACP_UNSUPPORTED', 'Cursor CLI ACP session/new did not expose parameterized configOptions', {
          confirmedNotSent: true,
        });
        err.capabilityFailureReason = 'acp_missing_config_options';
        throw err;
      }
      proc.nonPromptBytes = 0;

      let configOptions = created.configOptions;
      const modelPlan = resolveAcpModelOption(configOptions, parsedPreference);
      if (!modelPlan.ok) {
        const err = cliError('CURSOR_CLI_ACP_INCOMPATIBLE', 'Model preference is incompatible with ACP selection', {
          confirmedNotSent: true,
          capabilityFailureReason: modelPlan.reason,
        });
        throw err;
      }

      if (modelPlan.currentValue !== modelPlan.desiredValue) {
        const appliedModel = await this._sendRpc(
          proc,
          'session/set_config_option',
          { sessionId, configId: 'model', value: modelPlan.desiredValue },
          this.handshakeTimeoutMs,
        );
        if (!Array.isArray(appliedModel?.configOptions)) {
          const err = cliError('CURSOR_CLI_ACP_UNSUPPORTED', 'ACP set_config_option(model) did not return configOptions', {
            confirmedNotSent: true,
            capabilityFailureReason: 'acp_config_readback_missing',
          });
          throw err;
        }
        configOptions = appliedModel.configOptions;
      }

      const dependentPlan = resolveAcpModelDependentOptions(configOptions, parsedPreference);
      if (!dependentPlan.ok) {
        const err = cliError('CURSOR_CLI_ACP_INCOMPATIBLE', 'Model parameters are incompatible with ACP selection', {
          confirmedNotSent: true,
          capabilityFailureReason: dependentPlan.reason,
        });
        throw err;
      }

      const applyIfChanged = async (step) => {
        if (!step || step.currentValue === step.desiredValue) return;
        const applied = await this._sendRpc(
          proc,
          'session/set_config_option',
          { sessionId, configId: step.configId, value: step.desiredValue },
          this.handshakeTimeoutMs,
        );
        if (!Array.isArray(applied?.configOptions)) {
          throw cliError('CURSOR_CLI_ACP_UNSUPPORTED', `ACP set_config_option(${step.configId}) did not return configOptions`, {
            confirmedNotSent: true,
            capabilityFailureReason: 'acp_config_readback_missing',
          });
        }
        configOptions = applied.configOptions;
      };

      await applyIfChanged(dependentPlan.thinking);
      await applyIfChanged(dependentPlan.fast);
      // Session mode is always set explicitly to 'ask' on each fresh session unless already confirmed 'ask'.
      await applyIfChanged(dependentPlan.mode);

      const verification = verifyAcpConfigReadback(configOptions, {
        modeValue: dependentPlan.mode.desiredValue,
        modelValue: modelPlan.desiredValue,
        thinkingConfigId: dependentPlan.thinking.configId,
        thinkingValue: dependentPlan.thinking.desiredValue,
        fastValue: dependentPlan.fast ? dependentPlan.fast.desiredValue : null,
      });
      if (!verification.ok) {
        throw cliError('CURSOR_CLI_MODEL_MISMATCH', `Cursor CLI ACP configuration readback failed (${verification.reason})`, {
          confirmedNotSent: true,
          capabilityFailureReason: verification.reason,
        });
      }

      return {
        sessionId,
        createdAtMs: this.now(),
        modelSelection: {
          configured: true,
          applied: true,
          requestedModel: parsedPreference.base,
          requestedEffort: parsedPreference.rawEffort,
          effectiveModel: parsedPreference.base,
          effectiveEffort: parsedPreference.effort,
          verificationSource: 'cursor_cli_acp_config',
          acpModel: modelPlan.desiredValue,
          verifiedAt: new Date().toISOString(),
        },
      };
    });
  }

  _replenishPool(proc) {
    if (proc.replenishing || proc.closed || proc.state !== 'ready' || proc.retireAfterActive || this.closing) {
      return proc.replenishing;
    }
    if (proc.readySessions.length >= this.poolSize) return null;
    proc.replenishing = (async () => {
      try {
        while (!proc.closed && proc.state === 'ready' && !proc.retireAfterActive && !this.closing
          && proc.readySessions.length < this.poolSize) {
          const session = await this._createVerifiedSession(proc, proc.parsedPreference);
          if (proc.closed || proc.state !== 'ready' || proc.retireAfterActive || this.closing) break;
          proc.readySessions.push(session);
        }
      } catch (error) {
        if (error?.capabilityFailureReason) {
          this._recordCapabilityFailure(proc.identityKey, error.capabilityFailureReason);
          void this._retireProcess(proc, error.capabilityFailureReason);
        }
      } finally {
        proc.replenishing = null;
        this._touchIdleTimer(proc);
      }
    })();
    return proc.replenishing;
  }

  async _acquireReadySession(proc) {
    if (proc.readySessions.length > 0) {
      return proc.readySessions.shift();
    }
    if (proc.replenishing) {
      await proc.replenishing;
      if (proc.readySessions.length > 0) {
        return proc.readySessions.shift();
      }
    }
    return this._createVerifiedSession(proc, proc.parsedPreference);
  }

  async prewarm({ projectPath, modelPreference, cli, env } = {}) {
    if (this.closing) return { warmed: false, reason: 'manager_closing' };
    let parsedPreference;
    try {
      parsedPreference = parseAcpModelPreference(modelPreference);
    } catch {
      return { warmed: false, reason: 'invalid_model_preference' };
    }
    let resolved;
    try {
      resolved = await this._resolveEnvironment({ env, cli, projectPath });
    } catch {
      return { warmed: false, reason: 'workspace_unavailable' };
    }
    if (!resolved.eligible) return { warmed: false, reason: resolved.reason };

    const key = this._buildProcessKey({
      cwd: resolved.workspace.cwd,
      parsedPreference,
      identityKey: resolved.identityKey,
    });
    const existing = this.processes.get(key);
    if (existing && (existing.state === 'starting' || existing.state === 'ready')) {
      try {
        await existing.startupPromise;
        return { warmed: true, reused: true, readySessions: existing.readySessions.length };
      } catch {
        return { warmed: false, reason: existing.capabilityError?.capabilityFailureReason || 'startup_failed' };
      }
    }

    const placeholder = {
      key,
      state: 'starting',
      readySessions: [],
      activePrompts: new Map(),
      startupPromise: null,
      cancelledBeforeSpawn: false,
      cancelReason: null,
    };
    this.processes.set(key, placeholder);
    const spawnPromise = this._spawnProcess({
      key,
      cwd: resolved.workspace.cwd,
      launcher: resolved.launcher,
      env: resolved.env,
      parsedPreference,
      identityKey: resolved.identityKey,
      onProcess: proc => {
        if (placeholder.cancelledBeforeSpawn || this.closing) {
          void this._retireProcess(proc, placeholder.cancelReason || 'cancelled_before_spawn');
          return;
        }
        proc.cwd = resolved.workspace.cwd;
        this.processes.set(key, proc);
      },
    });
    placeholder.startupPromise = spawnPromise;
    try {
      const proc = await spawnPromise;
      return { warmed: true, reused: false, readySessions: proc.readySessions.length };
    } catch (error) {
      if (this.processes.get(key) === placeholder) this.processes.delete(key);
      return { warmed: false, reason: error?.capabilityFailureReason || error?.code || 'startup_failed' };
    }
  }

  async _executePromptOnProcess(proc, session, { prompt, timeoutMs = 120_000, signal, onDispatch, onInit }) {
    const sid = session.sessionId;
    if (signal?.aborted) {
      throw cliError('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled', {
        cancelled: true,
        stopConfirmed: true,
        confirmedTerminal: true,
        confirmedNotSent: true,
        sent: false,
      });
    }
    if (proc.closed || proc.state !== 'ready') {
      throw cliError('CURSOR_CLI_ACP_CLOSED', 'Cursor CLI ACP process is not ready', {
        confirmedNotSent: true,
        confirmedTerminal: true,
        sent: false,
      });
    }

    onDispatch?.();
    if (signal?.aborted) {
      throw cliError('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled', {
        cancelled: true,
        stopConfirmed: true,
        confirmedTerminal: true,
        confirmedNotSent: true,
        sent: false,
      });
    }

    const active = {
      sessionId: sid,
      chunks: [],
      outputBytes: 0,
      dispatched: true,
      abortWithError: null,
    };
    proc.activePrompts.set(sid, active);
    proc.lastUsedAtMs = this.now();
    this._touchIdleTimer(proc);

    const effectiveTimeoutMs = Math.max(1, Number(timeoutMs) || 120_000);
    const rpcPromise = this._sendRpc(
      proc,
      'session/prompt',
      { sessionId: sid, prompt: [{ type: 'text', text: prompt }] },
      0,
    );
    // Notify caller immediately after writing session/prompt so cancellation and state track ACP turn.
    onInit?.({ sessionId: sid, modelSelection: session.modelSelection });

    return new Promise((resolve, reject) => {
      let settled = false;
      let cancelRequested = false;
      let handlingTermination = false;
      let cancelGraceTimer = null;
      let promptTimer = null;

      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        if (cancelGraceTimer) clearTimeout(cancelGraceTimer);
        if (promptTimer) clearTimeout(promptTimer);
        signal?.removeEventListener('abort', onCallerAbort);
        proc.activePrompts.delete(sid);
        this._touchIdleTimer(proc);
        if (proc.retireAfterActive && proc.activePrompts.size === 0) {
          void this._retireProcess(proc, 'max_age');
        } else if (proc.state === 'ready' && !proc.closed && !this.closing && proc.activePrompts.size === 0) {
          this._replenishPool(proc);
        }
        if (err) reject(err);
        else resolve(val);
      };

      const killForUnconfirmedStop = (baseCode, baseMessage, isCancelled) => {
        handlingTermination = true;
        if (cancelGraceTimer) clearTimeout(cancelGraceTimer);
        if (promptTimer) clearTimeout(promptTimer);
        void this._terminateProcess(proc, isCancelled ? 'cancel_grace_expired' : 'prompt_timeout').then(outcome => {
          const err = cliError(baseCode, baseMessage, {
            sent: true,
            confirmedNotSent: false,
            confirmedTerminal: outcome.confirmedTerminal === true,
            cliProcessId: outcome.cliProcessId,
            ...(isCancelled ? { cancelled: true, stopConfirmed: outcome.confirmedTerminal === true } : {}),
            ...(!outcome.confirmedTerminal ? {
              cliConfigDirectory: outcome.cliConfigDirectory,
              cliDataDirectory: outcome.cliDataDirectory,
            } : {}),
          });
          finish(err);
        });
      };

      const triggerCancelOrTimeout = (isCancelled, baseCode, baseMessage, graceWindowMs) => {
        if (settled || cancelRequested) return;
        cancelRequested = true;
        const sentCancel = this._sendNotification(proc, 'session/cancel', { sessionId: sid });
        if (!sentCancel) {
          killForUnconfirmedStop(baseCode, baseMessage, isCancelled);
          return;
        }
        cancelGraceTimer = setTimeout(() => {
          killForUnconfirmedStop(baseCode, baseMessage, isCancelled);
        }, Math.max(10, graceWindowMs));
        cancelGraceTimer.unref?.();
      };

      const onCallerAbort = () => {
        triggerCancelOrTimeout(true, 'CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled', this.cancelGraceMs);
      };
      active.abortWithError = err => {
        handlingTermination = true;
        void this._terminateProcess(proc, err.code || 'output_limit').then(outcome => {
          Object.assign(err, {
            sent: true,
            confirmedNotSent: false,
            confirmedTerminal: outcome.confirmedTerminal === true,
            cliProcessId: outcome.cliProcessId,
            ...(!outcome.confirmedTerminal ? {
              cliConfigDirectory: outcome.cliConfigDirectory,
              cliDataDirectory: outcome.cliDataDirectory,
            } : {}),
          });
          finish(err);
        });
      };

      if (signal?.aborted) {
        onCallerAbort();
        return;
      }
      signal?.addEventListener('abort', onCallerAbort, { once: true });

      promptTimer = setTimeout(() => {
        const graceMs = Math.min(this.cancelGraceMs, Math.max(25, Math.floor(effectiveTimeoutMs / 2)));
        triggerCancelOrTimeout(false, 'CURSOR_CLI_TIMEOUT', 'Cursor CLI request timed out', graceMs);
      }, effectiveTimeoutMs);
      promptTimer.unref?.();

      rpcPromise.then(
        async result => {
          if (settled || handlingTermination) return;
          if (cancelRequested) {
            if (result?.stopReason === 'cancelled') {
              finish(cliError('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled', {
                cancelled: true,
                stopConfirmed: true,
                confirmedTerminal: true,
                sent: true,
                confirmedNotSent: false,
              }));
            } else {
              killForUnconfirmedStop('CURSOR_CLI_CANCELLED', 'Cursor CLI cancel did not return stopReason=cancelled', true);
            }
            return;
          }
          if (result?.stopReason !== 'end_turn') {
            finish(cliError('CURSOR_CLI_PROTOCOL_ERROR', `Cursor CLI ACP stopped with unexpected reason: ${String(result?.stopReason || 'unknown')}`, {
              sent: true,
              confirmedNotSent: false,
              confirmedTerminal: true,
            }));
            return;
          }
          const combined = active.chunks.join('');
          if (!combined.trim()) {
            finish(cliError('CURSOR_CLI_PROTOCOL_ERROR', 'Cursor CLI ACP completed without response text', {
              sent: true,
              confirmedNotSent: false,
              confirmedTerminal: true,
            }));
            return;
          }
          await proc.scope?.verifyProjectSlug?.();
          this.stats.promptsServed += 1;
          finish(null, {
            usedAcp: true,
            result: combined,
            sessionId: sid,
            modelSelection: session.modelSelection,
            mcpIsolation: proc.scope?.mcpIsolation ? { ...proc.scope.mcpIsolation } : null,
            cliTransport: 'acp',
          });
        },
        error => {
          if (settled || handlingTermination) return;
          const postSendError = error instanceof Error ? error : cliError('CURSOR_CLI_ERROR', String(error));
          postSendError.sent = true;
          postSendError.confirmedNotSent = false;
          if (postSendError.confirmedTerminal !== false) {
            // RPC error returned by a still-live process is terminal for that prompt unless process died unexpectedly.
            postSendError.confirmedTerminal = !proc.closed && proc.state !== 'orphaned' && proc.state !== 'failed'
              ? true
              : postSendError.confirmedTerminal === true;
          }
          if (cancelRequested && !postSendError.cancelled) {
            postSendError.cancelled = true;
            postSendError.stopConfirmed = postSendError.confirmedTerminal === true;
          }
          finish(postSendError);
        },
      );
    });
  }

  async runOrFallback({ projectPath, prompt, modelPreference, timeoutMs, signal, onInit, onDispatch, cli, allowColdStart = false } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw cliError('CURSOR_CLI_PROMPT_REQUIRED', 'A nonempty prompt is required', { confirmedNotSent: true, confirmedTerminal: true });
    }
    if (signal?.aborted) {
      throw cliError('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled', {
        cancelled: true, stopConfirmed: true, confirmedTerminal: true, confirmedNotSent: true, sent: false,
      });
    }

    const parsedPreference = parseAcpModelPreference(modelPreference);
    const resolved = await this._resolveEnvironment({ env: this.env, cli, projectPath });
    if (!resolved.eligible) {
      this.stats.fallbacks += 1;
      this.stats.lastFallbackReason = resolved.reason;
      return { usedAcp: false, confirmedNotSent: true, fallbackReason: resolved.reason };
    }

    const key = this._buildProcessKey({
      cwd: resolved.workspace.cwd,
      parsedPreference,
      identityKey: resolved.identityKey,
    });
    let proc = this.processes.get(key);
    if (proc && this.maxAgeMs > 0 && (this.now() - proc.createdAtMs) >= this.maxAgeMs && proc.activePrompts.size === 0) {
      await this._retireProcess(proc, 'max_age');
      proc = null;
    }

    if (!proc || proc.state === 'starting') {
      if (!allowColdStart) {
        const reason = proc?.state === 'starting' ? 'acp_warming' : 'acp_cold_start';
        if (!proc) void this.prewarm({ projectPath, modelPreference, cli, env: resolved.env });
        this.stats.fallbacks += 1;
        this.stats.lastFallbackReason = reason;
        return { usedAcp: false, confirmedNotSent: true, fallbackReason: reason };
      }
      if (!proc) {
        const warm = await this.prewarm({ projectPath, modelPreference, cli, env: resolved.env });
        proc = this.processes.get(key);
        if (!warm.warmed || !proc || proc.state !== 'ready') {
          const reason = warm.reason || 'acp_unavailable';
          this.stats.fallbacks += 1;
          this.stats.lastFallbackReason = reason;
          return { usedAcp: false, confirmedNotSent: true, fallbackReason: reason };
        }
      } else {
        try {
          proc = await proc.startupPromise;
        } catch (error) {
          if (signal?.aborted) throw error;
          const reason = error?.capabilityFailureReason || error?.code || 'acp_startup_failed';
          this.stats.fallbacks += 1;
          this.stats.lastFallbackReason = reason;
          return { usedAcp: false, confirmedNotSent: true, fallbackReason: reason };
        }
      }
    }

    if (!proc || proc.state !== 'ready') {
      const reason = 'acp_not_ready';
      this.stats.fallbacks += 1;
      this.stats.lastFallbackReason = reason;
      return { usedAcp: false, confirmedNotSent: true, fallbackReason: reason };
    }

    if (proc.activePrompts.size > 0 || proc.acquiringSession) {
      const reason = 'acp_busy';
      this.stats.fallbacks += 1;
      this.stats.lastFallbackReason = reason;
      return { usedAcp: false, confirmedNotSent: true, fallbackReason: reason };
    }

    proc.acquiringSession = true;
    let session;
    try {
      session = await this._acquireReadySession(proc);
    } catch (error) {
      proc.acquiringSession = false;
      if (signal?.aborted) {
        throw cliError('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled', {
          cancelled: true, stopConfirmed: true, confirmedTerminal: true, confirmedNotSent: true, sent: false,
        });
      }
      if (error?.capabilityFailureReason) {
        this._recordCapabilityFailure(resolved.identityKey, error.capabilityFailureReason);
        void this._retireProcess(proc, error.capabilityFailureReason);
      } else if (error?.code === 'CURSOR_CLI_EXIT_ERROR' || error?.code === 'CURSOR_CLI_ACP_RPC_ERROR') {
        void this._retireProcess(proc, 'session_setup_failed');
      }
      const reason = error?.capabilityFailureReason || error?.code || 'acp_session_setup_failed';
      this.stats.fallbacks += 1;
      this.stats.lastFallbackReason = reason;
      return { usedAcp: false, confirmedNotSent: true, fallbackReason: reason };
    }

    if (signal?.aborted) {
      proc.acquiringSession = false;
      // Return unused session back to pool if aborted cleanly before sending prompt.
      if (proc.state === 'ready' && proc.readySessions.length < this.poolSize) {
        proc.readySessions.push(session);
      }
      throw cliError('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled', {
        cancelled: true, stopConfirmed: true, confirmedTerminal: true, confirmedNotSent: true, sent: false,
      });
    }

    try {
      return await this._executePromptOnProcess(proc, session, { prompt, timeoutMs, signal, onInit, onDispatch });
    } finally {
      proc.acquiringSession = false;
    }
  }

  async invalidateWorkspace(projectPath, reason = 'workspace_changed') {
    if (!projectPath) return;
    let targetCwd;
    try {
      targetCwd = canonicalPath((await this.resolveWorkspace(projectPath)).cwd);
    } catch {
      targetCwd = canonicalPath(projectPath);
    }
    const pending = [];
    for (const proc of [...this.processes.values()]) {
      if (proc.cwd && canonicalPath(proc.cwd) === targetCwd) {
        pending.push(this._retireProcess(proc, reason));
      }
    }
    await Promise.allSettled(pending);
  }

  async invalidateAll(reason = 'configuration_changed') {
    const pending = [...this.processes.values()].map(proc => this._retireProcess(proc, reason));
    await Promise.allSettled(pending);
  }

  async shutdown() {
    this.closing = true;
    const pending = [...this.processes.values()].map(proc => this._retireProcess(proc, 'shutdown'));
    await Promise.allSettled(pending);
  }

  statusView(env = this.env) {
    const disabledReason = getAcpDisabledReason(env);
    if (disabledReason) {
      return {
        state: 'disabled',
        reason: disabledReason,
        readySessions: 0,
        activePrompts: 0,
        promptsServed: this.stats.promptsServed,
        fallbacks: this.stats.fallbacks,
        warmProcesses: 0,
      };
    }
    let readySessions = 0;
    let activePrompts = 0;
    let warmProcesses = 0;
    let warming = false;
    for (const proc of this.processes.values()) {
      if (proc.state === 'ready') {
        warmProcesses += 1;
        readySessions += proc.readySessions?.length || 0;
        activePrompts += proc.activePrompts?.size || 0;
      } else if (proc.state === 'starting') {
        warming = true;
      }
    }
    let state = 'idle';
    let reason = null;
    if (warmProcesses > 0) state = 'ready';
    else if (warming) state = 'warming';
    else if (this.stats.lastUnavailableReason) {
      // Surface last unavailable capability failure if still within TTL
      const hasValidFailure = [...this.capabilityFailures.keys()].some(key => this._getCapabilityFailure(key));
      if (hasValidFailure) {
        state = 'unavailable';
        reason = this.stats.lastUnavailableReason;
      }
    }
    return {
      state,
      reason,
      readySessions,
      activePrompts,
      promptsServed: this.stats.promptsServed,
      fallbacks: this.stats.fallbacks,
      lastFallbackReason: this.stats.lastFallbackReason,
      warmProcesses,
    };
  }
}
