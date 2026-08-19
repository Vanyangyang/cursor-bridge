import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  assertProxyEndpointReachable,
  parseNetstatTcpConnections,
  readWindowsUserProxyEnvironment,
  resolveLeaderProxyContext,
  verifyLeaderProxyRoute,
} from "./proxy-environment.mjs";

const TEST_PROXY_PORT = 43123;

function persistedSettings(port = TEST_PROXY_PORT) {
  return {
    proxy: {
      url: `http://127.0.0.1:${port}`,
      protocol: "http",
      host: "127.0.0.1",
      port,
    },
  };
}

test("reads fresh Windows user proxy variables without loading a PowerShell profile", () => {
  let receivedArgs = null;
  const environment = readWindowsUserProxyEnvironment({
    platform: "win32",
    execFileSyncImpl: (_command, args) => {
      receivedArgs = args;
      return JSON.stringify({
        HTTP_PROXY: `http://127.0.0.1:${TEST_PROXY_PORT}`,
        HTTPS_PROXY: `http://127.0.0.1:${TEST_PROXY_PORT}`,
      });
    },
  });
  assert.equal(environment.HTTPS_PROXY, `http://127.0.0.1:${TEST_PROXY_PORT}`);
  assert.ok(receivedArgs.includes("-NoProfile"));
  assert.ok(receivedArgs.includes("-NonInteractive"));
});

test("persisted initialization wins over stale process and user environments", () => {
  const context = resolveLeaderProxyContext({
    baseEnvironment: {
      HTTP_PROXY: "http://127.0.0.1:9999",
      HTTPS_PROXY: "http://127.0.0.1:9999",
      NO_PROXY: "old.internal",
    },
    userEnvironment: {
      HTTP_PROXY: "http://127.0.0.1:43124",
      HTTPS_PROXY: "http://127.0.0.1:43124",
      NO_PROXY: "terminal.internal",
    },
    proxySettings: persistedSettings(),
    policy: "required",
  });
  assert.equal(context.summary.source, "persistent_init");
  assert.deepEqual(context.summary.endpoint, { protocol: "http", host: "127.0.0.1", port: TEST_PROXY_PORT });
  assert.equal(context.environment.HTTP_PROXY, `http://127.0.0.1:${TEST_PROXY_PORT}`);
  assert.equal(context.environment.https_proxy, `http://127.0.0.1:${TEST_PROXY_PORT}`);
  assert.equal(context.environment.GROK_SUPERVISOR_PROXY_URL, `http://127.0.0.1:${TEST_PROXY_PORT}`);
  assert.match(context.environment.NO_PROXY, /localhost/);
  assert.match(context.environment.NO_PROXY, /127\.0\.0\.1/);
  assert.doesNotMatch(JSON.stringify(context.summary), /9999/);
  assert.doesNotMatch(JSON.stringify(context.summary), /43124/);
});

test("required proxy policy requires explicit initialization", () => {
  assert.throws(() => resolveLeaderProxyContext({
    baseEnvironment: {},
    userEnvironment: {},
    policy: "required",
  }), (error) => {
    assert.equal(error.code, "GROK_PROXY_NOT_INITIALIZED");
    assert.match(error.message, /grok_init/);
    return true;
  });
});

test("verified proxy handoff survives into the TUI host through the internal override", () => {
  const context = resolveLeaderProxyContext({
    baseEnvironment: {
      GROK_SUPERVISOR_PROXY_URL: `http://127.0.0.1:${TEST_PROXY_PORT}`,
    },
    userEnvironment: {},
    policy: "required",
  });
  assert.equal(context.summary.source, "supervisor_override");
  assert.equal(context.httpsProxy.port, TEST_PROXY_PORT);
  assert.equal(context.environment.GROK_SUPERVISOR_PROXY_URL, `http://127.0.0.1:${TEST_PROXY_PORT}`);
});

test("proxy endpoint preflight verifies the configured listener", async (t) => {
  const server = createServer((socket) => socket.end());
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => server.close());
  const { port } = server.address();
  const context = resolveLeaderProxyContext({
    baseEnvironment: {},
    proxySettings: persistedSettings(port),
    policy: "required",
  });
  const result = await assertProxyEndpointReachable(context, { timeoutMs: 1000 });
  assert.equal(result.reachable, true);
  assert.equal(result.port, port);
});

test("netstat parsing and route verification require the Leader to use the proxy", async () => {
  const output = [
    `  TCP    127.0.0.1:50000    127.0.0.1:${TEST_PROXY_PORT}    ESTABLISHED     4242`,
    "  TCP    127.0.0.1:50001    203.0.113.10:443   ESTABLISHED     7777",
  ].join("\r\n");
  const parsed = parseNetstatTcpConnections(output, 4242);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].remotePort, TEST_PROXY_PORT);
  const proxyContext = resolveLeaderProxyContext({
    baseEnvironment: {},
    proxySettings: persistedSettings(),
    policy: "required",
  });
  const result = await verifyLeaderProxyRoute({ pid: 4242, proxyContext }, {
    readConnections: async () => parsed,
    timeoutMs: 1,
  });
  assert.equal(result.route, "proxy");
});

test("route verification rejects a direct TLS connection", async () => {
  const proxyContext = resolveLeaderProxyContext({
    baseEnvironment: {},
    proxySettings: persistedSettings(),
    policy: "required",
  });
  await assert.rejects(() => verifyLeaderProxyRoute({ pid: 4242, proxyContext }, {
    readConnections: async () => [{
      remote: "150.107.3.176:443",
      remoteHost: "150.107.3.176",
      remotePort: 443,
      state: "ESTABLISHED",
      pid: 4242,
    }],
    timeoutMs: 1,
  }), (error) => {
    assert.equal(error.code, "GROK_PROXY_BYPASS_DETECTED");
    return true;
  });
});
