import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { createCliConfigScope } from './cursor-cli-config.mjs';
import { localProviderSummary, normalizeCliProvider } from './cursor-cli-provider-config.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const preferenceFor = value => {
  const model = typeof value?.model === 'string' ? value.model.trim() : '';
  const effort = typeof value?.effort === 'string' ? value.effort.trim().toLowerCase() : '';
  if (!model || /^(auto|default)$/i.test(model) || /[\r\n\0]/.test(model) || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw failure('CURSOR_CLI_MODEL_REQUIRED', 'A named model and explicit effort are required for the local provider');
  }
  return { model, effort };
};
const canonical = value => {
  const result = normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? result.toLowerCase() : result;
};
const readAudit = async file => {
  try {
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('limit');
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { throw failure('CURSOR_CLI_PROVIDER_UNVERIFIED', 'Local provider verification evidence is missing or invalid'); }
};

async function withProviderScope(provider, preference, options, allowInference, action) {
  const scope = await createCliConfigScope(options.env || process.env);
  let retain = false;
  try {
    const file = join(scope.directory, 'cli-config.json');
    const settings = JSON.parse(await readFile(file, 'utf8'));
    const parameters = [{ id: 'reasoning', value: preference.effort }];
    settings.model = { modelId: preference.model, displayModelId: preference.model, displayName: preference.model, displayNameShort: preference.model, aliases: [], maxMode: false };
    settings.selectedModel = { modelId: preference.model, parameters };
    settings.modelParameters = { ...settings.modelParameters, [preference.model]: parameters };
    // Authless owns its provider credential; no account cache is needed.
    delete settings.authInfo;
    await writeFile(file, JSON.stringify(settings), { mode: 0o600 });
    const auditFile = join(scope.directory, 'provider-audit.jsonl');
    const configFile = join(scope.directory, 'provider.json');
    await writeFile(auditFile, '', { flag: 'wx', mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ provider, ...preference, allowInference, auditFile,
      requestTimeoutMs: Math.max(1000, Math.min(options.timeoutMs ?? 120000, 300000)) }), { flag: 'wx', mode: 0o600 });
    const env = { ...scope.env };
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'OPENAI_API_KEY', 'CURSOR_API_KEY', 'CURSOR_API_ENDPOINT', 'CURSOR_LOCAL_AGENT_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[key];
    Object.assign(env, { CURSOR_BRIDGE_CLI_PROVIDER_CONFIG: configFile, CURSOR_LOCAL_AGENT_API_KEY: 'cursor-bridge-local-provider',
      NO_OPEN_BROWSER: '1', NODE_DISABLE_COMPILE_CACHE: '1', AGENT_CLI_CREDENTIAL_STORE: 'file' });
    if (env.NODE_USE_ENV_PROXY === undefined && (env.HTTPS_PROXY || env.HTTP_PROXY)) env.NODE_USE_ENV_PROXY = '1';
    return await action({ env, auditFile });
  } catch (error) {
    if (error.confirmedTerminal === false) { retain = true; error.cliConfigDirectory = scope.directory; }
    throw error;
  } finally {
    if (!retain) await scope.cleanup().catch(() => console.error('[cursor-bridge] Local provider profile cleanup deferred'));
  }
}

export async function inspectLocalCliProvider(options, execute) {
  const provider = normalizeCliProvider(options.provider);
  const preference = preferenceFor(options.modelPreference);
  let launcher;
  try { launcher = { command: await realpath(provider.nodePath), args: [await realpath(provider.entrypoint)] }; }
  catch { throw failure('CURSOR_CLI_PROVIDER_UNAVAILABLE', 'The configured agent-local Node runtime or entrypoint is unavailable'); }
  return withProviderScope(provider, preference, options, false, async ({ env, auditFile }) => {
    const metadata = { ...options, env, input: undefined, onLine: undefined, onDispatch: undefined, timeoutMs: options.timeoutMs ?? 30000 };
    const help = await execute(launcher, ['--help'], metadata);
    if (!/Usage:\s*agent-local\b/.test(help.stdout) || !/Start the Cursor Agent/.test(help.stdout) || !/stream-json/.test(help.stdout)) {
      throw failure('CURSOR_CLI_WRONG_BRAND', 'The local provider requires the official agent-local CLI build');
    }
    const adapted = { command: launcher.command, args: ['--import', new URL('./cursor-cli-provider-preload.mjs', import.meta.url).href, ...launcher.args] };
    await execute(adapted, ['--authless', '--base-url', provider.baseUrl, '--disable-auto-update', 'models'], metadata);
    const events = await readAudit(auditFile);
    if (events.some(event => event.stage === 'provider_error') || !events.some(event => event.stage === 'catalogue_verified' && event.model === preference.model)) {
      throw failure('CURSOR_CLI_PROVIDER_UNVERIFIED', 'The provider did not confirm the exact configured model');
    }
    return { brand: 'Cursor', launcher, provider, preference, models: [{ id: preference.model, name: preference.model }],
      providerVerification: { ...localProviderSummary(provider), catalogueVerified: true } };
  });
}

export async function runLocalCliProvider({ workspace, prompt, modelPreference, timeoutMs, signal, onInit, onDispatch, cli }, options, execute) {
  const preference = preferenceFor(modelPreference);
  const provider = normalizeCliProvider(cli.provider);
  if (preference.model !== cli.preference?.model || preference.effort !== cli.preference?.effort || !cli.providerVerification?.catalogueVerified) {
    throw failure('CURSOR_CLI_PROVIDER_UNVERIFIED', 'Provider inspection does not match the frozen model and effort');
  }
  let init, terminal;
  let finalText = '';
  const selection = { configured: true, applied: true, requestedModel: preference.model, requestedEffort: preference.effort,
    effectiveModel: preference.model, effectiveEffort: preference.effort, cliModel: preference.model,
    verificationSource: 'cursor_cli_provider_guard', providerResponseConfirmed: false, provider: localProviderSummary(provider) };
  return withProviderScope(provider, preference, { ...options, timeoutMs }, true, async ({ env, auditFile }) => {
    const launcher = { command: cli.launcher.command, args: ['--import', new URL('./cursor-cli-provider-preload.mjs', import.meta.url).href, ...cli.launcher.args] };
    await execute(launcher, ['--authless', '--base-url', provider.baseUrl, '--disable-auto-update', '--mode', 'ask', '--print', '--output-format', 'stream-json',
      '--workspace', workspace.cwd, ...workspace.additionalRoots.flatMap(root => ['--add-dir', root]), '--trust'], {
      ...options, env, cwd: workspace.cwd, input: prompt, signal, timeoutMs: timeoutMs ?? 300000, onDispatch,
      onEnd() { if (!init || !terminal) throw failure('CURSOR_CLI_PROTOCOL_ERROR', 'agent-local closed without a complete successful turn'); },
      onLine(line) {
        let event;
        try { event = JSON.parse(line); } catch { throw failure('CURSOR_CLI_PROTOCOL_ERROR', 'agent-local emitted invalid JSON'); }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || terminal) throw failure('CURSOR_CLI_PROTOCOL_ERROR', 'Invalid or post-terminal agent-local event');
        if (event.type === 'system' && event.subtype === 'init') {
          if (init || typeof event.session_id !== 'string' || !event.session_id || typeof event.cwd !== 'string' || !isAbsolute(event.cwd) || canonical(event.cwd) !== canonical(workspace.cwd)) throw failure('CURSOR_CLI_PROTOCOL_ERROR', 'agent-local init identity or workspace does not match');
          if (event.model !== preference.model) throw failure('CURSOR_CLI_MODEL_MISMATCH', 'agent-local initialized another model');
          init = event;
          onInit?.({ sessionId: init.session_id, modelSelection: selection });
          return;
        }
        if (!init || event.session_id !== undefined && event.session_id !== init.session_id
          || ['user', 'assistant', 'tool_call', 'result'].includes(event.type) && event.session_id !== init.session_id) throw failure('CURSOR_CLI_PROTOCOL_ERROR', 'agent-local session identity is inconsistent');
        if (event.type === 'tool_call') finalText = '';
        if (event.type === 'assistant') {
          const text = event.message?.content?.filter(item => item.type === 'text').map(item => item.text).join('') || '';
          if (text.trim()) finalText = text;
        }
        if (event.type === 'result') {
          if (event.subtype !== 'success' || event.is_error !== false) throw failure('CURSOR_CLI_PROTOCOL_ERROR', 'agent-local did not confirm a successful terminal result');
          terminal = event;
        }
      },
    });
    const events = await readAudit(auditFile);
    const sent = events.filter(event => event.stage === 'before_send');
    const created = events.filter(event => event.stage === 'response.created');
    const completed = events.filter(event => event.stage === 'response.completed');
    if (events.some(event => event.stage === 'provider_error') || !sent.length || sent.length !== created.length || sent.length !== completed.length
      || [...sent, ...created, ...completed].some(event => event.model !== preference.model || event.effort !== preference.effort)) {
      throw Object.assign(failure('CURSOR_CLI_PROVIDER_UNVERIFIED', 'Provider responses did not confirm every model request and effort'), { sent: true, confirmedNotSent: false, confirmedTerminal: true });
    }
    const result = typeof terminal.result === 'string' && terminal.result.trim() ? terminal.result : finalText;
    if (!result.trim()) throw Object.assign(failure('CURSOR_CLI_PROTOCOL_ERROR', 'agent-local returned no complete reply after its tools'), { sent: true, confirmedNotSent: false, confirmedTerminal: true });
    return { result, sessionId: init.session_id, modelSelection: { ...selection, verificationSource: 'cursor_cli_provider_response',
      providerResponseConfirmed: true, providerRequestCount: sent.length, verifiedAt: new Date().toISOString() } };
  });
}
