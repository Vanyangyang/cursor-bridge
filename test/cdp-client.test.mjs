import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { makeClient } from '../cdp-client.mjs';

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.terminated = false;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  send(payload, callback) {
    this.sent.push(JSON.parse(payload));
    callback?.();
  }

  respond(id, result) {
    this.emit('message', Buffer.from(JSON.stringify({ id, result })));
  }

  protocolError(id, error) {
    this.emit('message', Buffer.from(JSON.stringify({ id, error })));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1000, Buffer.alloc(0));
  }

  terminate() {
    this.terminated = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function client(options = {}) {
  FakeWebSocket.instances.length = 0;
  const value = makeClient('ws://127.0.0.1/devtools/page/test', {
    WebSocketImpl: FakeWebSocket,
    origin: 'http://localhost:9223',
    connectTimeoutMs: 50,
    commandTimeoutMs: 50,
    ...options,
  });
  return { client: value, socket: FakeWebSocket.instances[0] };
}

test('connects with a hard handshake deadline and sends each command once', async () => {
  const { client: cdp, socket } = client();
  assert.equal(socket.options.origin, 'http://localhost:9223');
  assert.equal(socket.options.handshakeTimeout, 50);
  socket.open();
  await cdp.ready;
  const result = cdp.send('Runtime.evaluate', { expression: '1+1' });
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(socket.sent[0], { id: 1, method: 'Runtime.evaluate', params: { expression: '1+1' } });
  socket.respond(1, { result: { value: 2 } });
  assert.deepEqual(await result, { result: { value: 2 } });
  cdp.close();
});

test('hard connection timeout rejects ready and terminates the socket', async () => {
  const { client: cdp, socket } = client({ connectTimeoutMs: 10 });
  await assert.rejects(cdp.ready, error => error.code === 'CDP_CONNECT_TIMEOUT' && error.stage === 'connect');
  assert.equal(socket.terminated, true);
});

test('raw connection errors retain their code, cause, and connect stage', async () => {
  const { client: cdp, socket } = client();
  const cause = Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:9223'), { code: 'ETIMEDOUT' });
  socket.emit('error', cause);
  await assert.rejects(cdp.ready, error =>
    error.code === 'ETIMEDOUT' && error.stage === 'connect' && error.cause === cause
      && error.cdp.stage === 'connect' && Number.isFinite(error.cdp.elapsedMs));
  assert.equal(socket.terminated, true);
});

test('explicit close settles an ignored or awaited connecting ready promise', async () => {
  const first = client();
  first.client.close();
  await assert.rejects(first.client.ready, error => error.code === 'CDP_CLIENT_CLOSED');
  assert.equal(first.socket.terminated, true);

  const second = client();
  second.client.close();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(second.socket.terminated, true);
});

test('send before open and invalid per-command timeouts fail without writing', async () => {
  const { client: cdp, socket } = client();
  await assert.rejects(cdp.send('Runtime.evaluate'), error => error.code === 'CDP_NOT_OPEN' && error.stage === 'send');
  assert.equal(socket.sent.length, 0);
  socket.open();
  await cdp.ready;
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(cdp.send('Runtime.evaluate', {}, { timeoutMs }), error => error.code === 'CDP_INVALID_TIMEOUT');
  }
  assert.equal(socket.sent.length, 0);
  cdp.close();
});

test('per-command timeout is capped by the client default', async () => {
  const { client: cdp, socket } = client({ commandTimeoutMs: 10 });
  socket.open();
  await cdp.ready;
  await assert.rejects(
    cdp.send('Runtime.evaluate', {}, { timeoutMs: 1000 }),
    error => error.code === 'CDP_COMMAND_TIMEOUT' && error.stage === 'command'
      && error.method === 'Runtime.evaluate' && error.cdp.method === 'Runtime.evaluate'
      && error.cdp.elapsedMs >= 0,
  );
  assert.equal(socket.sent.length, 1);
  cdp.close();
});

test('socket close and error reject pending commands with cleared timers', async () => {
  const closed = client();
  closed.socket.open();
  await closed.client.ready;
  const pendingClose = closed.client.send('Runtime.evaluate');
  closed.socket.close();
  await assert.rejects(pendingClose, error => error.code === 'CDP_SOCKET_CLOSED' && error.stage === 'socket');

  const failed = client();
  failed.socket.open();
  await failed.client.ready;
  const pendingError = failed.client.send('Runtime.evaluate');
  const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
  failed.socket.emit('error', cause);
  await assert.rejects(pendingError, error =>
    error.code === 'ECONNRESET' && error.stage === 'socket' && error.cause === cause
      && error.cdp.method === 'Runtime.evaluate');
  assert.equal(failed.socket.terminated, true);
});

test('protocol error details are bounded and late responses do not settle twice', async () => {
  const { client: cdp, socket } = client();
  socket.open();
  await cdp.ready;
  const pending = cdp.send('Runtime.evaluate');
  socket.protocolError(1, { code: -32000, message: 'x'.repeat(10000) });
  await assert.rejects(pending, error => {
    assert.equal(error.code, -32000);
    assert.equal(error.stage, 'protocol');
    assert.equal(error.cdp.method, 'Runtime.evaluate');
    assert.ok(error.message.length < 2200);
    return true;
  });
  socket.respond(1, { ignored: true });
  assert.equal(socket.sent.length, 1);
  cdp.close();
});

test('synchronous send errors preserve their cause and clear the pending command', async () => {
  class ThrowingWebSocket extends FakeWebSocket {
    send() {
      const error = Object.assign(new Error('write failed'), { code: 'EPIPE' });
      throw error;
    }
  }
  ThrowingWebSocket.instances = [];
  const cdp = makeClient('ws://test', {
    WebSocketImpl: ThrowingWebSocket,
    connectTimeoutMs: 50,
    commandTimeoutMs: 50,
  });
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await cdp.ready;
  await assert.rejects(cdp.send('Runtime.evaluate'), error =>
    error.code === 'EPIPE' && error.stage === 'send' && error.cause?.code === 'EPIPE');
  socket.respond(1, { ignored: true });
  cdp.close();
});
