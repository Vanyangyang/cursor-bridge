import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROXY_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];
const LOCAL_NO_PROXY = ["localhost", "127.0.0.1", "::1"];

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function firstValue(environment, names) {
  for (const name of names) {
    const value = environment?.[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function parseProxyUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw codedError("GROK_PROXY_INVALID", `${label} is not a valid proxy URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname) {
    throw codedError("GROK_PROXY_INVALID", `${label} must use an http or https URL`);
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw codedError("GROK_PROXY_INVALID", `${label} has an invalid port`);
  }
  return {
    value,
    protocol: parsed.protocol.slice(0, -1),
    host: parsed.hostname,
    port,
  };
}

function mergeNoProxy(...values) {
  const entries = [];
  const seen = new Set();
  for (const value of [...values, LOCAL_NO_PROXY.join(",")]) {
    for (const entry of String(value || "").split(",").map((item) => item.trim()).filter(Boolean)) {
      const key = entry.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entries.push(entry);
      }
    }
  }
  return entries.join(",");
}

export function readWindowsUserProxyEnvironment({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== "win32") {
    return {};
  }
  const command = [
    "$names = @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy')",
    "$result = [ordered]@{}",
    "foreach ($name in $names) {",
    "  $value = [Environment]::GetEnvironmentVariable($name, 'User')",
    "  if (-not [string]::IsNullOrWhiteSpace($value)) { $result[$name] = $value }",
    "}",
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const output = execFileSyncImpl("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(String(output || "{}").replace(/^\uFEFF/, "").trim() || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw codedError("GROK_PROXY_RESOLUTION_FAILED", `Could not read the current Windows user proxy environment: ${error.message}`);
  }
}

export function resolveLeaderProxyContext({
  baseEnvironment = process.env,
  userEnvironment,
  readUserEnvironment = readWindowsUserProxyEnvironment,
  proxySettings = null,
  policy = baseEnvironment.GROK_SUPERVISOR_PROXY_POLICY || "required",
} = {}) {
  if (!new Set(["required", "inherit"]).has(policy)) {
    throw codedError("GROK_PROXY_POLICY_INVALID", "GROK_SUPERVISOR_PROXY_POLICY must be required or inherit");
  }
  const override = firstValue(baseEnvironment, ["GROK_SUPERVISOR_PROXY_URL"]);
  const persisted = typeof proxySettings?.proxy?.url === "string"
    ? proxySettings.proxy.url
    : null;
  const freshUserEnvironment = policy === "inherit" && !override && !persisted
    ? (userEnvironment ?? readUserEnvironment())
    : {};
  const userHttp = firstValue(freshUserEnvironment, ["HTTP_PROXY", "http_proxy"]);
  const userHttps = firstValue(freshUserEnvironment, ["HTTPS_PROXY", "https_proxy"]);
  const processHttp = firstValue(baseEnvironment, ["HTTP_PROXY", "http_proxy"]);
  const processHttps = firstValue(baseEnvironment, ["HTTPS_PROXY", "https_proxy"]);
  const hasUserProxy = Boolean(userHttp || userHttps);
  const source = override
    ? "supervisor_override"
    : persisted
      ? "persistent_init"
      : hasUserProxy
        ? "windows_user_environment"
        : (processHttp || processHttps)
          ? "process_environment"
          : "none";
  const selected = override
    ? { http: override, https: override, noProxy: firstValue(baseEnvironment, ["GROK_SUPERVISOR_NO_PROXY"]) }
    : persisted
      ? {
          http: persisted,
          https: persisted,
          noProxy: firstValue(baseEnvironment, ["GROK_SUPERVISOR_NO_PROXY", "NO_PROXY", "no_proxy"]),
        }
      : hasUserProxy
        ? {
            http: userHttp || userHttps,
            https: userHttps || userHttp,
            noProxy: firstValue(freshUserEnvironment, ["NO_PROXY", "no_proxy"]),
          }
        : {
            http: processHttp || processHttps,
            https: processHttps || processHttp,
            noProxy: firstValue(baseEnvironment, ["NO_PROXY", "no_proxy"]),
          };

  if (!selected.https) {
    if (policy === "required") {
      throw codedError(
        "GROK_PROXY_NOT_INITIALIZED",
        "Grok Build Supervisor has no initialized local proxy; run /grok_init before opening a session",
        { nextStep: "Run /grok_init, then retry the original session request." },
      );
    }
    return {
      policy,
      environment: { ...baseEnvironment },
      summary: { configured: false, policy, source: "none", fingerprint: null },
      httpProxy: null,
      httpsProxy: null,
    };
  }

  const httpProxy = parseProxyUrl(selected.http || selected.https, "HTTP proxy");
  const httpsProxy = parseProxyUrl(selected.https, "HTTPS proxy");
  const noProxy = mergeNoProxy(
    selected.noProxy,
    firstValue(baseEnvironment, ["GROK_SUPERVISOR_NO_PROXY"]),
  );
  const environment = { ...baseEnvironment };
  for (const key of PROXY_ENV_KEYS) {
    delete environment[key];
  }
  environment.HTTP_PROXY = httpProxy.value;
  environment.HTTPS_PROXY = httpsProxy.value;
  environment.http_proxy = httpProxy.value;
  environment.https_proxy = httpsProxy.value;
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;
  environment.GROK_SUPERVISOR_PROXY_POLICY = policy;
  environment.GROK_SUPERVISOR_PROXY_URL = httpsProxy.value;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ http: httpProxy.value, https: httpsProxy.value, noProxy }))
    .digest("hex");
  return {
    policy,
    environment,
    httpProxy,
    httpsProxy,
    summary: {
      configured: true,
      policy,
      source,
      endpoint: {
        protocol: httpsProxy.protocol,
        host: httpsProxy.host,
        port: httpsProxy.port,
      },
      fingerprint,
    },
  };
}

export async function assertProxyEndpointReachable(proxyContext, {
  connect = createConnection,
  timeoutMs = 2000,
} = {}) {
  if (!proxyContext?.httpsProxy) {
    if (proxyContext?.policy === "required") {
      throw codedError("GROK_PROXY_REQUIRED", "The required Grok Leader proxy is not configured");
    }
    return { reachable: false, skipped: true };
  }
  const { host, port } = proxyContext.httpsProxy;
  return new Promise((resolveReachability, rejectReachability) => {
    let settled = false;
    let socket;
    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      socket?.destroy();
      if (error) {
        rejectReachability(codedError(
          "GROK_PROXY_UNREACHABLE",
          `The required Grok Leader proxy is not reachable at ${host}:${port}`,
          { host, port },
        ));
      } else {
        resolveReachability({ reachable: true, host, port });
      }
    };
    try {
      socket = connect({ host, port });
      socket.once("connect", () => finish());
      socket.once("error", (error) => finish(error));
      socket.setTimeout(timeoutMs, () => finish(new Error("timeout")));
    } catch (error) {
      finish(error);
    }
  });
}

function splitEndpoint(value) {
  if (value.startsWith("[")) {
    const closing = value.lastIndexOf("]:");
    if (closing >= 0) {
      return { host: value.slice(1, closing), port: Number(value.slice(closing + 2)) };
    }
  }
  const separator = value.lastIndexOf(":");
  return separator >= 0
    ? { host: value.slice(0, separator), port: Number(value.slice(separator + 1)) }
    : { host: value, port: null };
}

function normalizeHost(value) {
  return String(value || "").replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").toLowerCase();
}

export function parseNetstatTcpConnections(output, pid) {
  const expectedPid = String(pid);
  const connections = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP" || fields.at(-1) !== expectedPid) {
      continue;
    }
    const remote = splitEndpoint(fields[2]);
    connections.push({
      local: fields[1],
      remote: fields[2],
      remoteHost: normalizeHost(remote.host),
      remotePort: remote.port,
      state: fields[3].toUpperCase(),
      pid: Number(pid),
    });
  }
  return connections;
}

async function readProcessTcpConnections(pid) {
  const result = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseNetstatTcpConnections(result.stdout, pid);
}

function proxyHostMatches(observed, expected) {
  const left = normalizeHost(observed);
  const right = normalizeHost(expected);
  if (left === right) {
    return true;
  }
  const loopbacks = new Set(["localhost", "127.0.0.1", "::1"]);
  return loopbacks.has(left) && loopbacks.has(right);
}

export async function verifyLeaderProxyRoute({ pid, proxyContext }, {
  readConnections = readProcessTcpConnections,
  timeoutMs = 5000,
  pollIntervalMs = 200,
  delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !proxyContext?.httpsProxy) {
    throw codedError("GROK_PROXY_ROUTE_UNVERIFIED", "The Leader proxy route cannot be verified without an exact PID and proxy endpoint");
  }
  const expected = proxyContext.httpsProxy;
  const deadline = Date.now() + timeoutMs;
  const observed = new Set();
  while (Date.now() <= deadline) {
    const connections = await readConnections(pid);
    let verifiedProxyConnection = null;
    let directTlsConnection = null;
    for (const connection of connections) {
      observed.add(connection.remote);
      const viaProxy = connection.remotePort === expected.port
        && proxyHostMatches(connection.remoteHost, expected.host)
        && connection.state === "ESTABLISHED";
      if (viaProxy) {
        verifiedProxyConnection = connection;
      }
      const directTls = connection.remotePort === 443
        && !proxyHostMatches(connection.remoteHost, expected.host)
        && new Set(["ESTABLISHED", "SYN_SENT"]).has(connection.state);
      if (directTls) {
        directTlsConnection = connection;
      }
    }
    if (directTlsConnection) {
      throw codedError(
        "GROK_PROXY_BYPASS_DETECTED",
        `The Grok Leader attempted a direct TLS connection to ${directTlsConnection.remote}; refusing to continue`,
        { pid, expectedProxy: `${expected.host}:${expected.port}`, observed: [...observed].slice(0, 20) },
      );
    }
    if (verifiedProxyConnection) {
      return {
        verified: true,
        pid,
        route: "proxy",
        endpoint: { host: expected.host, port: expected.port },
        state: verifiedProxyConnection.state,
      };
    }
    if (Date.now() < deadline) {
      await delay(pollIntervalMs);
    }
  }
  throw codedError(
    "GROK_PROXY_ROUTE_UNVERIFIED",
    `The Grok Leader did not establish a verified connection through ${expected.host}:${expected.port}`,
    { pid, expectedProxy: `${expected.host}:${expected.port}`, observed: [...observed].slice(0, 20) },
  );
}
