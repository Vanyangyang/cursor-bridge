import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CursorBridge, buildContextEnginePrompt, buildToolDefinitions, normalizeRequestContext } from '../server.mjs';

class OfflineBridge extends CursorBridge {
  constructor() { super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null, projectPath: process.cwd() }); }
  async _ensureCursor() {}
  _drain() {}
}

test('provenance is explicitly declared; omitted values remain unknown', () => {
  assert.deepEqual(normalizeRequestContext(), { sender: 'unknown', source: 'unknown' });
  assert.deepEqual(normalizeRequestContext({ sender: 'model' }), { sender: 'model', source: 'unknown' });
  for (const sender of ['user', 'model', 'unknown']) {
    for (const source of ['user', 'model', 'mixed', 'unknown']) assert.deepEqual(normalizeRequestContext({ sender, source }), { sender, source });
  }
  for (const value of [null, [], 'model', { sender: 'Claude Fable 5.1' }, { source: 'USER' }, { sender: null }, { authority: 'user' }]) {
    assert.throws(() => normalizeRequestContext(value), /request_context/);
  }
});

test('delegation passes source labels to the actual queued prompt without changing user text or scope', async () => {
  const bridge = new OfflineBridge();
  const prompt = '用户确认：只读检查。主代理补充：检验这个假设，允许反驳。';
  const result = await bridge.doTask(prompt, { readOnly: true, requestContext: { sender: 'model', source: 'mixed' } });
  const job = bridge.tasks.get(result.taskId);
  assert.match(job.prompt, /Immediate sender: model\. Instruction source: mixed\./);
  assert.ok(job.prompt.includes(prompt));
  assert.match(job.prompt, /Read-only boundary/);
  assert.equal(job.readOnly, true);
  assert.deepEqual(result.requestContext, { sender: 'model', source: 'mixed' });
  assert.deepEqual((await bridge.status(result.taskId)).requestContext, result.requestContext);
  const next = await bridge.doTask('用户要求检索，但没有声明来源', { readOnly: true });
  assert.deepEqual(next.requestContext, { sender: 'unknown', source: 'unknown' });
  assert.match(bridge.tasks.get(next.taskId).prompt, /Immediate sender: unknown\. Instruction source: unknown\./);
});

test('CCE carries explicit provenance through its real queue path', async () => {
  const bridge = new OfflineBridge();
  let queued;
  bridge._enqueue = (kind, prompt, options) => {
    queued = { kind, prompt, options };
    return { promise: Promise.resolve('CCE_SEARCH_RESULT\nNOT_FOUND') };
  };
  bridge._markTaskResultCollected = () => {};
  await bridge.contextEngine('locate ownership', { requestContext: { sender: 'model', source: 'model' } });
  assert.equal(queued.kind, 'context_engine');
  assert.equal(queued.options.readOnly, true);
  assert.deepEqual(queued.options.requestContext, { sender: 'model', source: 'model' });
  assert.match(queued.prompt, /Instruction source: model/);
  assert.match(queued.prompt, /locate ownership/);
  assert.match(buildContextEnginePrompt('user says use Fable'), /Instruction source: unknown/);
});

test('invalid provenance is rejected before lifecycle or UI operations', async () => {
  const bridge = new OfflineBridge();
  bridge._ensureCursor = async () => assert.fail('invalid input must not reach lifecycle');
  await assert.rejects(bridge.doTask('task', { requestContext: { source: 'guess' } }), /request_context/);
  await assert.rejects(bridge.contextEngine('query', { requestContext: { sender: 'guess' } }), /request_context/);
  assert.equal(bridge.tasks.size, 0);
});

test('both public tools expose the same optional, closed provenance contract', () => {
  const definitions = buildToolDefinitions(new OfflineBridge());
  for (const name of ['cursor_do', 'cursor_context_engine']) {
    const schema = definitions.find(tool => tool.name === name).inputSchema;
    assert.equal(schema.required.includes('request_context'), false);
    const context = schema.properties.request_context;
    assert.equal(context.additionalProperties, false);
    assert.deepEqual(context.properties.sender.enum, ['user', 'model', 'unknown']);
    assert.deepEqual(context.properties.source.enum, ['user', 'model', 'mixed', 'unknown']);
  }
});

test('bundled MCP forwards request_context to validation before any Cursor interaction', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url))],
    env: { ...process.env, CURSOR_BRIDGE_DELEGATION: 'on', CURSOR_BRIDGE_NO_AUTOLAUNCH: '1', CURSOR_BRIDGE_CDP_PORT: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'request-context-protocol-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const [name, input] of [['cursor_do', { prompt: 'must not be dispatched' }], ['cursor_context_engine', { query: 'must not be dispatched' }]]) {
      assert.ok(listed.tools.find(tool => tool.name === name).inputSchema.properties.request_context);
      const result = await client.callTool({ name, arguments: { ...input, request_context: { sender: 'model', source: 'invalid' } } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /request_context.source/);
    }
  } finally { await client.close(); }
});
