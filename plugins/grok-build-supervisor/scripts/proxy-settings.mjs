import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { parseProxyUrl, readWindowsUserProxyEnvironment } from "./proxy-environment.mjs";

const execFileAsync = promisify(execFile);
const SETTINGS_SCHEMA_VERSION = 1;
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const DEFAULT_SCAN_LIMIT = 256;
const DEFAULT_SCAN_CONCURRENCY = 16;

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizedHost(value) {
  return String(value || "").replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").toLowerCase();
}

function isLoopbackHost(value) {
  const host = normalizedHost(value);
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function normalizeLocalProxyUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw codedError("GROK_PROXY_INVALID", "Proxy URL must be a valid absolute URL");
  }
  const parsed = parseProxyUrl(url.toString(), "Proxy URL");
  if (parsed.protocol !== "http") {
    throw codedError("GROK_PROXY_PROTOCOL_UNSUPPORTED", "Local proxy initialization currently requires an http:// endpoint");
  }
  if (url.username || url.password) {
    throw codedError("GROK_PROXY_CREDENTIALS_REFUSED", "Proxy credentials are not persisted; use an unauthenticated loopback proxy");
  }
  if (!isLoopbackHost(parsed.host)) {
    throw codedError("GROK_PROXY_NOT_LOCAL", "Proxy initialization accepts only localhost or loopback endpoints");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw codedError("GROK_PROXY_INVALID", "Proxy URL must contain only scheme, loopback host, and port");
  }
  const host = normalizedHost(parsed.host);
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${formattedHost}:${parsed.port}`,
    protocol: "http",
    host,
    port: parsed.port,
  };
}

export function readProxySettings(settingsPath) {
  if (!settingsPath || !existsSync(settingsPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed?.schemaVersion !== SETTINGS_SCHEMA_VERSION || typeof parsed.proxy?.url !== "string") {
      return null;
    }
    const proxy = normalizeLocalProxyUrl(parsed.proxy.url);
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      proxy,
      source: typeof parsed.source === "string" ? parsed.source : "unknown",
      verification: parsed.verification?.kind === "http_connect"
        ? {
            kind: "http_connect",
            target: String(parsed.verification.target || ""),
            statusCode: Number(parsed.verification.statusCode) || null,
          }
        : null,
      verifiedAt: typeof parsed.verifiedAt === "string" ? parsed.verifiedAt : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
}

function writeProxySettings(settingsPath, value) {
  const fullPath = resolve(settingsPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const temporary = `${fullPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, fullPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw codedError(
      "GROK_PROXY_PERSIST_FAILED",
      `Could not persist Grok proxy settings at ${fullPath}: ${error.message}`,
      { settingsPath: fullPath },
    );
  }
  return fullPath;
}

function splitEndpoint(value) {
  const text = String(value || "");
  if (text.startsWith("[")) {
    const closing = text.lastIndexOf("]:");
    if (closing >= 0) {
      return { host: text.slice(1, closing), port: Number(text.slice(closing + 2)) };
    }
  }
  const separator = text.lastIndexOf(":");
  return separator >= 0
    ? { host: text.slice(0, separator), port: Number(text.slice(separator + 1)) }
    : { host: text, port: null };
}

export function parseLoopbackListeningPorts(output) {
  const ports = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP" || fields[3].toUpperCase() !== "LISTENING") {
      continue;
    }
    const local = splitEndpoint(fields[1]);
    const host = normalizedHost(local.host);
    const locallyReachable = isLoopbackHost(host) || host === "0.0.0.0" || host === "::";
    if (locallyReachable && Number.isInteger(local.port) && local.port >= 1 && local.port <= 65535) {
      ports.add(local.port);
    }
  }
  return [...ports].sort((left, right) => left - right);
}

export async function listLoopbackListeningPorts({
  platform = process.platform,
  execFileAsyncImpl = execFileAsync,
} = {}) {
  if (platform !== "win32") {
    return [];
  }
  try {
    const result = await execFileAsyncImpl("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseLoopbackListeningPorts(result?.stdout ?? result);
  } catch (error) {
    throw codedError("GROK_PROXY_DISCOVERY_FAILED", `Could not enumerate local listening ports: ${error.message}`);
  }
}

export function probeHttpConnectProxy(endpoint, {
  connect = createConnection,
  timeoutMs = 1500,
  targetHost = "example.com",
  targetPort = 443,
} = {}) {
  return new Promise((resolveProbe, rejectProbe) => {
    let socket;
    let settled = false;
    let response = "";
    const finish = (error = null, result = null) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      if (error) rejectProbe(error);
      else resolveProbe(result);
    };
    try {
      socket = connect({ host: endpoint.host, port: endpoint.port });
      socket.setEncoding("utf8");
      socket.setTimeout(timeoutMs, () => finish(codedError(
        "GROK_PROXY_PROBE_TIMEOUT",
        `Proxy probe timed out at ${endpoint.host}:${endpoint.port}`,
      )));
      socket.once("connect", () => {
        socket.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`
          + `Host: ${targetHost}:${targetPort}\r\n`
          + "Proxy-Connection: close\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => {
        response += chunk;
        if (response.length > 4096) {
          finish(codedError("GROK_PROXY_PROBE_INVALID", "Proxy probe response exceeded 4 KiB"));
          return;
        }
        const lineEnd = response.indexOf("\r\n");
        if (lineEnd < 0) return;
        const match = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(response.slice(0, lineEnd));
        const statusCode = match ? Number(match[1]) : null;
        if (!statusCode || statusCode < 200 || statusCode >= 300) {
          finish(codedError(
            "GROK_PROXY_CONNECT_REJECTED",
            `Endpoint ${endpoint.host}:${endpoint.port} did not accept an HTTP CONNECT tunnel`,
            { statusCode },
          ));
          return;
        }
        finish(null, {
          verified: true,
          kind: "http_connect",
          target: `${targetHost}:${targetPort}`,
          statusCode,
        });
      });
      socket.once("error", (error) => finish(codedError(
        "GROK_PROXY_PROBE_FAILED",
        `Could not probe ${endpoint.host}:${endpoint.port}: ${error.message}`,
      )));
      socket.once("end", () => finish(codedError(
        "GROK_PROXY_PROBE_EARLY_CLOSE",
        `Endpoint ${endpoint.host}:${endpoint.port} closed before returning a proxy response`,
      )));
    } catch (error) {
      finish(codedError("GROK_PROXY_PROBE_FAILED", `Could not probe proxy endpoint: ${error.message}`));
    }
  });
}

function addCandidate(collection, value, source, { strict = false } = {}) {
  try {
    const endpoint = normalizeLocalProxyUrl(value);
    if (!collection.has(endpoint.url)) {
      collection.set(endpoint.url, { endpoint, source });
    }
  } catch (error) {
    if (strict) throw error;
  }
}

function addEnvironmentCandidates(collection, environment, source) {
  for (const key of PROXY_ENV_KEYS) {
    const value = environment?.[key];
    if (typeof value === "string" && value.trim()) {
      addCandidate(collection, value, source);
    }
  }
}

async function verifyCandidates(candidates, probeCandidate, concurrency) {
  const results = new Array(candidates.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < candidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      try {
        const verification = await probeCandidate(candidate.endpoint);
        if (verification?.verified === true) {
          results[index] = { ...candidate, verification };
        }
      } catch {
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(concurrency, candidates.length || 1)) },
    worker,
  ));
  return results.filter(Boolean);
}

function candidateView(candidate) {
  return {
    proxyUrl: candidate.endpoint.url,
    host: candidate.endpoint.host,
    port: candidate.endpoint.port,
    source: candidate.source,
  };
}

export async function initializeProxySettings({
  settingsPath,
  proxyUrl,
  baseEnvironment = process.env,
  userEnvironment,
  readUserEnvironment = readWindowsUserProxyEnvironment,
  listListeningPorts = listLoopbackListeningPorts,
  probeCandidate = probeHttpConnectProxy,
  now = () => new Date().toISOString(),
  scanLimit = DEFAULT_SCAN_LIMIT,
  scanConcurrency = DEFAULT_SCAN_CONCURRENCY,
} = {}) {
  if (!settingsPath) {
    throw codedError("GROK_PROXY_SETTINGS_DISABLED", "A persistent proxy settings path is required");
  }
  const previous = readProxySettings(settingsPath);
  const configured = new Map();
  if (typeof proxyUrl === "string" && proxyUrl.trim()) {
    addCandidate(configured, proxyUrl, "explicit", { strict: true });
  } else {
    let currentUserEnvironment = userEnvironment;
    if (currentUserEnvironment === undefined) {
      try {
        currentUserEnvironment = readUserEnvironment();
      } catch {
        currentUserEnvironment = {};
      }
    }
    addEnvironmentCandidates(configured, currentUserEnvironment, "windows_user_environment");
    addEnvironmentCandidates(configured, baseEnvironment, "process_environment");
    if (previous) {
      addCandidate(configured, previous.proxy.url, "persisted_revalidation");
    }
  }

  let verified = await verifyCandidates([...configured.values()], probeCandidate, 4);
  if (proxyUrl && verified.length === 0) {
    throw codedError(
      "GROK_PROXY_UNREACHABLE",
      "The requested local proxy did not complete an HTTP CONNECT probe",
      { proxyUrl: normalizeLocalProxyUrl(proxyUrl).url },
    );
  }

  let scannedPortCount = 0;
  if (!proxyUrl && verified.length === 0) {
    const ports = (await listListeningPorts()).slice(0, Math.max(1, scanLimit));
    scannedPortCount = ports.length;
    const scanned = new Map();
    for (const port of ports) {
      addCandidate(scanned, `http://127.0.0.1:${port}`, "loopback_listener");
    }
    for (const key of configured.keys()) scanned.delete(key);
    verified = await verifyCandidates([...scanned.values()], probeCandidate, scanConcurrency);
  }

  if (verified.length === 0) {
    throw codedError(
      "GROK_PROXY_NOT_FOUND",
      "No local HTTP proxy completed the required CONNECT probe",
      {
        settingsPath: resolve(settingsPath),
        scannedPortCount,
        nextStep: "Start the local proxy, then run /grok_init again or pass an exact loopback http:// URL.",
      },
    );
  }
  if (verified.length > 1) {
    return {
      initialized: false,
      status: "needs_selection",
      settingsPath: resolve(settingsPath),
      candidates: verified.slice(0, 20).map(candidateView),
      message: "Multiple verified local HTTP proxies were found; choose one explicitly.",
      nextStep: "Run /grok_init with one exact proxy URL from candidates.",
    };
  }

  const selected = verified[0];
  const timestamp = now();
  const record = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    proxy: selected.endpoint,
    source: selected.source,
    verification: {
      kind: "http_connect",
      target: selected.verification.target,
      statusCode: selected.verification.statusCode,
    },
    verifiedAt: timestamp,
    updatedAt: timestamp,
  };
  const fullPath = writeProxySettings(settingsPath, record);
  return {
    initialized: true,
    status: "ready",
    settingsPath: fullPath,
    proxy: selected.endpoint,
    source: selected.source,
    verification: record.verification,
    verifiedAt: timestamp,
    previousProxy: previous?.proxy || null,
    message: `Grok Build Supervisor proxy initialized at ${selected.endpoint.host}:${selected.endpoint.port}.`,
  };
}
