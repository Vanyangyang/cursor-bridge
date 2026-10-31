import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// cursor-cli-provider-preload.mjs
import { readFile, stat } from "node:fs/promises";
import { appendFileSync } from "node:fs";

// cursor-cli-provider-config.mjs
import { isAbsolute } from "node:path";
var fields = /* @__PURE__ */ new Set(["kind", "nodePath", "entrypoint", "baseUrl", "apiKeyFile"]);
function normalizeCliProvider(value) {
  const invalid = () => Object.assign(new Error("Invalid local CLI provider; use openai-responses, absolute node/entrypoint/key-file paths and an HTTPS base URL"), { code: "CURSOR_CLI_PROVIDER_CONFIG_INVALID" });
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.has(key)) || value.kind !== "openai-responses") throw invalid();
  for (const key of ["nodePath", "entrypoint", "apiKeyFile"]) if (typeof value[key] !== "string" || !isAbsolute(value[key]) || /[\r\n\0]/.test(value[key])) throw invalid();
  let url;
  try {
    url = new URL(value.baseUrl);
  } catch {
    throw invalid();
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw invalid();
  return {
    kind: value.kind,
    nodePath: value.nodePath,
    entrypoint: value.entrypoint,
    baseUrl: url.href.replace(/\/+$/, ""),
    apiKeyFile: value.apiKeyFile
  };
}

// cursor-cli-provider-preload.mjs
var MAX_EVENT = 4 * 1024 * 1024;
function createProviderFetch(config, { key, fetchImpl, record }) {
  const provider = normalizeCliProvider(config.provider);
  const modelsUrl = `${provider.baseUrl}/models`, responsesUrl = `${provider.baseUrl}/responses`;
  let blocked = false;
  const reject = (code, status = 400) => {
    blocked = true;
    record({ stage: "provider_error", code });
    return Response.json({ error: { type: "invalid_request_error", code, message: "Local provider request refused; inspect Bridge diagnostics" } }, { status });
  };
  return async (input, init) => {
    if (blocked) return reject("local_provider_blocked");
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${key}`);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(config.requestTimeoutMs ?? 12e4)]);
    if (request.method === "GET" && request.url === modelsUrl) {
      let response2;
      try {
        response2 = await fetchImpl(modelsUrl, { method: "GET", headers, signal, redirect: "error" });
      } catch {
        return reject("provider_catalogue_unreachable");
      }
      if (!response2.ok) return reject("provider_catalogue_rejected");
      let catalogue;
      try {
        catalogue = await response2.json();
      } catch {
        return reject("provider_catalogue_invalid");
      }
      const entry = catalogue?.data?.find((model) => model.id === config.model);
      if (!entry) return reject("provider_model_unavailable");
      record({ stage: "catalogue_verified", model: config.model, effort: config.effort, protocol: "responses" });
      return Response.json({ object: "list", data: [{ id: entry.id, object: "model", api_types: ["responses"], capabilities: {
        supports_tool_use: true,
        supports_streaming: true,
        supports_reasoning: true,
        reasoning_effort: [config.effort]
      } }] });
    }
    if (request.method !== "POST" || request.url !== responsesUrl) return reject("provider_endpoint_refused");
    if (config.allowInference !== true) return reject("metadata_inference_refused");
    let body;
    try {
      body = await request.json();
    } catch {
      return reject("provider_body_invalid");
    }
    if (body.model !== config.model) return reject("provider_model_mismatch");
    if (body.reasoning?.effort && body.reasoning.effort !== config.effort) return reject("provider_effort_mismatch");
    body.reasoning = { ...body.reasoning, effort: config.effort };
    body.store = false;
    body.include = [.../* @__PURE__ */ new Set([...Array.isArray(body.include) ? body.include : [], "reasoning.encrypted_content"])];
    record({ stage: "before_send", model: body.model, effort: body.reasoning.effort, protocol: "responses", credentialSource: "local-file" });
    let response;
    try {
      response = await fetchImpl(responsesUrl, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
    } catch {
      return reject("provider_request_failed");
    }
    if (!response.ok) {
      record({ stage: "provider_error", code: "provider_rejected", status: response.status });
      blocked = true;
      return Response.json({ error: { type: "invalid_request_error", code: "provider_rejected", message: `Provider returned HTTP ${response.status}; details withheld` } }, { status: response.status });
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return reject("provider_stream_invalid");
    let buffer = "", sawCreated = false, completed = false;
    const decoder = new TextDecoder();
    const failStream = (controller, code) => {
      blocked = true;
      record({ stage: "provider_error", code });
      controller.error(new Error(code));
    };
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            return failStream(controller, "provider_event_invalid");
          }
          if (["response.created", "response.completed"].includes(event.type)) {
            const value = event.response;
            if (value?.model !== config.model || value?.reasoning?.effort !== config.effort) return failStream(controller, "provider_response_mismatch");
            if (event.type === "response.created") sawCreated = true;
            if (event.type === "response.completed") {
              if (!sawCreated || value.status !== "completed") return failStream(controller, "provider_completion_invalid");
              completed = true;
            }
            record({ stage: event.type, model: value.model, effort: value.reasoning.effort });
          }
          if (["response.failed", "response.incomplete", "error"].includes(event.type)) return failStream(controller, "provider_incomplete");
        }
        if (buffer.length > MAX_EVENT) return failStream(controller, "provider_event_too_large");
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (!completed) failStream(controller, "provider_completion_missing");
      }
    }));
    return new Response(stream, { status: response.status, headers: response.headers });
  };
}
if (process.env.CURSOR_BRIDGE_CLI_PROVIDER_CONFIG) {
  try {
    const config = JSON.parse(await readFile(process.env.CURSOR_BRIDGE_CLI_PROVIDER_CONFIG, "utf8"));
    config.provider = normalizeCliProvider(config.provider);
    if (!config.model || !["minimal", "low", "medium", "high", "xhigh", "max"].includes(config.effort)) throw new Error("invalid preference");
    if ((await stat(config.provider.apiKeyFile)).size > 65536) throw new Error("invalid credential file");
    const key = (await readFile(config.provider.apiKeyFile, "utf8")).replace(/^\uFEFF/, "").trim();
    if (!key || /\s/.test(key)) throw new Error("invalid credential");
    let count = 0;
    const record = (value) => {
      if (++count > 4096) throw new Error("provider audit limit exceeded");
      appendFileSync(config.auditFile, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 384 });
    };
    globalThis.fetch = createProviderFetch(config, { key, fetchImpl: globalThis.fetch, record });
  } catch {
    process.stderr.write("CURSOR_CLI_PROVIDER_SETUP_FAILED\n");
    process.exit(1);
  }
}
export {
  createProviderFetch
};
