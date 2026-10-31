import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderFetch } from '../cursor-cli-provider-preload.mjs';
import { normalizeCliProvider } from '../cursor-cli-provider-config.mjs';
import { inspectCursorCli, runCursorCli } from '../cursor-cli.mjs';
import { readCcePreferences, updateCcePreferences } from '../cursor-cce-preferences.mjs';

const preference = { model: 'example-reasoner', effort: 'xhigh' };
const provider = { kind: 'openai-responses', nodePath: process.execPath, entrypoint: fileURLToPath(import.meta.url), baseUrl: 'https://api.example.test/v1', apiKeyFile: resolve('example-key.txt') };
const wireConfig = { provider, ...preference, allowInference: true, requestTimeoutMs: 5000 };
const key = 'FAKE_LOCAL_PROVIDER_CREDENTIAL';
const responseEvent = (type, override = {}) => ({ type, response: { model: preference.model, reasoning: { effort: 'xhigh' }, status: type === 'response.completed' ? 'completed' : 'in_progress', ...override } });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const post = (fetch, body = {}) => fetch(`${provider.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: preference.model, input: 'test', ...body }) });

test('provider preferences persist across source switches; credentials are file references only', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cce-provider-prefs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'source.json');
  updateCcePreferences(file, { action: 'set', source: 'cli', cliProvider: provider });
  updateCcePreferences(file, { action: 'set', source: 'ide' });
  assert.deepEqual(readCcePreferences(file).cliProvider, provider);
  updateCcePreferences(file, { action: 'set', source: 'cli' });
  assert.deepEqual(readCcePreferences(file).cliProvider, provider);
  assert.throws(() => normalizeCliProvider({ ...provider, apiKey: key }), { code: 'CURSOR_CLI_PROVIDER_CONFIG_INVALID' });
  assert.throws(() => normalizeCliProvider({ ...provider, baseUrl: 'http://remote.test/v1' }), { code: 'CURSOR_CLI_PROVIDER_CONFIG_INVALID' });
  assert.throws(() => normalizeCliProvider({ ...provider, baseUrl: 'https://user:pass@example.test/v1' }));
  writeFileSync(file, JSON.stringify({ version: 1, source: 'cli', cliProvider: { ...provider, apiKey: key } }));
  assert.throws(() => updateCcePreferences(file, { action: 'set', source: 'cli' }), { code: 'CURSOR_CLI_PROVIDER_CONFIG_INVALID' });
  updateCcePreferences(file, { action: 'set', source: 'cli', cliProvider: null });
  assert.equal(readCcePreferences(file).cliProvider, undefined);
});

test('wire uses the configured credential only at the exact endpoint and enforces Responses/model/effort', async () => {
  const calls = [], events = [];
  const fetch = createProviderFetch(wireConfig, { key, record: event => events.push(event), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return Response.json({ data: [{ id: 'other-model' }, { id: preference.model }] });
    return sse([responseEvent('response.created'), responseEvent('response.completed')]);
  } });
  const catalogue = await (await fetch(`${provider.baseUrl}/models`)).json();
  assert.deepEqual(catalogue.data.map(model => model.id), [preference.model]);
  assert.deepEqual(catalogue.data[0].api_types, ['responses']);
  await (await post(fetch)).text();
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.model, preference.model);
  assert.equal(body.reasoning.effort, preference.effort);
  assert.equal(body.store, false);
  assert.ok(body.include.includes('reasoning.encrypted_content'));
  assert.equal(calls[1].options.headers.get('authorization'), `Bearer ${key}`);
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(JSON.stringify(events).includes(key), false);
  assert.deepEqual(events.map(event => event.stage), ['catalogue_verified', 'before_send', 'response.created', 'response.completed']);
});

test('unknown models, effort conflicts, alternate hosts, wrong API and metadata inference never reach a provider', async () => {
  for (const invoke of [
    f => post(f, { model: 'other-model' }), f => post(f, { reasoning: { effort: 'low' } }),
    f => f('https://elsewhere.test/v1/responses'), f => f(`${provider.baseUrl}/chat/completions`, { method: 'POST' }),
    f => f(`${provider.baseUrl}/models?token=secret`),
  ]) {
    let calls = 0;
    const f = createProviderFetch(wireConfig, { key, record() {}, fetchImpl: async () => { calls++; assert.fail('unexpected network'); } });
    assert.equal((await invoke(f)).status, 400);
    assert.equal((await post(f)).status, 400); // latched; no automatic retry/fallback
    assert.equal(calls, 0);
  }
  const f = createProviderFetch({ ...wireConfig, allowInference: false }, { key, record() {}, fetchImpl: () => assert.fail('metadata sent inference') });
  assert.equal((await post(f)).status, 400);
});

test('provider response identity, effort, completion and stream format must all verify', async () => {
  const cases = [
    () => sse([responseEvent('response.created', { model: 'other-model' })]),
    () => sse([responseEvent('response.created', { reasoning: { effort: 'low' } })]),
    () => sse([responseEvent('response.created')]),
    () => sse([responseEvent('response.completed')]),
    () => sse([responseEvent('response.created'), responseEvent('response.incomplete')]),
    () => Response.json({ text: 'not streaming' }),
  ];
  for (const make of cases) {
    const events = [];
    const f = createProviderFetch(wireConfig, { key, record: event => events.push(event), fetchImpl: async () => make() });
    const response = await post(f);
    if (response.status === 200) await assert.rejects(response.text());
    else assert.equal(response.status, 400);
    assert.ok(events.some(event => event.stage === 'provider_error'));
    assert.equal((await post(f)).status, 400);
  }
});

test('provider errors suppress arbitrary credential echoes and missing models fail closed', async () => {
  const f = createProviderFetch(wireConfig, { key, record() {}, fetchImpl: async () => Response.json({ error: { message: `bad key ${key}` } }, { status: 401 }) });
  const response = await post(f);
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes(key), false);
  const g = createProviderFetch(wireConfig, { key, record() {}, fetchImpl: async () => Response.json({ data: [] }) });
  assert.equal((await g(`${provider.baseUrl}/models`)).status, 400);
});

function fakeCli(action) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
    const call = { command, args, options, child, input: '' }; calls.push(call);
    child.stdin = new Writable({ write(chunk, _encoding, callback) { call.input += chunk; callback(); }, final(callback) { callback(); action(call); } });
    child.finish = (code = 0) => child.emit('close', code, null);
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  return { spawn, calls, killTree: async child => { setImmediate(() => child.finish(1)); return true; } };
}

test('inspection and execution keep the native harness, private profile and exact provider receipt', async t => {
  const project = dirname(fileURLToPath(import.meta.url));
  const native = mkdtempSync(join(tmpdir(), 'cce-provider-native-'));
  t.after(() => rmSync(native, { recursive: true, force: true }));
  const original = JSON.stringify({ version: 1, editor: { vimMode: false }, model: { modelId: 'default' }, permissions: { deny: [] } });
  writeFileSync(join(native, 'cli-config.json'), original);
  const mock = fakeCli(call => {
    const config = JSON.parse(readFileSync(call.options.env.CURSOR_BRIDGE_CLI_PROVIDER_CONFIG, 'utf8'));
    const record = event => appendFileSync(config.auditFile, JSON.stringify(event) + '\n');
    if (call.args.includes('--help')) call.child.stdout.write('Usage: agent-local [options]\nStart the Cursor Agent\n--workspace stream-json\n');
    else if (call.args.includes('models')) record({ stage: 'catalogue_verified', model: preference.model });
    else {
      assert.equal(config.allowInference, true);
      assert.ok(call.args.includes('--authless'));
      assert.ok(call.args.includes('--import'));
      assert.equal(call.args.includes('--model'), false); // native --model would reset parameters
      assert.equal(call.options.env.CURSOR_API_KEY, undefined);
      const settings = JSON.parse(readFileSync(join(call.options.env.CURSOR_CONFIG_DIR, 'cli-config.json'), 'utf8'));
      assert.equal(settings.selectedModel.modelId, preference.model);
      assert.equal(settings.selectedModel.parameters[0].value, preference.effort);
      const event = value => call.child.stdout.write(JSON.stringify({ ...value, session_id: 'local-session' }) + '\n');
      event({ type: 'system', subtype: 'init', cwd: project, model: preference.model });
      for (const stage of ['before_send', 'response.created', 'response.completed']) record({ stage, ...preference });
      event({ type: 'assistant', message: { content: [{ type: 'text', text: 'complete evidence' }] } });
      event({ type: 'result', subtype: 'success', is_error: false });
    }
    call.child.finish();
  });
  const options = { ...mock, env: { ...process.env, CURSOR_CONFIG_DIR: native, CURSOR_API_KEY: 'DO_NOT_INHERIT' }, provider, modelPreference: preference };
  const cli = await inspectCursorCli(options);
  const answer = await runCursorCli({ projectPath: project, prompt: 'read-only question', modelPreference: preference, cli }, options);
  assert.equal(answer.result, 'complete evidence');
  assert.equal(answer.modelSelection.providerResponseConfirmed, true);
  assert.equal(answer.modelSelection.providerRequestCount, 1);
  assert.equal(answer.modelSelection.provider.harness, 'cursor-agent-local');
  assert.equal(readFileSync(join(native, 'cli-config.json'), 'utf8'), original);
  assert.ok(mock.calls.every(call => call.options.windowsHide && call.options.shell === false));
  const before = mock.calls.length;
  await assert.rejects(runCursorCli({ projectPath: project, prompt: 'question', modelPreference: { ...preference, effort: 'low' }, cli }, options), { code: 'CURSOR_CLI_PROVIDER_UNVERIFIED' });
  assert.equal(mock.calls.length, before);
});

test('local-provider completion rejects invalid identities and pre-tool text as a final answer', async () => {
  const project = dirname(fileURLToPath(import.meta.url));
  const cli = { brand: 'Cursor', launcher: { command: process.execPath, args: [fileURLToPath(import.meta.url)] },
    provider, preference, models: [{ id: preference.model }], providerVerification: { catalogueVerified: true } };
  const init = { type: 'system', subtype: 'init', session_id: 's', model: preference.model, cwd: project };
  const end = { type: 'result', subtype: 'success', is_error: false, session_id: 's' };
  for (const tail of [
    [{ session_id: 's' }],
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'missing identity' }] } }],
    [{ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'intermediate text' }] } }, { type: 'tool_call', subtype: 'completed', session_id: 's' }, end],
  ]) {
    const mock = fakeCli(call => {
      const config = JSON.parse(readFileSync(call.options.env.CURSOR_BRIDGE_CLI_PROVIDER_CONFIG, 'utf8'));
      for (const stage of ['before_send', 'response.created', 'response.completed']) appendFileSync(config.auditFile, JSON.stringify({ stage, ...preference }) + '\n');
      call.child.stdout.write([init, ...tail].map(event => JSON.stringify(event) + '\n').join(''));
      call.child.finish();
    });
    await assert.rejects(runCursorCli({ projectPath: project, prompt: 'question', modelPreference: preference, cli }, { ...mock,
      env: { ...process.env, CURSOR_CONFIG_DIR: join(project, 'fixtures', 'missing-native-cli-profile') } }), { code: 'CURSOR_CLI_PROTOCOL_ERROR' });
  }
});
