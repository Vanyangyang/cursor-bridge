import { WebSocket } from 'ws';

const ERROR_JSON_LIMIT = 2048;

function positiveTimeout(name, value, fallback) {
  const timeout = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    const error = new TypeError(`${name} must be a positive finite number`);
    error.code = 'CDP_INVALID_TIMEOUT';
    error.stage = 'configuration';
    error.cdp = { stage: 'configuration', elapsedMs: 0 };
    throw error;
  }
  return timeout;
}

function clientError(message, { code, stage, method, cause, elapsedMs = 0 } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'CdpClientError';
  error.code = code || cause?.code || 'CDP_CLIENT_ERROR';
  error.stage = stage || 'unknown';
  if (method) error.method = method;
  error.cdp = {
    stage: error.stage,
    ...(method ? { method } : {}),
    elapsedMs: Math.max(0, Number(elapsedMs) || 0),
  };
  return error;
}

function boundedJson(value) {
  let text;
  try { text = JSON.stringify(value); }
  catch { text = String(value); }
  if (text === undefined) text = String(value);
  return text.length <= ERROR_JSON_LIMIT ? text : `${text.slice(0, ERROR_JSON_LIMIT)}…`;
}

export function makeClient(wsUrl, options = {}) {
  const createdAt = Date.now();
  const connectTimeoutMs = positiveTimeout('connectTimeoutMs', options.connectTimeoutMs, 5000);
  const commandTimeoutMs = positiveTimeout('commandTimeoutMs', options.commandTimeoutMs, 30000);
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const websocketOptions = { handshakeTimeout: connectTimeoutMs };
  if (options.origin !== undefined) websocketOptions.origin = options.origin;

  let ws;
  let state = 'connecting';
  let nextId = 0;
  let connectTimer;
  let readyResolve;
  let readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Callers still observe rejection through `ready`; this handler prevents a
  // close-before-await path from becoming an unhandled rejection.
  void ready.catch(() => {});

  const terminate = () => {
    if (!ws) return;
    try {
      if (typeof ws.terminate === 'function') ws.terminate();
      else ws.close();
    } catch {}
  };
  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(typeof error === 'function' ? error(entry) : error);
    }
    pending.clear();
  };
  const rejectReady = (error) => {
    if (state !== 'connecting') return;
    state = 'failed';
    clearTimeout(connectTimer);
    readyReject(error);
  };
  const failConnection = (cause) => {
    const error = clientError(`CDP WebSocket connection failed: ${cause?.message || cause}`, {
      stage: 'connect',
      cause,
      elapsedMs: Date.now() - createdAt,
    });
    rejectReady(error);
    terminate();
    return error;
  };
  const failSocket = (cause) => {
    const error = clientError(`CDP WebSocket failed: ${cause?.message || cause}`, {
      stage: 'socket',
      cause,
      elapsedMs: Date.now() - createdAt,
    });
    if (state === 'connecting') return failConnection(cause);
    if (state === 'open') state = 'failed';
    rejectPending((entry) => clientError(`CDP WebSocket failed during ${entry.method}: ${cause?.message || cause}`, {
      stage: 'socket',
      method: entry.method,
      cause,
      elapsedMs: Date.now() - entry.startedAt,
    }));
    terminate();
    return error;
  };

  try {
    ws = new WebSocketImpl(wsUrl, websocketOptions);
  } catch (cause) {
    failConnection(cause);
  }

  if (ws) {
    connectTimer = setTimeout(() => {
      const error = clientError(`CDP WebSocket connection timed out (${connectTimeoutMs}ms)`, {
        code: 'CDP_CONNECT_TIMEOUT',
        stage: 'connect',
        elapsedMs: Date.now() - createdAt,
      });
      rejectReady(error);
      terminate();
    }, connectTimeoutMs);

    ws.on('open', () => {
      if (state !== 'connecting') {
        terminate();
        return;
      }
      clearTimeout(connectTimer);
      state = 'open';
      readyResolve();
    });
    ws.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { return; }
      if (!message || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const detail = boundedJson(message.error);
        entry.reject(clientError(`CDP command failed: ${entry.method}: ${detail}`, {
          code: message.error.code ?? 'CDP_PROTOCOL_ERROR',
          stage: 'protocol',
          method: entry.method,
          elapsedMs: Date.now() - entry.startedAt,
        }));
      } else {
        entry.resolve(message.result);
      }
    });
    ws.on('error', (cause) => {
      if (state === 'closed' || state === 'failed') return;
      failSocket(cause);
    });
    ws.on('close', (code, reason) => {
      if (state === 'closed' || state === 'failed') return;
      const suffix = code ? ` (code=${code}${reason?.length ? ` reason=${String(reason).slice(0, 256)}` : ''})` : '';
      const error = clientError(`CDP WebSocket closed${suffix}`, {
        code: 'CDP_SOCKET_CLOSED',
        stage: state === 'connecting' ? 'connect' : 'socket',
        elapsedMs: Date.now() - createdAt,
      });
      if (state === 'connecting') rejectReady(error);
      else {
        state = 'closed';
        rejectPending((entry) => clientError(`CDP WebSocket closed during ${entry.method}${suffix}`, {
          code: 'CDP_SOCKET_CLOSED',
          stage: 'socket',
          method: entry.method,
          elapsedMs: Date.now() - entry.startedAt,
        }));
      }
    });
  }

  const send = (method, params = {}, sendOptions = {}) => {
    if (state !== 'open' || !ws || ws.readyState !== (WebSocketImpl.OPEN ?? 1)) {
      return Promise.reject(clientError(`CDP command cannot be sent before the WebSocket is open: ${method}`, {
        code: 'CDP_NOT_OPEN',
        stage: 'send',
        method,
        elapsedMs: 0,
      }));
    }
    let timeoutMs;
    try {
      timeoutMs = sendOptions.timeoutMs === undefined
        ? commandTimeoutMs
        : Math.min(commandTimeoutMs, positiveTimeout('timeoutMs', sendOptions.timeoutMs));
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++nextId;
    let payload;
    try { payload = JSON.stringify({ id, method, params }); }
    catch (cause) {
      return Promise.reject(clientError(`CDP command could not be serialized: ${method}: ${cause.message}`, {
        stage: 'send',
        method,
        cause,
        elapsedMs: 0,
      }));
    }
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(clientError(`CDP command timed out: ${method} (${timeoutMs}ms)`, {
          code: 'CDP_COMMAND_TIMEOUT',
          stage: 'command',
          method,
          elapsedMs: Date.now() - startedAt,
        }));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer, startedAt });
      try {
        ws.send(payload, (cause) => {
          if (!cause || !pending.has(id)) return;
          const entry = pending.get(id);
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(clientError(`CDP command send failed: ${method}: ${cause.message}`, {
            stage: 'send',
            method,
            cause,
            elapsedMs: Date.now() - startedAt,
          }));
        });
      } catch (cause) {
        pending.delete(id);
        clearTimeout(timer);
        reject(clientError(`CDP command send failed: ${method}: ${cause.message}`, {
          stage: 'send',
          method,
          cause,
          elapsedMs: Date.now() - startedAt,
        }));
      }
    });
  };

  const close = () => {
    if (state === 'closed') return;
    const wasConnecting = state === 'connecting';
    state = 'closed';
    clearTimeout(connectTimer);
    const error = clientError('CDP client closed', {
      code: 'CDP_CLIENT_CLOSED',
      stage: wasConnecting ? 'connect' : 'socket',
      elapsedMs: Date.now() - createdAt,
    });
    if (wasConnecting) readyReject(error);
    rejectPending((entry) => clientError(`CDP client closed during ${entry.method}`, {
      code: 'CDP_CLIENT_CLOSED',
      stage: 'socket',
      method: entry.method,
      elapsedMs: Date.now() - entry.startedAt,
    }));
    if (!ws) return;
    try {
      if (wasConnecting && typeof ws.terminate === 'function') ws.terminate();
      else ws.close();
    } catch {}
  };

  return { ready, send, close };
}
