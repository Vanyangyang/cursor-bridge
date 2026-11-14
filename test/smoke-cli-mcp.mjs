#!/usr/bin/env node
// End-to-end stdio MCP smoke check for the CLI-first CCE path (with an isolated fake Cursor CLI harness).
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function payload(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'MCP result must contain JSON text');
  return JSON.parse(text);
}

function linkOrCopyNode(targetPath) {
  try {
    linkSync(process.execPath, targetPath);
  } catch {
    copyFileSync(process.execPath, targetPath);
  }
}

function fakeCliScriptSource() {
  return `import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage: cursor-agent [options]\\n  Start the Cursor Agent\\n  --workspace <path>\\n  --output-format <fmt>  stream-json\\n');
  process.exit(0);
}
if (args[0] === 'models') {
  process.stdout.write('grok-4.6-medium-fast - Grok 4.6 Medium Fast (default)\\ngpt-5-high - GPT-5 High\\n');
  process.exit(0);
}
if (args.includes('--print')) {
  let stdinText = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdinText += chunk;
  if (!stdinText.trim()) {
    process.stderr.write('empty prompt\\n');
    process.exit(2);
  }
  const wsIdx = args.indexOf('--workspace');
  const ws = wsIdx >= 0 ? args[wsIdx + 1] : process.cwd();
  const mIdx = args.indexOf('--model');
  const mid = mIdx >= 0 ? args[mIdx + 1] : 'grok-4.6-medium-fast';
  const modelName = mid === 'gpt-5-high' ? 'GPT-5 High' : 'Grok 4.6 Medium Fast';
  const resultText = [
    'CCE_SEARCH_RESULT',
    'intent: cli print fallback smoke query',
    'coverage: focused | source',
    'evidence:',
    '- server.mjs:1 | CursorBridge | Fake print fallback smoke answer | source-read',
    'gaps: none',
    'confidence: high',
  ].join('\\n');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'smoke-print-sess-1', cwd: ws, model: modelName }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'smoke-print-sess-1', result: resultText }) + '\\n');
  process.exit(0);
}
if (args.includes('acp')) {
  let seq = 0;
  let model = 'auto';
  const sessions = new Map();
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
  const buildConfig = (sid) => {
    const s = sessions.get(sid);
    return [
      { id: 'mode', currentValue: s.mode, options: [{ value: 'agent' }, { value: 'plan' }, { value: 'ask' }] },
      { id: 'model', currentValue: model, options: [{ value: 'auto', name: 'Auto' }, { value: 'grok-4.6', name: 'Grok 4.6' }, { value: 'gpt-5', name: 'GPT-5' }] },
      { id: 'effort', currentValue: s.effort, options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
      { id: 'fast', currentValue: s.fast, options: [{ value: 'false' }, { value: 'true' }] },
    ];
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, capabilities: { _meta: { parameterizedModelPicker: true } } } });
      return;
    }
    if (msg.method === 'session/new') {
      const sid = 'smoke-acp-sess-' + (++seq);
      sessions.set(sid, { mode: 'agent', effort: 'low', fast: 'false' });
      emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid, configOptions: buildConfig(sid) } });
      return;
    }
    if (msg.method === 'session/set_config_option') {
      const { sessionId, configId, value } = msg.params;
      const s = sessions.get(sessionId);
      if (configId === 'model') model = value;
      else if (configId === 'mode') s.mode = value;
      else if (configId === 'effort' || configId === 'reasoning_effort') s.effort = value;
      else if (configId === 'fast') s.fast = value;
      emit({ jsonrpc: '2.0', id: msg.id, result: { configOptions: buildConfig(sessionId) } });
      return;
    }
    if (msg.method === 'session/prompt') {
      const sid = msg.params.sessionId;
      const answer = [
        'CCE_SEARCH_RESULT',
        'intent: cli smoke query',
        'coverage: focused | source',
        'evidence:',
        '- server.mjs:1 | CursorBridge | Fake ACP smoke answer | source-read',
        'gaps: none',
        'confidence: high',
      ].join('\\n');
      emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { text: answer } } } });
      emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
  });
  rl.on('close', () => process.exit(0));
} else {
  process.stderr.write('unsupported smoke invocation\\n');
  process.exit(2);
}
`;
}

async function smokeCli() {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 2, 'Usage: node test/smoke-cli-mcp.mjs [bundle-path] [expected-version]');
  const bundle = resolve(args[0] || 'dist/cursor-bridge.mjs');
  assert.ok(existsSync(bundle), `Bundle does not exist: ${bundle}`);
  const expectedVersion = args[1] || JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

  const scratch = mkdtempSync(join(tmpdir(), 'cursor-bridge-cli-smoke-'));
  const adapterCwd = join(scratch, '.claude', 'plugins', 'cache', 'cursor-bridge');
  const project = join(scratch, 'project');
  const cliRoot = join(scratch, 'fake-cli');
  const cursorConfigDir = join(scratch, 'cursor-config');
  const isolatedPort = createServer((socket) => socket.destroy());
  let client;

  try {
    mkdirSync(adapterCwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(cursorConfigDir, { recursive: true });
    writeFileSync(join(cursorConfigDir, 'cli-config.json'), JSON.stringify({ model: { modelId: 'auto' } }) + '\n');

    let cliPath;
    if (process.platform === 'win32') {
      const versionDir = join(cliRoot, 'versions', '2026.11.15-abcdef0');
      mkdirSync(versionDir, { recursive: true });
      cliPath = join(cliRoot, 'cursor-agent.ps1');
      writeFileSync(cliPath, '# node.exe index.js\n');
      writeFileSync(join(versionDir, 'index.js'), fakeCliScriptSource());
      writeFileSync(join(versionDir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
      linkOrCopyNode(join(versionDir, 'node.exe'));
    } else {
      mkdirSync(cliRoot, { recursive: true });
      cliPath = join(cliRoot, 'cursor-agent');
      writeFileSync(cliPath, `#!/usr/bin/env node\n${fakeCliScriptSource()}`);
      chmodSync(cliPath, 0o755);
      writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    }

    await new Promise((accept, reject) => {
      isolatedPort.once('error', reject);
      isolatedPort.listen(0, '127.0.0.1', accept);
    });

    const hostIdentity = new Set([
      'CODEX_THREAD_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_PROJECT_DIR',
      'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CURSOR_PROJECT_PATH', 'CURSOR_EXE',
    ]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
      typeof value === 'string' && !name.toUpperCase().startsWith('CURSOR_BRIDGE_')
      && !hostIdentity.has(name.toUpperCase())));
    Object.assign(env, {
      PATH: process.platform === 'win32'
        ? `${dirname(process.execPath)};${cliRoot}`
        : `${dirname(process.execPath)}:${cliRoot}:${env.PATH || ''}`,
      CURSOR_BRIDGE_WORKSPACE_FILE: join(scratch, 'workspaces.json'),
      CURSOR_BRIDGE_RUNTIME_FILE: join(scratch, 'runtime.json'),
      CURSOR_BRIDGE_MODEL_PREFERENCES_FILE: join(scratch, 'models.json'),
      CURSOR_BRIDGE_SESSION_FILE: join(scratch, 'sessions.json'),
      CURSOR_BRIDGE_CCE_SOURCE_FILE: join(scratch, 'cce-source.json'),
      CURSOR_BRIDGE_WINDOW_STATE_FILE: join(scratch, 'windows.json'),
      CURSOR_BRIDGE_LIFECYCLE_DIR: join(scratch, 'lifecycle'),
      CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
      CURSOR_BRIDGE_CDP_PORT: String(isolatedPort.address().port),
      CURSOR_BRIDGE_CLI_PATH: cliPath,
      CURSOR_CONFIG_DIR: cursorConfigDir,
      CURSOR_BRIDGE_HOST_ID: 'cli-smoke-host',
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: adapterCwd,
      env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    client = new Client({ name: 'cursor-bridge-cli-smoke', version: '1.0.0' });
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, expectedVersion);

    const call = (name, arguments_ = {}) => client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 20000 });

    // 1. Default CCE source is CLI on a fresh install.
    const statusBefore = payload(await call('cursor_status', { detail: 'full' }));
    assert.equal(statusBefore.pluginVersion, expectedVersion);
    assert.equal(statusBefore.cceSource, 'cli');

    // 2. Doctor before model configuration reports recoverable cli-model-required + sample models.
    const doctorBefore = payload(await call('cursor_cce', { action: 'doctor' }));
    assert.equal(doctorBefore.action, 'doctor');
    assert.equal(doctorBefore.cceSource, 'cli');
    assert.equal(doctorBefore.ready, false);
    assert.equal(doctorBefore.status, 'cli-model-required');
    assert.equal(doctorBefore.errorCode, 'CURSOR_CLI_MODEL_REQUIRED');
    assert.ok(Array.isArray(doctorBefore.availableModelsSample) && doctorBefore.availableModelsSample.length > 0);

    // 3. cursor_init before setting cursor_model persists workspace and returns recoverable status (never throws raw MCP error).
    const initMissingModelRes = await call('cursor_init', { path: project });
    assert.notEqual(initMissingModelRes.isError, true);
    const initMissingModel = payload(initMissingModelRes);
    assert.equal(initMissingModel.bindingPersisted, true);
    assert.equal(initMissingModel.ready, false);
    assert.equal(initMissingModel.status, 'cli-model-required');
    assert.equal(initMissingModel.errorCode, 'CURSOR_CLI_MODEL_REQUIRED');

    // 4. Configure CCE model explicitly, then verify doctor + cursor_init report ready.
    const setModel = payload(await call('cursor_model', {
      action: 'set',
      target: 'cce',
      model: 'grok-4.6-fast',
      effort: 'medium',
    }));
    assert.equal(setModel.modelPreferences.cce.model, 'grok-4.6-fast');
    assert.equal(setModel.modelPreferences.cce.effort, 'medium');

    const doctorAfter = payload(await call('cursor_cce', { action: 'doctor' }));
    assert.equal(doctorAfter.ok, true);
    assert.equal(doctorAfter.ready, true);
    assert.equal(doctorAfter.status, 'ready');
    assert.equal(doctorAfter.modelSelection?.cliModel, 'grok-4.6-medium-fast');

    const initReady = payload(await call('cursor_init', { path: project }));
    assert.equal(initReady.ready, true);
    assert.equal(initReady.status, 'ready');
    assert.equal(initReady.cceSource, 'cli');

    // Wait for non-blocking ACP prewarm before verifying the warmed ACP path.
    let acpReady = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const acpStatus = payload(await call('cursor_status', { detail: 'full' }));
      if (acpStatus.cli?.acp?.state === 'ready' && acpStatus.cli?.acp?.readySessions >= 1) {
        acpReady = true;
        break;
      }
      await new Promise((accept) => setTimeout(accept, 50));
    }
    assert.ok(acpReady, 'ACP prewarm must become ready after cursor_init');

    // 5. Execute a real CCE query over stdio MCP -> fake CLI ACP -> normalized CCE_SEARCH_RESULT.
    const queryRes = await call('cursor_context_engine', {
      query: 'Find CursorBridge entry point for CLI smoke',
      workspace_path: project,
    });
    assert.notEqual(queryRes.isError, true, 'cursor_context_engine CLI query must succeed');
    const text = queryRes.content?.find((item) => item.type === 'text')?.text || '';
    assert.match(text, /^CCE_SEARCH_RESULT/);
    assert.match(text, /Fake ACP smoke answer/);
    const statusAfterAcp = payload(await call('cursor_status', { detail: 'full' }));
    assert.ok(statusAfterAcp.cli?.acp?.promptsServed >= 1, 'warm ACP path must serve the query');

    // 6. Switch model without cursor_init so cold-start immediately exercises the --print fallback path.
    const setPrintModel = payload(await call('cursor_model', {
      action: 'set',
      target: 'cce',
      model: 'gpt-5',
      effort: 'high',
    }));
    assert.equal(setPrintModel.modelPreferences.cce.model, 'gpt-5');
    assert.equal(setPrintModel.modelPreferences.cce.effort, 'high');

    const fallbackRes = await call('cursor_context_engine', {
      query: 'Find CursorBridge print fallback smoke path',
      workspace_path: project,
    });
    assert.notEqual(fallbackRes.isError, true, 'cursor_context_engine --print fallback query must succeed');
    const fallbackText = fallbackRes.content?.find((item) => item.type === 'text')?.text || '';
    assert.match(fallbackText, /^CCE_SEARCH_RESULT/);
    assert.match(fallbackText, /Fake print fallback smoke answer/);
    const statusAfterFallback = payload(await call('cursor_status', { detail: 'full' }));
    assert.ok(statusAfterFallback.cli?.acp?.fallbacks >= 1, 'cold-start model switch must record ACP fallback');

    return {
      result: 'PASS',
      bundle,
      version: expectedVersion,
      defaultCceSource: 'cli',
      recoverableMissingModelVerified: true,
      doctorVerified: true,
      acpQueryVerified: true,
      printFallbackVerified: true,
    };
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        if (isolatedPort.listening) {
          await new Promise((accept, reject) => isolatedPort.close((error) => (error ? reject(error) : accept())));
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 15, retryDelay: 120 });
      }
    }
  }
}

try {
  process.stdout.write(`${JSON.stringify(await smokeCli())}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ result: 'FAIL', error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
