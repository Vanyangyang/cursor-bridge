import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveCliWorkspace } from './cursor-cli-workspace.mjs';
import { createCliConfigScope } from './cursor-cli-config.mjs';

const VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;
const error = (code, message) => Object.assign(new Error(message), { code });
const clean = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u200b-\u200d\ufeff]/g, '');
const displayText = value => clean(value).toLowerCase().replace(/\b\d+(?:\.\d+)?\s*[km](?:\s*(?:tokens?|context))?\b/g, '').trim();
const display = value => displayText(value).replace(/extra[\s_-]*high/g, 'xhigh').replace(/[^a-z0-9.]+/g, '');
const effortName = value => String(value || '').trim().toLowerCase().replace(/extra[\s_-]*high/g, 'xhigh');
const advertisedEffort = value => effortName(/(?:^|[\s_-])(extra[\s_-]*high|xhigh|minimal|low|medium|high|max)\s*$/i.exec(displayText(value))?.[1]);
const safeDetail = value => clean(value)
  .replace(/(["']?(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:bearer|basic)\s+\S+|\S+)/gi, '$1[redacted]')
  .replace(/\b(?:bearer|basic)\s+\S+/gi, '[redacted]')
  .replace(/\b(?:sk|key|token)-[a-z0-9_-]{12,}/gi, '[redacted]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]').slice(0, 800);
// CLI stderr may contain arbitrary provider payloads or echoed prompts. Expose
// only a diagnostic category; redaction patterns alone cannot cover every secret.
const stderrSummary = value => {
  const text = clean(value);
  const network = /\b(ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b/.exec(text);
  if (network) return network[1];
  if (/not authenticated|authentication|unauthorized|sign.?in|log.?in|api.?key/i.test(text)) return 'authentication failed; check Cursor CLI login';
  if (/workspace.*trust|untrusted/i.test(text)) return 'workspace trust was not confirmed';
  return text.trim() ? 'CLI reported an error on stderr (content withheld)' : '';
};
const exists = async file => { try { await access(file); return true; } catch { return false; } };

async function resolveLauncher(options) {
  if (options.launcher) return options.launcher;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const explicit = env.CURSOR_BRIDGE_CLI_PATH;
  if (explicit && !path.isAbsolute(explicit)) throw error('CURSOR_CLI_LAUNCHER_UNSUPPORTED', 'CURSOR_BRIDGE_CLI_PATH must be absolute');
  const candidates = explicit ? [explicit] : [];
  if (!explicit && platform === 'win32' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'cursor-agent', 'cursor-agent.ps1'));
  if (!explicit) for (const directory of (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const name of platform === 'win32' ? ['cursor-agent.ps1', 'cursor-agent.cmd', 'cursor-agent.exe'] : ['cursor-agent', 'agent']) candidates.push(path.join(directory, name));
  }
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    const absolute = await realpath(candidate);
    if (platform !== 'win32' || /\.exe$/i.test(absolute)) return { command: absolute, args: [], wrapper: absolute };
    if (!/\.(?:ps1|cmd)$/i.test(absolute)) throw error('CURSOR_CLI_LAUNCHER_UNSUPPORTED', 'Unsupported Windows Cursor launcher');
    const content = await readFile(absolute, 'utf8');
    if (!/node\.exe/i.test(content) || !/index\.js/i.test(content)) throw error('CURSOR_CLI_LAUNCHER_UNSUPPORTED', 'Cursor wrapper does not expose the supported Node layout');
    const directory = path.dirname(absolute);
    const roots = [directory];
    try {
      const entries = (await readdir(path.join(directory, 'versions'), { withFileTypes: true })).filter(entry => entry.isDirectory() && VERSION.test(entry.name));
      entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      roots.push(...entries.map(entry => path.join(directory, 'versions', entry.name)));
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    for (const root of roots) if (await exists(path.join(root, 'node.exe')) && await exists(path.join(root, 'index.js'))) {
      return { command: await realpath(path.join(root, 'node.exe')), args: [await realpath(path.join(root, 'index.js'))], wrapper: absolute };
    }
    throw error('CURSOR_CLI_LAUNCHER_UNSUPPORTED', 'Cursor wrapper has no supported installed Node entrypoint');
  }
  throw error('CURSOR_CLI_UNAVAILABLE', 'Cursor CLI launcher was not found');
}

async function stopTree(child, options) {
  if (!child.pid) return true;
  if (child.exitCode != null || child.signalCode != null) return false;
  if (options.killTree) return options.killTree(child);
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise((resolve, reject) => execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (cause) => cause ? reject(cause) : resolve()));
    return true;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
  return true;
}

// Resolve only after close; failed cleanup is reported as uncertain, never terminal.
async function execute(launcher, args, options = {}) {
  const spawn = options.spawn || nodeSpawn;
  const env = { ...(options.env || process.env), CURSOR_BRIDGE_CCE_CLI_CHILD: '1',
    CURSOR_BRIDGE_NO_AUTOLAUNCH: '1', CURSOR_BRIDGE_DELEGATION: 'off' };
  if (options.signal?.aborted) throw Object.assign(error('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled'), { cancelled: true, stopConfirmed: true, confirmedTerminal: true, confirmedNotSent: true, sent: false });
  return new Promise((resolve, reject) => {
    let child, stdout = '', stderr = '', pending = '', bytes = 0, failure, closed = false, dispatched = false, stopPromise;
    let closeTimer;
    const timeoutMs = Math.max(1, options.timeoutMs ?? 15000);
    const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    const finishError = (cause, terminal) => {
      if (child?.pid) cause.cliProcessId = child.pid;
      cause.sent = dispatched;
      cause.confirmedNotSent = !dispatched;
      cause.confirmedTerminal = terminal;
      if (!terminal && dispatched) cause.sent = true;
      if (cause.cancelled) cause.stopConfirmed = terminal;
      reject(cause);
    };
    const fail = cause => {
      if (failure) return;
      failure = cause;
      stopPromise = Promise.resolve().then(() => stopTree(child, options)).then(value => value !== false, () => false);
      closeTimer = setTimeout(async () => { cleanup(); finishError(failure, false); }, options.closeTimeoutMs ?? 6000);
    };
    const abort = () => fail(Object.assign(error('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled'), { cancelled: true }));
    const cleanup = () => { clearTimeout(timer); clearTimeout(closeTimer); options.signal?.removeEventListener('abort', abort); };
    let timer;
    try {
      child = spawn(launcher.command, [...(launcher.args || []), ...args], {
        cwd: options.cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) { finishError(cause, true); return; }
    timer = setTimeout(() => fail(error('CURSOR_CLI_TIMEOUT', 'Cursor CLI request timed out')), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return fail(error('CURSOR_CLI_OUTPUT_LIMIT', 'Cursor CLI output exceeded the limit'));
      if (!options.onLine) { stdout += chunk; return; }
      pending += chunk;
      let boundary;
      while ((boundary = pending.indexOf('\n')) >= 0 && !failure) {
        const line = pending.slice(0, boundary).replace(/\r$/, ''); pending = pending.slice(boundary + 1);
        if (!line.trim()) continue;
        try { options.onLine(line); } catch (cause) { fail(cause); }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.stdin.on('error', cause => { if (!closed) fail(cause); });
    child.on('error', cause => { failure ||= cause; });
    child.on('close', async (code, signal) => {
      if (closed) return;
      closed = true; cleanup();
      const stopped = stopPromise ? await stopPromise : true;
      if (failure) return finishError(failure, stopped);
      let completionError;
      const detail = stderrSummary(stderr);
      if (code !== 0) completionError = Object.assign(error('CURSOR_CLI_EXIT_ERROR', `Cursor CLI exited unsuccessfully${detail ? ': ' + detail : ''}`), { exitCode: code, signal });
      else if (options.onLine && pending.trim()) completionError = error('CURSOR_CLI_PROTOCOL_ERROR', 'Cursor CLI stream ended without a newline');
      else try { options.onEnd?.(); } catch (cause) { completionError = cause; }
      if (completionError) {
        // The parent has already exited. Its close event cannot prove that a
        // detached descendant stopped. Do not target an exited PID that could
        // be reused; retain the reservation instead of automatically resubmitting.
        return finishError(completionError, !dispatched);
      }
      resolve({ stdout, stderr: safeDetail(stderr), code });
    });
    child.once('spawn', () => {
      if (failure) return;
      try {
        if (options.input !== undefined) {
          options.onDispatch?.();
          if (failure || options.signal?.aborted) return;
          dispatched = true; child.stdin.end(options.input, 'utf8');
        }
        else child.stdin.end();
      } catch (cause) { fail(cause); }
    });
    if (options.signal?.aborted) abort();
  });
}

async function withCliConfig(options, action) {
  const config = await createCliConfigScope(options.env || process.env);
  let retain = false;
  try { return await action(config.env); }
  catch (cause) {
    if (cause.confirmedTerminal === false) { retain = true; cause.cliConfigDirectory = config.directory; }
    throw cause;
  } finally {
    if (!retain) await config.cleanup().catch(error => console.error(`[cursor-bridge] CLI configuration-copy cleanup failed: ${error.code || 'unknown'}`));
  }
}

export async function inspectCursorCli(options = {}) {
  const launcher = await resolveLauncher(options);
  if (!launcher?.command || !path.isAbsolute(launcher.command) || !Array.isArray(launcher.args || [])) throw error('CURSOR_CLI_LAUNCHER_UNSUPPORTED', 'Cursor launcher must use an absolute executable and argument array');
  return withCliConfig(options, async env => {
  const metadataOptions = { ...options, env, input: undefined, onLine: undefined, onDispatch: undefined, timeoutMs: options.timeoutMs ?? 15000, maxOutputBytes: 1024 * 1024 };
  const help = await execute(launcher, ['--help'], metadataOptions);
  if (!/\bStart the Cursor Agent\b/i.test(clean(help.stdout)) || !/--workspace\b/.test(help.stdout) || !/stream-json/.test(help.stdout)) throw error('CURSOR_CLI_WRONG_BRAND', 'Launcher is not a supported Cursor CLI');
  const listing = await execute(launcher, ['models'], metadataOptions);
  const models = [];
  for (const line of clean(listing.stdout).split(/\r?\n/)) {
    const match = /^\s*([a-z0-9][a-z0-9._[\]=,:+-]*)\s+-\s+(.+?)\s*$/i.exec(line);
    if (match) models.push({ id: match[1], name: match[2].replace(/\s+\((?:current|default|current, default|default, current)\)$/, '') });
  }
  if (!models.length) throw error('CURSOR_CLI_MODELS_UNAVAILABLE', 'Cursor CLI did not advertise usable model variants');
  return { brand: 'Cursor', launcher, models };
  });
}

function selectVariant(cli, preference) {
  const base = String(preference?.model || '').trim();
  const effort = effortName(preference?.effort);
  if (!base || /^(?:auto|default)$/i.test(base) || !effort || !/^(?:minimal|low|medium|high|xhigh|max)$/.test(effort)) throw error('CURSOR_CLI_MODEL_REQUIRED', 'An explicit named model and effort are required');
  const ids = new Set([`${base}-${effort}`.toLowerCase(), ...(effort === 'xhigh' ? [`${base}-extra-high`.toLowerCase()] : [])]);
  const candidates = cli.models.filter(model => ids.has(model.id.toLowerCase()) || model.id.toLowerCase() === base.toLowerCase() && advertisedEffort(model.name) === effort);
  if (candidates.length !== 1) throw error('CURSOR_CLI_MODEL_UNAVAILABLE', 'The exact requested CLI model and effort variant is unavailable or ambiguous');
  const selected = candidates[0];
  if (advertisedEffort(selected.name) !== effort) throw error('CURSOR_CLI_MODEL_UNAVAILABLE', 'The advertised model does not confirm the requested effort');
  const identity = value => displayText(value)
    .replace(/(?:[\s_-]+)(?:extra[\s_-]*high|xhigh|minimal|low|medium|high|max)\s*$/i, '')
    .replace(/(\d)[_-](?=\d)/g, '$1.').replace(/[^a-z0-9.]+/g, '');
  if (identity(selected.name) !== identity(base)) throw error('CURSOR_CLI_MODEL_UNAVAILABLE', 'The advertised model name conflicts with the requested model identity');
  return { selected, base, effort };
}

export async function runCursorCli({ projectPath, prompt, modelPreference, timeoutMs, signal, onInit, onDispatch, cli }, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw error('CURSOR_CLI_PROMPT_REQUIRED', 'A nonempty prompt is required');
  if (signal?.aborted) throw Object.assign(error('CURSOR_CLI_CANCELLED', 'Cursor CLI request cancelled'), { cancelled: true, stopConfirmed: true, confirmedTerminal: true, confirmedNotSent: true, sent: false });
  const workspace = await resolveCliWorkspace(projectPath);
  const cwd = workspace.cwd;
  cli ||= await inspectCursorCli({ ...options, signal });
  if (cli.brand !== 'Cursor' || !cli.launcher?.command || !Array.isArray(cli.models)) throw error('CURSOR_CLI_UNVERIFIED', 'A verified Cursor CLI inspection is required');
  const { selected, base, effort } = selectVariant(cli, modelPreference);
  let init, terminal, modelSelection;
  const canonical = value => {
    const normalized = path.normalize(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const protocolError = message => error('CURSOR_CLI_PROTOCOL_ERROR', message);
  return withCliConfig(options, async env => {
    await execute(cli.launcher, ['--mode', 'ask', '--print', '--output-format', 'stream-json', '--model', selected.id, '--workspace', cwd,
    ...workspace.additionalRoots.flatMap(root => ['--add-dir', root]), '--trust'], {
    ...options, env, cwd, input: prompt, timeoutMs: timeoutMs ?? 120000, signal, onDispatch,
    onEnd() {
      if (!init || !terminal) throw protocolError('Cursor CLI closed without a confirmed init and terminal result');
    },
    onLine(line) {
      let event;
      try { event = JSON.parse(line); } catch { throw protocolError('Cursor CLI emitted invalid JSON'); }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw protocolError('Cursor CLI emitted an invalid event');
      if (terminal) throw protocolError('Cursor CLI emitted an event after its terminal result');
      if (event.type === 'system' && event.subtype === 'init') {
        if (init || typeof event.session_id !== 'string' || !event.session_id) throw protocolError('Cursor CLI init is missing identity or duplicated');
        if (typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd) || canonical(event.cwd) !== canonical(cwd)) throw protocolError('Cursor CLI init workspace does not match the request');
        if (display(event.model) !== display(selected.name)) throw error('CURSOR_CLI_MODEL_MISMATCH', 'Cursor CLI initialized a different model or effort');
        init = event;
        modelSelection = { configured: true, applied: true, requestedModel: base, requestedEffort: modelPreference.effort, effectiveModel: base, effectiveEffort: effort,
          verificationSource: 'cursor_cli_init', cliModel: selected.id, verifiedAt: new Date().toISOString() };
        onInit?.({ sessionId: init.session_id, modelSelection });
        return;
      }
      if (!init || event.session_id !== init.session_id) throw protocolError('Cursor CLI event session identity is missing or inconsistent');
      if (event.type === 'result') {
        if (event.subtype !== 'success' || event.is_error !== false || typeof event.result !== 'string' || !event.result.trim()) throw protocolError('Cursor CLI terminal result did not confirm success');
        terminal = event;
      }
    },
  });
    return { result: terminal.result, sessionId: init.session_id, modelSelection };
  });
}
