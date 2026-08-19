import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeProxySettings,
  normalizeLocalProxyUrl,
  parseLoopbackListeningPorts,
  probeHttpConnectProxy,
  readProxySettings,
} from "./proxy-settings.mjs";

const TEST_PROXY_PORT = 43123;

function verifiedProbe(endpoint) {
  return Promise.resolve({
    verified: true,
    kind: "http_connect",
    target: "example.com:443",
    statusCode: 200,
    endpoint,
  });
}

test("local proxy URLs reject remote hosts, credentials, and non-HTTP schemes", () => {
  assert.deepEqual(normalizeLocalProxyUrl(`http://127.0.0.1:${TEST_PROXY_PORT}`), {
    url: `http://127.0.0.1:${TEST_PROXY_PORT}`,
    protocol: "http",
    host: "127.0.0.1",
    port: TEST_PROXY_PORT,
  });
  assert.throws(() => normalizeLocalProxyUrl(`http://user:secret@127.0.0.1:${TEST_PROXY_PORT}`), (error) => error.code === "GROK_PROXY_CREDENTIALS_REFUSED");
  assert.throws(() => normalizeLocalProxyUrl(`socks5://127.0.0.1:${TEST_PROXY_PORT}`), (error) => error.code === "GROK_PROXY_INVALID");
  assert.throws(() => normalizeLocalProxyUrl(`http://192.0.2.10:${TEST_PROXY_PORT}`), (error) => error.code === "GROK_PROXY_NOT_LOCAL");
});

test("loopback listener parsing accepts loopback and wildcard listeners without fixed ports", () => {
  const output = [
    `  TCP    127.0.0.1:${TEST_PROXY_PORT}    0.0.0.0:0    LISTENING    100`,
    "  TCP    0.0.0.0:43124    0.0.0.0:0    LISTENING    101",
    "  TCP    192.0.2.10:43125    0.0.0.0:0    LISTENING    102",
    "  TCP    [::1]:43126    [::]:0    LISTENING    103",
  ].join("\r\n");
  assert.deepEqual(parseLoopbackListeningPorts(output), [TEST_PROXY_PORT, 43124, 43126]);
});

test("initialization verifies and atomically persists the current user proxy", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-proxy-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsPath = join(root, "proxy-settings.json");
  const result = await initializeProxySettings({
    settingsPath,
    baseEnvironment: {},
    userEnvironment: { HTTPS_PROXY: `http://127.0.0.1:${TEST_PROXY_PORT}` },
    probeCandidate: verifiedProbe,
    listListeningPorts: () => { throw new Error("scan must not run"); },
    now: () => "2026-08-19T00:00:00.000Z",
  });
  assert.equal(result.initialized, true);
  assert.equal(result.proxy.port, TEST_PROXY_PORT);
  assert.equal(result.source, "windows_user_environment");
  assert.equal(readProxySettings(settingsPath).proxy.port, TEST_PROXY_PORT);

  const replacement = await initializeProxySettings({
    settingsPath,
    proxyUrl: "http://localhost:43124",
    baseEnvironment: {},
    probeCandidate: verifiedProbe,
    now: () => "2026-08-19T00:01:00.000Z",
  });
  assert.equal(replacement.previousProxy.port, TEST_PROXY_PORT);
  assert.equal(readProxySettings(settingsPath).proxy.port, 43124);
});

test("initialization requires an explicit choice when multiple proxies verify", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-proxy-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsPath = join(root, "proxy-settings.json");
  const result = await initializeProxySettings({
    settingsPath,
    baseEnvironment: {},
    userEnvironment: {
      HTTP_PROXY: "http://127.0.0.1:43125",
      HTTPS_PROXY: "http://127.0.0.1:43126",
    },
    probeCandidate: verifiedProbe,
  });
  assert.equal(result.initialized, false);
  assert.equal(result.status, "needs_selection");
  assert.equal(result.candidates.length, 2);
  assert.equal(existsSync(settingsPath), false);
});

test("initialization scans listeners only after configured candidates fail", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-proxy-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsPath = join(root, "proxy-settings.json");
  const result = await initializeProxySettings({
    settingsPath,
    baseEnvironment: {},
    userEnvironment: {},
    listListeningPorts: async () => [43127, 43128],
    probeCandidate: async (endpoint) => {
      if (endpoint.port !== 43128) throw new Error("not an HTTP proxy");
      return verifiedProbe(endpoint);
    },
  });
  assert.equal(result.initialized, true);
  assert.equal(result.proxy.port, 43128);
  assert.equal(result.source, "loopback_listener");
});

test("HTTP CONNECT probing distinguishes a proxy from an arbitrary TCP listener", async (t) => {
  const proxy = createServer((socket) => {
    socket.once("data", () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
  });
  await new Promise((resolveListen, rejectListen) => {
    proxy.once("error", rejectListen);
    proxy.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => proxy.close());
  const endpoint = normalizeLocalProxyUrl(`http://127.0.0.1:${proxy.address().port}`);
  const verified = await probeHttpConnectProxy(endpoint, { timeoutMs: 1000 });
  assert.equal(verified.verified, true);
  assert.equal(verified.statusCode, 200);

  const ordinary = createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  });
  await new Promise((resolveListen, rejectListen) => {
    ordinary.once("error", rejectListen);
    ordinary.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => ordinary.close());
  const ordinaryEndpoint = normalizeLocalProxyUrl(`http://127.0.0.1:${ordinary.address().port}`);
  await assert.rejects(() => probeHttpConnectProxy(ordinaryEndpoint, { timeoutMs: 1000 }), (error) => error.code === "GROK_PROXY_CONNECT_REJECTED");
});
