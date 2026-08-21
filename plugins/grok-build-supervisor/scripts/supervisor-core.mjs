import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { listSessionCandidates, readSessionSummary, defaultSessionRoot } from "./session-catalog.mjs";
import { DurableEventJournal, MemoryEventJournal } from "./event-journal.mjs";
import {
  assertProxyEndpointReachable,
  resolveLeaderProxyContext,
  verifyLeaderProxyRoute,
} from "./proxy-environment.mjs";
import {
  initializeProxySettings,
  readProxySettings,
} from "./proxy-settings.mjs";
import {
  assertPathWithin,
  buildTuiTitle,
  buildWindowsTerminalArgs,
  listTuiStateRecords,
  readJsonFile,
  resolveWindowsTerminalPresentation,
  writeJsonAtomic,
} from "./tui-presentation.mjs";
import { inspectProcessIdentity } from "./process-identity.mjs";
import { materializeTuiRuntime } from "./runtime-snapshot.mjs";
import {
  DEFAULT_INLINE_RESULT_MAX_BYTES,
  persistResultArtifact,
  summarizeResultText,
} from "./result-artifact.mjs";

const execFileAsync = promisify(execFile);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENTS = 500;
const DEFAULT_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 25;
const MAX_EVENT_BYTES = 8 * 1024;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const INSPECT_VIEWS = new Set(["interaction", "status", "summary", "delta", "evidence"]);
const MAX_INTERACTION_WAIT_MS = 25_000;
const MAX_FINAL_TEXT_CHARS = 512 * 1024;
const DEFAULT_PROGRESS_HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_PROGRESS_TITLE_CHARS = 160;
const MAX_ACCEPTANCE_PATHS = 50;
const MAX_ACCEPTANCE_PATH_CHARS = 1_200;
const MAX_ACCEPTANCE_COMMANDS = 20;
const MAX_ACCEPTANCE_COMMAND_CHARS = 600;
export const WORKSPACE_TRUST_ACP_METHODS = Object.freeze([
  "x.ai/folder_trust/request",
  "_x.ai/folder_trust/request",
]);
const LIVE_TUI_STATUSES = new Set(["running", "awaiting_workspace_trust", "awaiting_session_registration"]);
const PENDING_TUI_STATUSES = new Set(["awaiting_workspace_trust", "awaiting_session_registration"]);
const VERIFY_TITLE_RE = /(?:\btests?\b|\btesting\b|\bchecks?\b|\bchecked\b|\bchecking\b|\bverif\w*\b|\bvalidat\w*\b|\blint\w*\b|\bdiff\s+--check\b|测试|验证|检查)/i;
const DIFF_TITLE_RE = /(?:\bgit\s+diff\b|\bdiff\b)/i;
const CRITICAL_EVENT_KINDS = new Set([
  "permission_requested",
  "elicitation_requested",
  "workspace_trust_requested",
  "prompt_failed",
  "leader_exit",
  "acp_exit",
  "registry_error",
  "result_artifact_failed",
  "session_open_failed",
]);
const SENSITIVE_FIELD_RE = /(?:^|[_-])(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:$|[_-])/i;

function isSensitiveField(fieldName) {
  const normalized = String(fieldName).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_FIELD_RE.test(normalized);
}

function compactValue(value, depth = 0, seen = new WeakSet(), fieldName = "") {
  if (fieldName && isSensitiveField(fieldName)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    const redacted = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
    return redacted.length > 4000 ? `${redacted.slice(0, 4000)}… [${redacted.length - 4000} chars truncated]` : redacted;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (depth >= 6) {
    return "[depth truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => compactValue(item, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      const compacted = compactValue(child, depth + 1, seen, key);
      if (compacted !== undefined) {
        result[key] = compacted;
      }
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

export function compactForTransport(value, maxBytes = MAX_EVENT_BYTES) {
  const compacted = compactValue(value);
  const serialized = JSON.stringify(compacted);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= maxBytes) {
    return compacted;
  }
  let low = 0;
  let high = serialized.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const preview = serialized.slice(0, middle);
    const candidate = { truncated: true, originalBytes: bytes, preview };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
      best = preview;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { truncated: true, originalBytes: bytes, preview: best };
}

export function parseLeaderPid(output) {
  if (typeof output !== "string" || output.trim() === "") {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const candidates = [
    parsed,
    parsed?.leader,
    ...(Array.isArray(parsed?.leaders) ? parsed.leaders : []),
    ...(Array.isArray(parsed) ? parsed : []),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const rawPid = candidate.pid
      ?? candidate.leaderPid
      ?? candidate.leader_pid
      ?? candidate.processId
      ?? candidate.process_id;
    const pid = Number(rawPid);
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }
  return null;
}

export function buildGrokAcpArgs({ leaderSocket }) {
  if (!isAbsolute(leaderSocket)) {
    throw new Error("leader socket must be absolute");
  }
  return [
    "--permission-mode",
    "default",
    "agent",
    "--leader",
    "--leader-socket",
    leaderSocket,
    "stdio",
  ];
}

export function agentMessageText(update) {
  if (update?.sessionUpdate !== "agent_message_chunk") {
    return "";
  }
  const content = update.content;
  return content?.type === "text" && typeof content.text === "string" ? content.text : "";
}

function runStatusFromEvent(event) {
  if (!event) {
    return null;
  }
  if (event.kind === "prompt_completed") {
    return "completed";
  }
  if (event.kind === "prompt_failed") {
    return "failed";
  }
  if (event.kind === "prompt_cancel_requested") {
    return "cancel_requested";
  }
  return event.kind === "prompt_started" ? "running" : null;
}

function interactionMessage(state) {
  return {
    idle: "No Grok session is attached.",
    ready: "Grok is ready.",
    working: "Grok is working.",
    needs_permission: "Grok needs user permission.",
    needs_input: "Grok needs input from the supervising host agent to continue.",
    needs_workspace_trust: "Grok is waiting for workspace trust confirmation in the visible terminal.",
    awaiting_session_registration: "The visible Grok terminal is open and still starting.",
    completed: "Grok completed the task.",
    failed: "Grok failed the task.",
    cancelling: "Grok cancellation is pending.",
    unknown_after_restart: "The Grok task state is unknown after Supervisor restart.",
    not_found: "The requested Grok run was not found.",
  }[state] || "Grok supervision state changed.";
}

export function normalizeHostKind(value) {
  return new Set(["codex", "claude_code"]).has(value) ? value : "unknown";
}

function supervisingHost(kind) {
  return {
    codex: { label: "Codex", subject: "Codex" },
    claude_code: { label: "Claude Code", subject: "Claude Code" },
    unknown: { label: "Host agent", subject: "the supervising host agent" },
  }[normalizeHostKind(kind)];
}

export function buildSupervisedPrompt(prompt, hostKind = "unknown") {
  const host = supervisingHost(hostKind);
  const preamble = [
    `[${host.label} supervision contract]`,
    `This task was delegated by ${host.subject} to you as the Grok coding agent. ${host.subject} remains attached as the supervising ACP client.`,
    "Use your own tools and available project evidence to investigate and resolve the task independently when they are sufficient.",
    "Communicate concise progress, material findings, and the final result through normal ACP session updates.",
    `When you need a specific fact or coordination decision that your tools cannot obtain, use ACP form elicitation to ask ${host.subject}. ${host.subject} may answer from verified context or route the question to the user when user authority is required.`,
    "Do not ask for facts your tools can obtain and do not use a permission request for ordinary communication.",
    "If ACP elicitation is unavailable, end the turn with exactly one JSON object inside <supervisor_question>...</supervisor_question> containing question, evidenceGap, and attempted fields.",
    `[/${host.label} supervision contract]`,
    "",
    "[Task]",
  ].join("\n");
  return `${preamble}\n${prompt}\n[/Task]`;
}

export function parseSupervisorQuestion(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  const match = /<supervisor_question>\s*([\s\S]*?)\s*<\/supervisor_question>\s*$/i.exec(text);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || typeof parsed.question !== "string" || !parsed.question.trim()) {
      return null;
    }
    return compactForTransport({
      question: parsed.question.trim(),
      evidenceGap: typeof parsed.evidenceGap === "string" ? parsed.evidenceGap.trim() : null,
      attempted: Array.isArray(parsed.attempted)
        ? parsed.attempted.filter((item) => typeof item === "string").slice(0, 20)
        : [],
    }, 8 * 1024);
  } catch {
    return null;
  }
}

function validateElicitationContent(schema, content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("elicitation content must be an object");
  }
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in content)) {
      throw new Error(`elicitation content is missing required field: ${key}`);
    }
  }
  const output = {};
  for (const [key, value] of Object.entries(content)) {
    const property = properties[key];
    if (!property || typeof property !== "object") {
      throw new Error(`elicitation content contains unknown field: ${key}`);
    }
    if (property.type === "string") {
      if (typeof value !== "string") {
        throw new Error(`elicitation field ${key} must be a string`);
      }
      const allowed = Array.isArray(property.enum)
        ? property.enum
        : Array.isArray(property.oneOf)
          ? property.oneOf.map((option) => option?.const).filter((item) => typeof item === "string")
          : null;
      if (allowed && !allowed.includes(value)) {
        throw new Error(`elicitation field ${key} is not one of the allowed values`);
      }
    } else if (property.type === "number" && typeof value !== "number") {
      throw new Error(`elicitation field ${key} must be a number`);
    } else if (property.type === "integer" && !Number.isInteger(value)) {
      throw new Error(`elicitation field ${key} must be an integer`);
    } else if (property.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`elicitation field ${key} must be a boolean`);
    } else if (property.type === "array") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`elicitation field ${key} must be an array of strings`);
      }
    } else if (!["string", "number", "integer", "boolean", "array"].includes(property.type)) {
      throw new Error(`elicitation field ${key} has an unsupported type`);
    }
    output[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 8 * 1024) {
    throw new Error("elicitation content exceeds the 8 KiB response limit");
  }
  return output;
}

function defaultGrokBinary() {
  if (process.env.GROK_BIN) {
    return process.env.GROK_BIN;
  }

  return join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
}

export function defaultStateRoot() {
  if (process.env.GROK_SUPERVISOR_STATE_ROOT) {
    return resolve(process.env.GROK_SUPERVISOR_STATE_ROOT);
  }
  const base = process.env.LOCALAPPDATA || join(homedir(), ".local", "state");
  return join(base, "VESPERIX", "GrokBuildSupervisor");
}

export function validateSessionId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error("sessionId must be an exact UUID, not a title or partial ID");
  }
  return value;
}

export function validateWorkingDirectory(value) {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    throw new Error("cwd must be an absolute existing directory");
  }
  const full = resolve(value);
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    throw new Error(`cwd is not an existing directory: ${full}`);
  }
  return full;
}

export function collectActiveSessions(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectActiveSessions(item, output);
    }
    return output;
  }
  if (!value || typeof value !== "object") {
    return output;
  }
  if (typeof value.session_id === "string") {
    output.push(value);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      collectActiveSessions(child, output);
    }
  }
  return output;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function inspectTerminalPresentation({ hostPid, launcherPid }) {
  const startPids = [...new Set([hostPid, launcherPid]
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (startPids.length === 0 || process.platform !== "win32") {
    return null;
  }
  const command = [
    `$startIds = @(${startPids.join(", ")})`,
    "$seen = @{}",
    "$chain = @()",
    "foreach ($startId in $startIds) {",
    "  $currentId = [int]$startId",
    "  for ($depth = 0; $depth -lt 8 -and $currentId -gt 0; $depth += 1) {",
    "    if ($seen.ContainsKey($currentId)) { break }",
    "    $seen[$currentId] = $true",
    "    $cim = Get-CimInstance Win32_Process -Filter (\"ProcessId = {0}\" -f $currentId) -ErrorAction SilentlyContinue",
    "    if ($null -eq $cim) { break }",
    "    $process = Get-Process -Id $currentId -ErrorAction SilentlyContinue",
    "    $processName = if ($null -ne $process) { $process.ProcessName } else { [IO.Path]::GetFileNameWithoutExtension([string]$cim.Name) }",
    "    $windowHandle = if ($null -ne $process) { [int64]$process.MainWindowHandle } else { [int64]0 }",
    "    $windowTitle = if ($null -ne $process) { $process.MainWindowTitle } else { '' }",
    "    $chain += [pscustomobject]@{ ProcessId = [int]$cim.ProcessId; ParentProcessId = [int]$cim.ParentProcessId; ProcessName = $processName; MainWindowHandle = $windowHandle; MainWindowTitle = $windowTitle }",
    "    if ($processName -like 'WindowsTerminal*' -and $windowHandle -ne 0) { break }",
    "    $currentId = [int]$cim.ParentProcessId",
    "  }",
    "}",
    "$terminal = $chain | Where-Object { $_.ProcessName -like 'WindowsTerminal*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "[pscustomobject]@{ Terminal = $terminal; ChainLength = @($chain).Count } | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  try {
    const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    const raw = JSON.parse(output);
    const terminal = raw.Terminal && typeof raw.Terminal === "object" ? raw.Terminal : null;
    const mainWindowHandle = Number(terminal?.MainWindowHandle) || 0;
    return {
      processId: Number(terminal?.ProcessId) || null,
      processName: typeof terminal?.ProcessName === "string" ? terminal.ProcessName : null,
      mainWindowHandle,
      mainWindowTitle: typeof terminal?.MainWindowTitle === "string" ? terminal.MainWindowTitle : "",
      visible: mainWindowHandle !== 0,
      evidence: mainWindowHandle !== 0
        ? "visible_windows_terminal_ancestor"
        : "no_visible_windows_terminal_ancestor",
      inspectedHostPid: Number.isInteger(hostPid) ? hostPid : null,
      inspectedLauncherPid: Number.isInteger(launcherPid) ? launcherPid : null,
      chainLength: Number(raw.ChainLength) || 0,
    };
  } catch {
    return null;
  }
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const canonical = (value) => {
    const normalized = resolve(value);
    try {
      return realpathSync.native(normalized);
    } catch {
      return normalized;
    }
  };
  const normalizedLeft = canonical(left);
  const normalizedRight = canonical(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function conciseError(error) {
  if (error instanceof Error) {
    const parts = [error.message];
    if (typeof error.stderr === "string" && error.stderr.trim()) {
      parts.push(error.stderr.trim());
    }
    if (typeof error.stdout === "string" && error.stdout.trim()) {
      parts.push(error.stdout.trim());
    }
    return parts.join(" | ");
  }
  return String(error);
}

function codedError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export function buildAcpClientCapabilities({ interactiveWorkspaceTrust = false } = {}) {
  const capabilities = { elicitation: { form: {} } };
  if (interactiveWorkspaceTrust) {
    capabilities._meta = {
      "x.ai/folderTrust": { interactive: true },
    };
  }
  return capabilities;
}

export function parseWorkspaceTrustRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace trust request must be an object");
  }
  const sessionId = validateSessionId(value.sessionId);
  const cwd = validateWorkingDirectory(value.cwd);
  if (typeof value.workspace !== "string" || value.workspace.trim() === "" || !isAbsolute(value.workspace)) {
    throw new Error("workspace trust request workspace must be an absolute path");
  }
  const workspace = resolve(value.workspace);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`workspace trust request workspace is not an existing directory: ${workspace}`);
  }
  if (!Array.isArray(value.configKinds)
    || value.configKinds.length > 32
    || value.configKinds.some((item) => typeof item !== "string" || item.length < 1 || item.length > 64)) {
    throw new Error("workspace trust request configKinds must be a bounded array of strings");
  }
  return {
    sessionId,
    cwd,
    workspace,
    configKinds: [...new Set(value.configKinds)],
  };
}

export function parseWorkspaceTrustGatewayRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace trust gateway request must be an object");
  }
  if (value.method !== WORKSPACE_TRUST_ACP_METHODS[0]) {
    throw new Error("workspace trust gateway request must name the logical folder-trust method");
  }
  return parseWorkspaceTrustRequest(value.params);
}

function compactProgressTitle(value) {
  if (typeof value !== "string") {
    return null;
  }
  const compacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!compacted) {
    return null;
  }
  return compacted.length > MAX_PROGRESS_TITLE_CHARS
    ? `${compacted.slice(0, MAX_PROGRESS_TITLE_CHARS - 1)}…`
    : compacted;
}

function boundedUniqueStrings(values, { limit, maxChars, itemMaxChars }) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const compacted = value.replace(/\s+/g, " ").trim();
    if (!compacted || seen.has(compacted)) {
      continue;
    }
    seen.add(compacted);
    unique.push(compacted);
  }
  const result = [];
  let chars = 0;
  for (const compacted of unique) {
    const bounded = compacted.length > itemMaxChars
      ? `${compacted.slice(0, itemMaxChars - 1)}…`
      : compacted;
    if (result.length >= limit || chars + bounded.length > maxChars) {
      break;
    }
    result.push(bounded);
    chars += bounded.length;
  }
  return {
    values: result,
    truncated: result.length < unique.length,
  };
}

export function progressPhaseForToolCall(toolCall = {}) {
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : "other";
  const title = String(toolCall.title || "").toLowerCase();
  if (["edit", "delete", "move"].includes(kind)) {
    return "modifying";
  }
  if (["read", "search", "fetch"].includes(kind)) {
    return "locating";
  }
  if (kind === "execute") {
    if (VERIFY_TITLE_RE.test(title)) {
      return "verifying";
    }
    return DIFF_TITLE_RE.test(title) ? "locating" : "executing";
  }
  if (["think", "switch_mode"].includes(kind)) {
    return "planning";
  }
  if (VERIFY_TITLE_RE.test(title)) {
    return "verifying";
  }
  if (/(?:edit|write|modify|patch|delete|move|修改|写入|删除|移动)/i.test(title)) {
    return "modifying";
  }
  if (/(?:read|search|find|locat|inspect|读取|搜索|查找|定位)/i.test(title)) {
    return "locating";
  }
  if (DIFF_TITLE_RE.test(title)) {
    return "locating";
  }
  return "working";
}

function progressMessage(progress) {
  const title = progress.current?.title;
  const suffix = title ? ` ${title}` : "";
  switch (progress.phase) {
    case "starting":
      return "Starting: preparing the delegated task.";
    case "planning":
      return `Planning:${suffix || " deciding the next bounded step"}.`;
    case "locating":
      return `Locating: ${progress.filesRead.size} file${progress.filesRead.size === 1 ? "" : "s"} inspected.${suffix}`.trim();
    case "modifying":
      return `Modifying: ${progress.filesChanged.size} file${progress.filesChanged.size === 1 ? "" : "s"} touched.${suffix}`.trim();
    case "verifying":
      return `Verifying:${suffix || " running targeted checks"}.`;
    case "executing":
      return `Executing:${suffix || " running the current project step"}.`;
    case "completed":
      return "Completed.";
    case "failed":
      return "Failed: see the terminal result.";
    default:
      return `Working:${suffix || " progressing through the task"}.`;
  }
}

function runProgressSnapshot(run, { includeAcceptance = run?.status !== "running" } = {}) {
  if (!run?.progress) {
    return null;
  }
  const progress = run.progress;
  const toolCalls = [...run.toolCalls.values()];
  const snapshot = {
    phase: progress.phase,
    message: progressMessage(progress),
    filesRead: progress.filesRead.size,
    filesChanged: progress.filesChanged.size,
    toolCalls: {
      total: toolCalls.length,
      completed: toolCalls.filter((toolCall) => toolCall.status === "completed").length,
      failed: toolCalls.filter((toolCall) => toolCall.status === "failed").length,
    },
    current: progress.current ? {
      kind: progress.current.kind || "other",
      title: progress.current.title,
      status: progress.current.status || null,
    } : null,
    updatedAt: progress.updatedAt,
    heartbeatAt: progress.heartbeatAt,
    responseChars: run.totalMessageChars,
    messageCount: run.messageCount || 0,
    lastChunkAt: progress.lastChunkAt,
  };
  if (!includeAcceptance) {
    return snapshot;
  }
  const changedFiles = boundedUniqueStrings([...progress.filesChanged], {
    limit: MAX_ACCEPTANCE_PATHS,
    maxChars: MAX_ACCEPTANCE_PATH_CHARS,
    itemMaxChars: 500,
  });
  const commandsRun = boundedUniqueStrings(
    toolCalls.filter((toolCall) => toolCall.kind === "execute").map((toolCall) => toolCall.title),
    {
      limit: MAX_ACCEPTANCE_COMMANDS,
      maxChars: MAX_ACCEPTANCE_COMMAND_CHARS,
      itemMaxChars: MAX_PROGRESS_TITLE_CHARS,
    },
  );
  return {
    ...snapshot,
    changedFiles: changedFiles.values,
    changedFilesTruncated: changedFiles.truncated || progress.filesChanged.size > changedFiles.values.length,
    commandsRun: commandsRun.values,
    commandsRunTruncated: commandsRun.truncated,
    needsHostVerification: true,
  };
}

function capabilitySnapshot(commands) {
  const descriptors = (Array.isArray(commands) ? commands : [])
    .filter((command) => command && typeof command.name === "string")
    .map((command) => ({
      name: command.name,
      description: typeof command.description === "string" ? command.description : "",
      inputHint: typeof command.input?.hint === "string" ? command.input.hint : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const entryHashes = new Map(descriptors.map((descriptor) => [
    descriptor.name,
    createHash("sha256").update(JSON.stringify(descriptor)).digest("hex"),
  ]));
  return {
    hash: createHash("sha256").update(JSON.stringify(descriptors)).digest("hex"),
    count: descriptors.length,
    entryHashes,
  };
}

function eventDigest(event) {
  const digest = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: event.kind,
  };
  const candidate = event.message ?? event.error ?? event.result ?? event.update ?? event.text;
  if (candidate !== undefined) {
    const serialized = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
    digest.preview = serialized.length > 700 ? `${serialized.slice(0, 700)}…` : serialized;
  }
  for (const key of ["runId", "sessionId", "permissionId", "elicitationId", "trustRequestId", "toolTitle", "action", "pid", "code", "signal"]) {
    if (event[key] !== undefined) {
      digest[key] = event[key];
    }
  }
  return digest;
}

export function summarizeEvents(events, stream) {
  const counts = {};
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] || 0) + 1;
  }
  const critical = events
    .filter((event) => CRITICAL_EVENT_KINDS.has(event.kind))
    .slice(-10)
    .map((event) => compactForTransport(event, 2048));
  return {
    authority: "SUPERVISOR_DERIVED",
    sequenceRange: events.length
      ? { from: events[0].sequence, to: events.at(-1).sequence }
      : null,
    eventCount: events.length,
    counts,
    latest: events.slice(-8).map(eventDigest),
    critical,
    evidenceRefs: events.slice(-20).map((event) => ({
      sequence: event.sequence,
      timestamp: event.timestamp,
      kind: event.kind,
    })),
    cursorGap: stream.cursorGap,
    verificationRequired: true,
  };
}

export function deriveRecoveryState(events) {
  const terminalRuns = new Set(events
    .filter((event) => new Set(["prompt_completed", "prompt_failed", "prompt_cancel_requested"]).has(event.kind))
    .map((event) => event.runId)
    .filter(Boolean));
  const interruptedRun = [...events].reverse()
    .find((event) => event.kind === "prompt_started" && event.runId && !terminalRuns.has(event.runId));
  const answeredPermissions = new Set(events
    .filter((event) => event.kind === "permission_answered")
    .map((event) => event.permissionId));
  const orphanedPermissions = events
    .filter((event) => event.kind === "permission_requested" && !answeredPermissions.has(event.permissionId))
    .slice(-20)
    .map((event) => ({
      permissionId: event.permissionId,
      sessionId: event.sessionId,
      toolTitle: event.toolTitle,
      requestedAt: event.requestedAt,
      status: "orphaned_after_restart",
    }));
  const answeredElicitations = new Set(events
    .filter((event) => event.kind === "elicitation_answered")
    .map((event) => event.elicitationId));
  const orphanedElicitations = events
    .filter((event) => event.kind === "elicitation_requested" && !answeredElicitations.has(event.elicitationId))
    .slice(-20)
    .map((event) => ({
      elicitationId: event.elicitationId,
      sessionId: event.sessionId,
      message: event.message,
      requestedAt: event.requestedAt,
      status: "orphaned_after_restart",
    }));
  const resolvedWorkspaceTrust = new Set(events
    .filter((event) => event.kind === "workspace_trust_resolved")
    .map((event) => event.trustRequestId));
  const orphanedWorkspaceTrust = events
    .filter((event) => event.kind === "workspace_trust_requested" && !resolvedWorkspaceTrust.has(event.trustRequestId))
    .slice(-20)
    .map((event) => ({
      trustRequestId: event.trustRequestId,
      sessionId: event.sessionId,
      cwd: event.cwd,
      workspace: event.workspace,
      configKinds: event.configKinds,
      requestedAt: event.requestedAt,
      status: "orphaned_after_restart",
    }));
  return {
    interruptedRun: interruptedRun ? {
      runId: interruptedRun.runId,
      sessionId: interruptedRun.sessionId,
      startedAt: interruptedRun.timestamp,
      status: "unknown_after_restart",
    } : null,
    orphanedPermissions,
    orphanedElicitations,
    orphanedWorkspaceTrust,
  };
}

export class GrokSupervisor {
  constructor(options = {}) {
    this.grokBinary = options.grokBinary || defaultGrokBinary();
    this.stateRoot = options.stateRoot || defaultStateRoot();
    this.leaderOwnershipPath = options.leaderOwnershipPath || join(this.stateRoot, "leader-owner.json");
    this.socketPathExplicit = typeof options.socketPath === "string" && options.socketPath.length > 0;
    let recordedSocketPath = null;
    if (!this.socketPathExplicit) {
      const recordedOwnership = readJsonFile(this.leaderOwnershipPath);
      if (recordedOwnership?.schemaVersion === 1 && typeof recordedOwnership.socketPath === "string") {
        try {
          recordedSocketPath = assertPathWithin(this.stateRoot, recordedOwnership.socketPath, "Recorded Leader socket path");
        } catch {
          recordedSocketPath = null;
        }
      }
    }
    this.socketPath = options.socketPath || recordedSocketPath || join(this.stateRoot, "leader.sock");
    this.sessionRoot = options.sessionRoot || defaultSessionRoot();
    this.tuiStateRoot = options.tuiStateRoot || join(this.stateRoot, "tuis");
    this.tuiRuntime = options.tuiRuntime || (options.persistTuiRuntime === true
      ? materializeTuiRuntime({ sourceDirectory: MODULE_DIRECTORY, stateRoot: this.stateRoot })
      : null);
    this.tuiLauncherScript = options.tuiLauncherScript
      || this.tuiRuntime?.launcherScript
      || join(MODULE_DIRECTORY, "Start-GrokTui.ps1");
    this.tuiHostScript = options.tuiHostScript
      || this.tuiRuntime?.hostScript
      || join(MODULE_DIRECTORY, "tui-host.mjs");
    this.nodeBinary = options.nodeBinary || process.execPath;
    this.spawnProcess = options.spawnProcess || spawn;
    this.proxyPolicy = options.proxyPolicy || process.env.GROK_SUPERVISOR_PROXY_POLICY || "required";
    this.proxySettingsPath = options.proxySettingsPath || join(this.stateRoot, "proxy-settings.json");
    this.resultArtifactRoot = options.resultArtifactRoot || join(this.stateRoot, "results");
    this.inlineResultMaxBytes = options.inlineResultMaxBytes ?? DEFAULT_INLINE_RESULT_MAX_BYTES;
    this.persistResultArtifact = options.persistResultArtifact || persistResultArtifact;
    this.readProxySettings = options.readProxySettings || readProxySettings;
    this.initializeProxySettings = options.initializeProxySettings || initializeProxySettings;
    this.resolveProxyContext = options.resolveProxyContext || ((resolveOptions = {}) => resolveLeaderProxyContext({
      baseEnvironment: process.env,
      policy: this.proxyPolicy,
      proxySettings: this.readProxySettings(this.proxySettingsPath),
      ...resolveOptions,
    }));
    this.probeProxyEndpoint = options.probeProxyEndpoint || assertProxyEndpointReachable;
    this.verifyProxyRoute = options.verifyProxyRoute || verifyLeaderProxyRoute;
    this.resolveTerminalPresentation = options.resolveTerminalPresentation || resolveWindowsTerminalPresentation;
    this.inspectTerminalPresentation = options.inspectTerminalPresentation || inspectTerminalPresentation;
    this.inspectProcessIdentity = options.inspectProcessIdentity || inspectProcessIdentity;
    this.tuiLaunchTimeoutMs = options.tuiLaunchTimeoutMs ?? 15000;
    this.tuiPollIntervalMs = options.tuiPollIntervalMs ?? 100;
    this.instanceId = options.instanceId || randomUUID();
    this.journalError = null;
    if (options.eventJournal) {
      this.journal = options.eventJournal;
    } else if (options.durableEvents === false) {
      this.journal = new MemoryEventJournal({ maxRecentEvents: MAX_EVENTS });
    } else {
      try {
        this.journal = new DurableEventJournal({
          root: options.journalRoot || join(this.stateRoot, "journal"),
          maxRecentEvents: MAX_EVENTS,
          maxSegmentEvents: options.maxSegmentEvents,
          maxSegmentBytes: options.maxSegmentBytes,
        });
      } catch (error) {
        this.journalError = conciseError(error);
        this.journal = new MemoryEventJournal({ maxRecentEvents: MAX_EVENTS });
      }
    }
    this.leaderProcess = null;
    this.leaderCwd = null;
    this.leaderProxyContext = null;
    this.leaderProxyRoute = null;
    this.proxyInitialization = null;
    this.tuiProcesses = new Map();
    this.acpProcess = null;
    this.acpConnection = null;
    this.acpContext = null;
    this.attachedSessionId = null;
    this.attachedCwd = null;
    this.events = this.journal.recentEvents;
    this.nextSequence = this.journal.nextSequence;
    this.pendingPermissions = new Map();
    this.pendingElicitations = new Map();
    this.pendingWorkspaceTrust = new Map();
    this.tuiActivationMonitors = new Map();
    this.pendingAttachCwd = null;
    this.activeRun = null;
    this.availableCommandsSnapshots = new Map();
    this.inactiveRunActivity = new Map();
    this.progressHeartbeatIntervalMs = Math.max(1, Number(options.progressHeartbeatIntervalMs) || DEFAULT_PROGRESS_HEARTBEAT_INTERVAL_MS);
    this.changeWaiters = new Set();
    this.stderrTail = [];
    this.recovery = deriveRecoveryState(this.events);
  }

  proxyConfigurationView() {
    const settings = this.readProxySettings(this.proxySettingsPath);
    if (!settings) {
      return {
        initialized: false,
        settingsPath: this.proxySettingsPath,
        reinitializable: true,
      };
    }
    return {
      initialized: true,
      settingsPath: this.proxySettingsPath,
      source: settings.source,
      endpoint: {
        protocol: settings.proxy.protocol,
        host: settings.proxy.host,
        port: settings.proxy.port,
      },
      verification: settings.verification,
      verifiedAt: settings.verifiedAt,
      updatedAt: settings.updatedAt,
      reinitializable: true,
    };
  }

  async initializeProxy(params = {}) {
    if (this.proxyInitialization) {
      throw codedError("GROK_INIT_BUSY", "Another Grok proxy initialization is already running");
    }
    const previous = this.proxyConfigurationView();
    const initialization = this.initializeProxySettings({
      settingsPath: this.proxySettingsPath,
      proxyUrl: params.proxyUrl,
    });
    this.proxyInitialization = initialization;
    try {
      const result = await initialization;
      if (result.initialized) {
        this.leaderProxyContext = null;
        this.leaderProxyRoute = null;
        this.record("proxy_initialized", {
          endpoint: {
            host: result.proxy.host,
            port: result.proxy.port,
            protocol: result.proxy.protocol,
          },
          source: result.source,
          verifiedAt: result.verifiedAt,
        });
      }
      return {
        ...result,
        previousConfiguration: previous,
        proxyConfiguration: this.proxyConfigurationView(),
      };
    } finally {
      this.proxyInitialization = null;
    }
  }

  record(kind, data = {}) {
    let event;
    try {
      event = this.journal.append(kind, compactForTransport(data));
    } catch (error) {
      const previous = this.journal;
      this.journalError = conciseError(error);
      const fallback = new MemoryEventJournal({ maxRecentEvents: MAX_EVENTS });
      fallback.recentEvents = [...previous.recentEvents].slice(-MAX_EVENTS);
      fallback.nextSequence = Math.max(previous.nextSequence || 1, fallback.recentEvents.at(-1)?.sequence + 1 || 1);
      this.journal = fallback;
      event = this.journal.append("journal_write_failed", {
        attemptedKind: kind,
        message: compactForTransport(this.journalError, 2048),
      });
    }
    this.events = this.journal.recentEvents;
    this.nextSequence = this.journal.nextSequence;
    for (const resolveWaiter of this.changeWaiters) {
      resolveWaiter(event);
    }
    this.changeWaiters.clear();
    return event;
  }

  waitForRecordedChange(timeoutMs) {
    return new Promise((resolveChange) => {
      let settled = false;
      const finish = (event = null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.changeWaiters.delete(finish);
        resolveChange(event);
      };
      const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
      this.changeWaiters.add(finish);
    });
  }

  recordRunProgress(run, { heartbeat = false } = {}) {
    if (!run?.progress) {
      return null;
    }
    run.progress.heartbeatAt = new Date().toISOString();
    const event = this.record("run_progress", {
      sessionId: run.sessionId,
      runId: run.runId,
      heartbeat,
      ...runProgressSnapshot(run),
    });
    run.progress.dirtySinceLastRecord = false;
    return event;
  }

  startRunProgressHeartbeat(run) {
    this.stopRunProgressHeartbeat(run);
    run.progressTimer = setInterval(() => {
      if (run.status !== "running") {
        this.stopRunProgressHeartbeat(run);
        return;
      }
      run.progress.heartbeatAt = new Date().toISOString();
      if (run.progress.dirtySinceLastRecord) {
        this.recordRunProgress(run, { heartbeat: true });
      }
    }, this.progressHeartbeatIntervalMs);
    run.progressTimer.unref?.();
  }

  stopRunProgressHeartbeat(run) {
    if (run?.progressTimer) {
      clearInterval(run.progressTimer);
      run.progressTimer = null;
    }
  }

  updateRunProgress(sessionId, update) {
    const run = this.activeRun;
    if (!run || run.status !== "running" || run.sessionId !== sessionId || !update) {
      return null;
    }
    const updateKind = update.sessionUpdate;
    if (updateKind === "tool_call" || updateKind === "tool_call_update") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;
      if (!toolCallId) {
        return null;
      }
      const previous = run.toolCalls.get(toolCallId) || { toolCallId };
      const current = {
        ...previous,
        ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
        ...(typeof update.title === "string" ? { title: compactProgressTitle(update.title) } : {}),
        ...(typeof update.status === "string" ? { status: update.status } : {}),
        ...(Array.isArray(update.locations) ? { locations: update.locations } : {}),
      };
      run.toolCalls.set(toolCallId, current);
      const phase = progressPhaseForToolCall(current);
      for (const location of current.locations || []) {
        if (typeof location?.path !== "string") {
          continue;
        }
        if (["edit", "delete", "move"].includes(current.kind)) {
          run.progress.filesChanged.add(location.path);
        } else if (["read", "search", "fetch"].includes(current.kind)) {
          run.progress.filesRead.add(location.path);
        }
      }
      const phaseChanged = phase !== run.progress.phase;
      run.progress.phase = phase;
      run.progress.current = {
        kind: current.kind || "other",
        title: current.title || null,
        status: current.status || null,
      };
      run.progress.updatedAt = new Date().toISOString();
      run.progress.dirtySinceLastRecord = true;
      return phaseChanged || current.status === "failed"
        ? this.recordRunProgress(run)
        : null;
    }
    if (updateKind === "plan") {
      const currentEntry = Array.isArray(update.entries)
        ? update.entries.find((entry) => entry?.status === "in_progress") || update.entries.find((entry) => entry?.status === "pending")
        : null;
      if (!currentEntry) {
        return null;
      }
      const title = compactProgressTitle(currentEntry.content);
      const inferredPhase = progressPhaseForToolCall({ title });
      const phase = inferredPhase === "working" ? "planning" : inferredPhase;
      const phaseChanged = phase !== run.progress.phase;
      run.progress.phase = phase;
      run.progress.current = { kind: "plan", title, status: currentEntry.status || null };
      run.progress.updatedAt = new Date().toISOString();
      run.progress.dirtySinceLastRecord = true;
      return phaseChanged ? this.recordRunProgress(run) : null;
    }
    return null;
  }

  recordInactiveRunActivity(sessionId, update) {
    const relatedRun = this.activeRun?.sessionId === sessionId ? this.activeRun : null;
    const runId = relatedRun?.runId || null;
    const key = `${sessionId}:${runId || "none"}`;
    const previous = this.inactiveRunActivity.get(key) || { count: 0, lastRecordedCount: 0 };
    const count = previous.count + 1;
    const status = typeof update?.status === "string" ? update.status : null;
    const terminalToolUpdate = status === "completed" || status === "failed";
    const shouldRecord = count === 1 || terminalToolUpdate || count - previous.lastRecordedCount >= 10;
    this.inactiveRunActivity.set(key, {
      count,
      lastRecordedCount: shouldRecord ? count : previous.lastRecordedCount,
    });
    if (!shouldRecord) {
      return null;
    }
    return this.record("inactive_run_activity", {
      sessionId,
      runId,
      runStatus: relatedRun?.status || "missing",
      count,
      updateKind: typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "unknown",
      toolCallId: typeof update?.toolCallId === "string" ? update.toolCallId : null,
      toolKind: typeof update?.kind === "string" ? update.kind : null,
      toolTitle: compactProgressTitle(update?.title),
      toolStatus: status,
      payloadSuppressed: true,
    });
  }

  handleAvailableCommandsUpdate(sessionId, commands) {
    const next = capabilitySnapshot(commands);
    const previous = this.availableCommandsSnapshots.get(sessionId);
    if (previous?.hash === next.hash) {
      return null;
    }
    const previousEntries = previous?.entryHashes || new Map();
    const added = [...next.entryHashes.keys()].filter((name) => !previousEntries.has(name));
    const removed = [...previousEntries.keys()].filter((name) => !next.entryHashes.has(name));
    const changed = [...next.entryHashes.entries()]
      .filter(([name, hash]) => previousEntries.has(name) && previousEntries.get(name) !== hash)
      .map(([name]) => name);
    this.availableCommandsSnapshots.set(sessionId, next);
    return this.record("available_commands_changed", {
      sessionId,
      hash: next.hash,
      previousHash: previous?.hash || null,
      count: next.count,
      addedCount: added.length,
      removedCount: removed.length,
      changedCount: changed.length,
      added: added.slice(0, 20),
      removed: removed.slice(0, 20),
      changed: changed.slice(0, 20),
      addedTruncated: added.length > 20,
      removedTruncated: removed.length > 20,
      changedTruncated: changed.length > 20,
      payloadSuppressed: true,
    });
  }

  async runGrok(args, options = {}) {
    const result = await execFileAsync(this.grokBinary, args, {
      cwd: options.cwd,
      windowsHide: true,
      timeout: options.timeout ?? 10000,
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr?.trim() || "",
    };
  }

  readActiveSessions() {
    const registry = join(process.env.GROK_HOME || join(homedir(), ".grok"), "active_sessions.json");
    if (!existsSync(registry)) {
      return [];
    }
    try {
      return collectActiveSessions(JSON.parse(readFileSync(registry, "utf8")));
    } catch (error) {
      this.record("registry_error", { message: conciseError(error) });
      return [];
    }
  }

  leaderLockPath() {
    return this.socketPath.toLowerCase().endsWith(".sock")
      ? `${this.socketPath.slice(0, -5)}.lock`
      : `${this.socketPath}.lock`;
  }

  readLeaderLockPid() {
    const lockPath = this.leaderLockPath();
    if (!existsSync(lockPath)) {
      return null;
    }
    try {
      const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  readLeaderOwnership() {
    const ownershipPath = assertPathWithin(this.stateRoot, this.leaderOwnershipPath, "Leader ownership path");
    const record = readJsonFile(ownershipPath);
    if (!record || record.schemaVersion !== 1) {
      return { valid: false, record: null, reason: "missing_or_invalid_record" };
    }
    if (!UUID_RE.test(record.ownerToken || "") || !Number.isInteger(record.leaderPid)) {
      return { valid: false, record, reason: "invalid_identity" };
    }
    if (typeof record.socketPath !== "string" || !samePath(record.socketPath, this.socketPath)) {
      return { valid: false, record, reason: "socket_mismatch" };
    }
    const lockPid = this.readLeaderLockPid();
    if (!processIsAlive(record.leaderPid)) {
      return { valid: false, record, reason: "leader_process_not_alive" };
    }
    if (lockPid !== null) {
      return lockPid === record.leaderPid
        ? { valid: true, record, reason: "verified_lock_pid" }
        : { valid: false, record, reason: "lock_pid_mismatch" };
    }
    if (!existsSync(this.leaderLockPath()) || typeof record.processFingerprint !== "string") {
      return { valid: false, record, reason: "unreadable_lock_without_fingerprint" };
    }
    const identity = this.inspectProcessIdentity(record.leaderPid);
    if (!identity || identity.fingerprint !== record.processFingerprint) {
      return { valid: false, record, reason: "process_fingerprint_mismatch" };
    }
    return { valid: true, record, reason: "verified_process_fingerprint" };
  }

  writeLeaderOwnership({ leaderPid, cwd, proxy = null }) {
    const ownershipPath = assertPathWithin(this.stateRoot, this.leaderOwnershipPath, "Leader ownership path");
    const identity = this.inspectProcessIdentity(leaderPid);
    if (process.platform === "win32" && !identity) {
      throw new Error(`Could not capture a durable process identity for Leader PID ${leaderPid}`);
    }
    const record = {
      schemaVersion: 1,
      ownerToken: randomUUID(),
      leaderPid,
      cwd,
      socketPath: this.socketPath,
      processFingerprint: identity?.fingerprint ?? null,
      processName: identity?.name ?? null,
      processCreatedAt: identity?.createdAt ?? null,
      executablePath: identity?.executablePath ?? null,
      proxy: proxy ? {
        configured: proxy.configured === true,
        policy: proxy.policy,
        source: proxy.source,
        endpoint: proxy.endpoint,
        fingerprint: proxy.fingerprint,
      } : null,
      createdByInstanceId: this.instanceId,
      createdAt: new Date().toISOString(),
    };
    writeJsonAtomic(ownershipPath, record);
    return record;
  }

  clearLeaderOwnership(expectedPid = null) {
    const ownershipPath = assertPathWithin(this.stateRoot, this.leaderOwnershipPath, "Leader ownership path");
    const record = readJsonFile(ownershipPath);
    if (expectedPid && record?.leaderPid !== expectedPid) {
      return false;
    }
    if (existsSync(ownershipPath)) {
      unlinkSync(ownershipPath);
    }
    return true;
  }

  removeStaleOwnedLock() {
    const lockPath = resolve(this.leaderLockPath());
    const ownedRoot = `${resolve(this.stateRoot)}${process.platform === "win32" ? "\\" : "/"}`;
    const comparisonPath = process.platform === "win32" ? lockPath.toLowerCase() : lockPath;
    const comparisonRoot = process.platform === "win32" ? ownedRoot.toLowerCase() : ownedRoot;
    if (!comparisonPath.startsWith(comparisonRoot)) {
      throw new Error(`Refusing to remove lock outside plugin state root: ${lockPath}`);
    }
    const pid = this.readLeaderLockPid();
    if (pid && processIsAlive(pid)) {
      return false;
    }
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
      this.record("stale_leader_lock_removed", { lockPath, pid });
    }
    return true;
  }

  prepareLeaderSocketForStart() {
    const ownership = this.readLeaderOwnership();
    if (this.socketPathExplicit || ownership.valid) {
      return { rotated: false, socketPath: this.socketPath, reason: ownership.reason };
    }
    const recordedPid = ownership.record?.leaderPid;
    if (Number.isInteger(recordedPid) && processIsAlive(recordedPid)) {
      throw new Error(`Leader ownership record is invalid for live PID ${recordedPid} (${ownership.reason}); refusing to replace or bypass it`);
    }

    const previousSocketPath = this.socketPath;
    this.removeStaleOwnedLock();
    this.clearLeaderOwnership(Number.isInteger(recordedPid) ? recordedPid : null);
    this.socketPath = join(this.stateRoot, `leader-${randomUUID()}.sock`);
    this.record("leader_socket_rotated", {
      previousSocketPath,
      socketPath: this.socketPath,
      reason: ownership.reason,
    });
    return {
      rotated: true,
      previousSocketPath,
      socketPath: this.socketPath,
      reason: ownership.reason,
    };
  }

  async leaderInfo() {
    try {
      const result = await this.runGrok(["leader", "--leader-socket", this.socketPath, "info", "--json"]);
      const output = result.stdout || result.stderr;
      const pid = parseLeaderPid(output);
      if (!pid) {
        this.captureDiagnostic("leader_info_json", output);
      }
      return {
        running: true,
        socketPath: this.socketPath,
        pid,
        source: "grok_leader_info_json",
      };
    } catch (error) {
      if (this.leaderProcess?.pid && processIsAlive(this.leaderProcess.pid) && existsSync(this.leaderLockPath())) {
        return {
          running: true,
          socketPath: this.socketPath,
          pid: this.leaderProcess.pid,
          source: "owned_process_and_lock",
          detail: "The installed Windows build keeps leader.lock exclusively open and leader info does not resolve the custom socket; owned PID and lock are both live.",
        };
      }
      const lockPid = this.readLeaderLockPid();
      if (lockPid && processIsAlive(lockPid)) {
        return {
          running: true,
          socketPath: this.socketPath,
          pid: lockPid,
          source: "live_lock_fallback",
          detail: "Installed Grok build did not report the custom socket through leader info; live lock PID verified.",
        };
      }
      const ownership = this.readLeaderOwnership();
      if (ownership.valid) {
        return {
          running: true,
          socketPath: this.socketPath,
          pid: ownership.record.leaderPid,
          source: ownership.reason,
          detail: "Installed Grok build keeps leader.lock exclusively open; durable process identity verified.",
        };
      }
      return {
        running: false,
        socketPath: this.socketPath,
        detail: compactForTransport(conciseError(error), 4096),
        lockPid,
      };
    }
  }

  workspaceTrustSummaries() {
    return [...this.pendingWorkspaceTrust.values()].map((entry) => entry.summary);
  }

  workspaceTrustForSession(sessionId) {
    return this.workspaceTrustSummaries().find((entry) => entry.sessionId === sessionId) || null;
  }

  readyRecordedTui(sessionId, cwd) {
    const ownership = this.readLeaderOwnership();
    if (!ownership.valid) {
      return null;
    }
    const activeSessions = this.readActiveSessions();
    const record = [...listTuiStateRecords(this.tuiStateRoot)].reverse().find(({ value }) => {
      if (value.status !== "running"
        || value.sessionId !== sessionId
        || typeof value.cwd !== "string"
        || !samePath(value.cwd, cwd)
        || value.leaderOwnerToken !== ownership.record.ownerToken) {
        return false;
      }
      const assessment = this.assessRecordedTui(value, activeSessions, ownership);
      return assessment.processAlive && assessment.activeRegistryMatch;
    });
    return record || null;
  }

  handleWorkspaceTrustRequest(params) {
    const expectedCwd = this.pendingAttachCwd || this.attachedCwd;
    if (expectedCwd && !samePath(params.cwd, expectedCwd)) {
      this.record("workspace_trust_rejected", {
        sessionId: params.sessionId,
        cwd: params.cwd,
        workspace: params.workspace,
        reason: "request cwd does not match the ACP attachment",
      });
      return { outcome: "reject" };
    }
    if (this.readyRecordedTui(params.sessionId, params.cwd)) {
      this.record("workspace_trust_already_confirmed", {
        sessionId: params.sessionId,
        cwd: params.cwd,
        workspace: params.workspace,
      });
      return { outcome: "trust" };
    }
    const existing = [...this.pendingWorkspaceTrust.values()].find((entry) =>
      samePath(entry.summary.workspace, params.workspace));
    if (existing) {
      return new Promise((resolveTrust) => {
        existing.resolvers.push(resolveTrust);
      });
    }
    const trustRequestId = randomUUID();
    const summary = {
      trustRequestId,
      sessionId: params.sessionId,
      cwd: params.cwd,
      workspace: params.workspace,
      configKinds: params.configKinds,
      requestedAt: new Date().toISOString(),
      confirmationSurface: "visible_tui",
    };
    this.recovery.orphanedWorkspaceTrust = this.recovery.orphanedWorkspaceTrust
      .filter((entry) => !samePath(entry.workspace, params.workspace));
    this.record("workspace_trust_requested", summary);
    this.tagPendingTuiWithWorkspaceTrust(summary);
    return new Promise((resolveTrust) => {
      this.pendingWorkspaceTrust.set(trustRequestId, {
        params,
        summary,
        resolvers: [resolveTrust],
      });
    });
  }

  tagPendingTuiWithWorkspaceTrust(summary) {
    const record = [...listTuiStateRecords(this.tuiStateRoot)].reverse().find(({ value }) =>
      PENDING_TUI_STATUSES.has(value.status)
      && value.sessionId === summary.sessionId
      && typeof value.cwd === "string"
      && samePath(value.cwd, summary.cwd));
    if (!record) {
      return false;
    }
    return this.writeTuiActivationState({
      sessionId: summary.sessionId,
      pid: record.value.grokPid,
      statePath: record.path,
    }, {
      status: "awaiting_workspace_trust",
      trustRequestId: summary.trustRequestId,
      workspace: summary.workspace,
      configKinds: summary.configKinds,
      activationPendingAt: record.value.activationPendingAt || new Date().toISOString(),
    });
  }

  resolveWorkspaceTrust({ sessionId, workspace = null, outcome, reason, tuiPid = null }) {
    if (!new Set(["trust", "reject"]).has(outcome)) {
      throw new Error("workspace trust outcome must be trust or reject");
    }
    let resolvedCount = 0;
    for (const [trustRequestId, pending] of this.pendingWorkspaceTrust) {
      if (pending.summary.sessionId !== sessionId
        && (!workspace || !samePath(pending.summary.workspace, workspace))) {
        continue;
      }
      for (const resolveTrust of pending.resolvers) {
        resolveTrust({ outcome });
      }
      this.pendingWorkspaceTrust.delete(trustRequestId);
      this.record("workspace_trust_resolved", {
        trustRequestId,
        sessionId: pending.summary.sessionId,
        cwd: pending.summary.cwd,
        workspace: pending.summary.workspace,
        outcome,
        reason,
        tuiPid,
      });
      resolvedCount += 1;
    }
    if (workspace) {
      this.recovery.orphanedWorkspaceTrust = this.recovery.orphanedWorkspaceTrust
        .filter((entry) => !samePath(entry.workspace, workspace));
    }
    return resolvedCount;
  }

  async status() {
    for (const [pid, owned] of this.tuiProcesses) {
      if (!this.ownedTuiIdentityMatches(pid, owned)) {
        this.tuiProcesses.delete(pid);
      }
    }
    const leader = await this.leaderInfo();
    const leaderOwnership = this.readLeaderOwnership();
    const rawActiveSessions = this.readActiveSessions();
    const activeSessions = rawActiveSessions.slice(0, 50).map((entry) => ({
      sessionId: entry.session_id,
      pid: entry.pid,
      cwd: entry.cwd,
      openedAt: entry.opened_at,
    }));
    const recordedTuis = listTuiStateRecords(this.tuiStateRoot).map(({ path, value }) => {
      const assessment = this.assessRecordedTui(value, rawActiveSessions, leaderOwnership);
      const liveStatus = LIVE_TUI_STATUSES.has(value.status);
      const effectiveStatus = liveStatus && !assessment.pidAlive
        ? "stale"
        : liveStatus && !assessment.processIdentityMatch
          ? "stale_pid_reused_or_unverified"
          : liveStatus && !assessment.leaderOwnershipMatch
            ? "stale_leader_ownership"
            : value.status === "running" && !assessment.activeRegistryMatch
          ? "registry_pending"
          : value.status;
      return {
        statePath: path,
        launchId: value.launchId,
        status: effectiveStatus,
        recordedStatus: value.status,
        sessionId: value.sessionId,
        cwd: value.cwd,
        hostPid: value.hostPid ?? null,
        grokPid: value.grokPid ?? null,
        processAlive: assessment.processAlive,
        pidAlive: assessment.pidAlive,
        processIdentityMatch: assessment.processIdentityMatch,
        processFingerprintRecorded: assessment.processFingerprintRecorded,
        activeRegistryMatch: assessment.activeRegistryMatch,
        leaderOwnershipMatch: assessment.leaderOwnershipMatch,
        ownedBySupervisor: this.tuiProcesses.has(value.grokPid),
        ownedByCurrentMcp: this.tuiProcesses.has(value.grokPid),
        updatedAt: value.updatedAt ?? null,
      };
    }).slice(-20);
    return {
      supervisorInstanceId: this.instanceId,
      grokBinary: this.grokBinary,
      grokBinaryExists: existsSync(this.grokBinary),
      stateRoot: this.stateRoot,
      tuiRuntime: this.tuiRuntime ? {
        persistent: true,
        fingerprint: this.tuiRuntime.fingerprint,
        runtimeRoot: this.tuiRuntime.runtimeRoot,
      } : { persistent: false },
      proxyConfiguration: this.proxyConfigurationView(),
      journal: this.journal.info(),
      journalError: this.journalError,
      recovery: this.recovery,
      leader,
      leaderOwnership: {
        valid: leaderOwnership.valid,
        reason: leaderOwnership.reason,
        leaderPid: leaderOwnership.record?.leaderPid ?? null,
        cwd: leaderOwnership.record?.cwd ?? null,
        socketPath: leaderOwnership.record?.socketPath ?? null,
        createdAt: leaderOwnership.record?.createdAt ?? null,
        createdByInstanceId: leaderOwnership.record?.createdByInstanceId ?? null,
      },
      ownedLeaderPid: leaderOwnership.valid
        ? leaderOwnership.record.leaderPid
        : this.leaderProcess?.pid ?? null,
      ownedLeaderCwd: this.leaderCwd,
      leaderProxy: this.leaderProxyContext ? {
        ...this.leaderProxyContext.summary,
        route: this.leaderProxyRoute ? {
          verified: this.leaderProxyRoute.verified === true,
          endpoint: this.leaderProxyRoute.endpoint,
          verifiedAt: this.leaderProxyRoute.verifiedAt,
        } : null,
      } : null,
      ownedVisibleTuiPids: [...this.tuiProcesses.keys()],
      acpConnected: Boolean(this.acpConnection && !this.acpConnection.signal.aborted),
      acpPid: this.acpProcess?.pid ?? null,
      attachedSessionId: this.attachedSessionId,
      attachedCwd: this.attachedCwd,
      activeRun: this.activeRun ? {
        runId: this.activeRun.runId,
        sessionId: this.activeRun.sessionId,
        hostKind: this.activeRun.hostKind,
        status: this.activeRun.status,
        startedAt: this.activeRun.startedAt,
        completedAt: this.activeRun.completedAt,
        terminalSequence: this.activeRun.terminalSequence,
        stopReason: typeof this.activeRun.result?.stopReason === "string"
          ? this.activeRun.result.stopReason
          : null,
        responseChars: this.activeRun.totalMessageChars,
        messageCount: this.activeRun.messageCount || 0,
        responseTruncated: this.activeRun.finalTextTruncated === true,
        error: this.activeRun.error,
      } : null,
      pendingPermissions: this.permissionSummaries(),
      pendingElicitations: this.elicitationSummaries(),
      pendingWorkspaceTrust: this.workspaceTrustSummaries(),
      activeSessions,
      recordedTuis,
    };
  }

  assessRecordedTui(value, activeSessions, leaderOwnership) {
    const activeRegistryMatch = activeSessions.some((entry) =>
      entry.session_id === value.sessionId && entry.pid === value.grokPid);
    const leaderOwnershipMatch = Boolean(leaderOwnership.valid
      && value.leaderOwnerToken === leaderOwnership.record.ownerToken);
    const pidAlive = processIsAlive(value.grokPid);
    const identity = pidAlive ? this.inspectProcessIdentity(value.grokPid) : null;
    const processFingerprintRecorded = typeof value.grokProcessFingerprint === "string"
      && value.grokProcessFingerprint.length > 0;
    const fingerprintMatch = processFingerprintRecorded
      && identity?.fingerprint === value.grokProcessFingerprint;
    const executablePathMatch = typeof identity?.executablePath === "string"
      && samePath(identity.executablePath, this.grokBinary);
    const processIdentityMatch = Boolean(pidAlive
      && identity
      && executablePathMatch
      && (processFingerprintRecorded
        ? fingerprintMatch
        : activeRegistryMatch && leaderOwnershipMatch));
    return {
      pidAlive,
      processAlive: Boolean(LIVE_TUI_STATUSES.has(value.status)
        && processIdentityMatch
        && (value.status !== "running" || activeRegistryMatch)
        && leaderOwnershipMatch),
      processIdentityMatch,
      processFingerprintRecorded,
      activeRegistryMatch,
      leaderOwnershipMatch,
    };
  }

  ownedTuiIdentityMatches(pid, owned) {
    if (!owned || typeof owned.processFingerprint !== "string" || !processIsAlive(pid)) {
      return false;
    }
    const identity = this.inspectProcessIdentity(pid);
    return Boolean(identity
      && identity.fingerprint === owned.processFingerprint
      && typeof identity.executablePath === "string"
      && samePath(identity.executablePath, this.grokBinary));
  }

  latestRunSnapshot({ sessionId = null, runId = null } = {}) {
    const active = this.activeRun
      && (!sessionId || this.activeRun.sessionId === sessionId)
      && (!runId || this.activeRun.runId === runId)
      ? this.activeRun
      : null;
    if (active) {
      return {
        runId: active.runId,
        sessionId: active.sessionId,
        status: active.status,
        startedAt: active.startedAt,
        completedAt: active.completedAt,
        terminalSequence: active.terminalSequence ?? null,
        stopReason: typeof active.result?.stopReason === "string" ? active.result.stopReason : null,
        finalText: active.finalText || null,
        resultArtifact: active.resultArtifact || null,
        resultSummary: active.resultSummary || null,
        artifactError: active.artifactError || null,
        messageCount: active.messageCount || 0,
        responseTruncated: active.finalTextTruncated === true,
        progress: runProgressSnapshot(active),
        question: active.question || null,
        error: active.error || null,
      };
    }

    const matching = this.events.filter((event) => {
      if (sessionId && event.sessionId !== sessionId) {
        return false;
      }
      if (runId && event.runId !== runId) {
        return false;
      }
      return ["prompt_started", "prompt_completed", "prompt_failed", "prompt_cancel_requested"].includes(event.kind);
    });
    const latest = matching.at(-1);
    if (!latest) {
      const interrupted = this.recovery.interruptedRun;
      if (interrupted
        && (!sessionId || interrupted.sessionId === sessionId)
        && (!runId || interrupted.runId === runId)) {
        return {
          ...interrupted,
          completedAt: null,
          terminalSequence: null,
          stopReason: null,
          finalText: null,
          resultArtifact: null,
          resultSummary: null,
          artifactError: null,
          question: null,
          error: null,
        };
      }
      return null;
    }
    const effectiveRunId = latest.runId;
    const started = [...matching].reverse().find((event) => event.kind === "prompt_started" && event.runId === effectiveRunId);
    return {
      runId: effectiveRunId,
      sessionId: latest.sessionId || started?.sessionId || sessionId,
      status: runStatusFromEvent(latest),
      startedAt: started?.timestamp || null,
      completedAt: latest.kind === "prompt_started" ? null : latest.timestamp,
      terminalSequence: latest.kind === "prompt_started" ? null : latest.sequence,
      stopReason: typeof latest.result?.stopReason === "string" ? latest.result.stopReason : null,
      finalText: typeof latest.finalText === "string" ? latest.finalText : null,
      resultArtifact: latest.resultArtifact && typeof latest.resultArtifact === "object"
        ? latest.resultArtifact
        : null,
      resultSummary: typeof latest.resultSummary === "string" ? latest.resultSummary : null,
      artifactError: typeof latest.artifactError === "string" ? latest.artifactError : null,
      messageCount: Number.isInteger(latest.messageCount) ? latest.messageCount : null,
      responseTruncated: latest.responseTruncated === true,
      progress: latest.progress && typeof latest.progress === "object" ? latest.progress : null,
      question: latest.question || null,
      error: latest.kind === "prompt_failed" ? latest.message || "Grok prompt failed" : null,
    };
  }

  sessionActivationSnapshot(sessionId, cwd = null) {
    if (!sessionId) {
      return null;
    }
    const trust = this.workspaceTrustForSession(sessionId);
    if (trust) {
      return {
        state: "needs_workspace_trust",
        sessionId,
        cwd: trust.cwd,
        workspace: trust.workspace,
        configKinds: trust.configKinds,
        trustRequestId: trust.trustRequestId,
        confirmationSurface: "visible_tui",
      };
    }
    const ownership = this.readLeaderOwnership();
    if (!ownership.valid) {
      return null;
    }
    const activeSessions = this.readActiveSessions();
    const record = [...listTuiStateRecords(this.tuiStateRoot)].reverse().find(({ value }) => {
      if (!PENDING_TUI_STATUSES.has(value.status)
        || value.sessionId !== sessionId
        || value.leaderOwnerToken !== ownership.record.ownerToken
        || (cwd && (typeof value.cwd !== "string" || !samePath(value.cwd, cwd)))) {
        return false;
      }
      const assessment = this.assessRecordedTui(value, activeSessions, ownership);
      return assessment.processAlive;
    });
    if (!record) {
      return null;
    }
    return {
      state: record.value.status === "awaiting_workspace_trust"
        ? "needs_workspace_trust"
        : "awaiting_session_registration",
      sessionId,
      cwd: record.value.cwd,
      workspace: record.value.workspace ?? null,
      configKinds: Array.isArray(record.value.configKinds) ? record.value.configKinds : [],
      trustRequestId: record.value.trustRequestId ?? null,
      tuiPid: record.value.grokPid,
      statePath: record.path,
      confirmationSurface: record.value.status === "awaiting_workspace_trust" ? "visible_tui" : null,
    };
  }

  interactionSnapshot(options = {}) {
    const requestedRunId = options.runId ? validateSessionId(options.runId) : null;
    const sessionId = options.sessionId
      ? validateSessionId(options.sessionId)
      : this.attachedSessionId || this.activeRun?.sessionId || this.recovery.interruptedRun?.sessionId || null;
    const permission = this.permissionSummaries().find((item) => !sessionId || item.sessionId === sessionId) || null;
    const elicitation = this.elicitationSummaries().find((item) => !sessionId || item.sessionId === sessionId) || null;
    const activation = this.sessionActivationSnapshot(sessionId, sessionId === this.attachedSessionId ? this.attachedCwd : null);
    const run = this.latestRunSnapshot({ sessionId, runId: requestedRunId });
    let state;
    let request = null;
    if (activation?.state === "needs_workspace_trust") {
      state = "needs_workspace_trust";
      request = { kind: "workspace_trust", ...activation };
    } else if (activation?.state === "awaiting_session_registration") {
      state = "awaiting_session_registration";
      request = { kind: "terminal_confirmation", ...activation };
    } else if (elicitation) {
      state = "needs_input";
      request = { kind: "input", ...elicitation };
    } else if (permission) {
      state = "needs_permission";
      request = { kind: "permission", ...permission };
    } else if (run?.question) {
      state = "needs_input";
      request = { kind: "input", source: "fallback", ...run.question };
    } else if (run?.status === "running") {
      state = "working";
    } else if (run?.status === "completed") {
      state = "completed";
    } else if (run?.status === "failed") {
      state = "failed";
    } else if (run?.status === "cancel_requested") {
      state = "cancelling";
    } else if (run?.status === "unknown_after_restart") {
      state = "unknown_after_restart";
    } else if (requestedRunId) {
      state = "not_found";
    } else if (this.acpConnection && !this.acpConnection.signal.aborted && this.attachedSessionId === sessionId) {
      state = "ready";
    } else {
      state = "idle";
    }

    const afterSequence = Number.isInteger(options.afterSequence) && options.afterSequence >= 0
      ? options.afterSequence
      : 0;
    const stream = this.updates({
      afterSequence: options.afterSequence,
      limit: options.limit,
      sessionId,
    });
    const terminalSequence = Number.isInteger(run?.terminalSequence) ? run.terminalSequence : null;
    const terminalDelivery = terminalSequence === null || terminalSequence > afterSequence;
    const resultArtifactAvailable = state === "completed"
      && run?.resultArtifact
      && typeof run.resultArtifact === "object";
    const resultArtifactIncluded = Boolean(resultArtifactAvailable && terminalDelivery);
    const finalTextAvailable = state === "completed" && typeof run?.finalText === "string";
    const finalTextIncluded = finalTextAvailable && terminalDelivery && !resultArtifactAvailable;
    const publicRun = run ? {
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      terminalSequence,
      stopReason: run.stopReason,
      finalText: finalTextIncluded ? run.finalText : null,
      resultArtifact: resultArtifactIncluded ? run.resultArtifact : null,
      resultSummary: terminalDelivery ? run.resultSummary : null,
      artifactError: run.artifactError,
      messageCount: run.messageCount,
      responseTruncated: run.responseTruncated === true,
      question: run.question,
      error: run.error,
    } : null;
    const progress = run?.progress && (run.status === "running" || terminalDelivery) ? {
      ...run.progress,
      status: run.status === "running" ? "streaming" : run.status,
      newActivity: stream.latestSequence > afterSequence,
      contentSuppressed: true,
      coalesced: true,
      eventsCollapsed: stream.hasMore,
    } : null;
    return {
      view: "interaction",
      state,
      message: interactionMessage(state),
      session: {
        sessionId,
        cwd: sessionId === this.attachedSessionId ? this.attachedCwd : null,
        attached: Boolean(this.acpConnection && !this.acpConnection.signal.aborted && this.attachedSessionId === sessionId),
      },
      run: publicRun,
      progress,
      request,
      activation,
      delivery: {
        mode: "terminal_cursor_once",
        finalTextAvailable,
        finalTextIncluded,
        resultArtifactAvailable: Boolean(resultArtifactAvailable),
        resultArtifactIncluded,
        terminalSequence,
      },
      cursor: {
        nextAfterSequence: stream.latestSequence,
        hasMore: false,
        oldestAvailableSequence: stream.oldestAvailableSequence,
        latestSequence: stream.latestSequence,
        cursorGap: stream.cursorGap,
        coalesced: true,
      },
    };
  }

  async inspectInteraction(options = {}) {
    const waitMs = Math.max(0, Math.min(Number(options.waitMs) || 0, MAX_INTERACTION_WAIT_MS));
    const startedWaitingAt = Date.now();
    const requestedSessionId = options.sessionId || this.attachedSessionId;
    const requestedRunId = options.runId || this.activeRun?.runId;
    if (this.activeRun?.status === "running"
      && this.activeRun.sessionId === requestedSessionId
      && this.activeRun.runId === requestedRunId
      && this.activeRun.progress?.dirtySinceLastRecord) {
      this.recordRunProgress(this.activeRun, { heartbeat: true });
    }
    let snapshot = this.interactionSnapshot(options);
    while (waitMs > 0 && ["working", "cancelling"].includes(snapshot.state)) {
      const remaining = waitMs - (Date.now() - startedWaitingAt);
      if (remaining <= 0) {
        break;
      }
      await this.waitForRecordedChange(remaining);
      snapshot = this.interactionSnapshot(options);
    }
    const waitedMs = Date.now() - startedWaitingAt;
    return {
      ...snapshot,
      waitedMs,
      timedOut: waitMs > 0 && ["working", "cancelling"].includes(snapshot.state) && waitedMs >= waitMs,
    };
  }

  async inspect(options = {}) {
    const view = options.view || "interaction";
    if (!INSPECT_VIEWS.has(view)) {
      throw new Error("view must be interaction, status, summary, delta, or evidence");
    }
    if (view === "interaction") {
      return this.inspectInteraction(options);
    }
    const status = await this.status();
    const inspectedCwd = options.cwd ? validateWorkingDirectory(options.cwd) : status.attachedCwd;
    const inspectedSessionId = options.sessionId
      ? validateSessionId(options.sessionId)
      : status.attachedSessionId;
    const stream = this.updates({ ...options, sessionId: inspectedSessionId });
    const summary = summarizeEvents(stream.events, stream);
    const agentSummary = inspectedCwd && inspectedSessionId
      ? readSessionSummary({
        sessionRoot: this.sessionRoot,
        cwd: inspectedCwd,
        sessionId: inspectedSessionId,
      })
      : null;
    const sessionCandidates = options.cwd
      ? listSessionCandidates({
        sessionRoot: this.sessionRoot,
        cwd: inspectedCwd,
        query: options.sessionQuery,
        limit: options.sessionLimit,
      })
      : [];
    const cursor = {
      nextAfterSequence: stream.nextAfterSequence,
      hasMore: stream.hasMore,
      oldestAvailableSequence: stream.oldestAvailableSequence,
      latestSequence: stream.latestSequence,
      cursorGap: stream.cursorGap,
    };
    const base = {
      view,
      status,
      cursor,
      sessionCandidates,
      agentSummary,
    };
    if (view === "status") {
      return base;
    }
    if (view === "delta") {
      return { ...base, stream };
    }
    if (view === "evidence") {
      return {
        ...base,
        evidence: this.journal.evidence(options.sequences || []),
      };
    }
    return { ...base, summary };
  }

  async prepareLeaderProxyContext() {
    const proxyContext = await this.resolveProxyContext({ policy: this.proxyPolicy });
    await this.probeProxyEndpoint(proxyContext);
    return proxyContext;
  }

  async ensureLeaderProxyRouteVerified() {
    const ownership = this.readLeaderOwnership();
    const fingerprint = this.leaderProxyContext?.summary?.fingerprint ?? null;
    if (!ownership.valid || !fingerprint || ownership.record.proxy?.fingerprint !== fingerprint) {
      throw new Error("The dedicated Leader does not have a verified proxy ownership record");
    }
    if (this.leaderProxyRoute?.pid === ownership.record.leaderPid
      && this.leaderProxyRoute?.fingerprint === fingerprint) {
      return this.leaderProxyRoute;
    }
    const verified = await this.verifyProxyRoute({
      pid: ownership.record.leaderPid,
      proxyContext: this.leaderProxyContext,
    });
    this.leaderProxyRoute = {
      ...verified,
      fingerprint,
      verifiedAt: new Date().toISOString(),
    };
    this.record("leader_proxy_route_verified", {
      pid: ownership.record.leaderPid,
      source: this.leaderProxyContext.summary.source,
      endpoint: this.leaderProxyContext.summary.endpoint,
      fingerprint,
    });
    return this.leaderProxyRoute;
  }

  async startLeader({ cwd }) {
    const fullCwd = validateWorkingDirectory(cwd);
    if (!existsSync(this.grokBinary)) {
      throw new Error(`Grok binary not found: ${this.grokBinary}`);
    }
    this.prepareLeaderSocketForStart();
    const proxyContext = await this.prepareLeaderProxyContext();
    const existing = await this.leaderInfo();
    if (existing.running) {
      const ownership = this.readLeaderOwnership();
      const proxyMatches = ownership.valid
        && typeof ownership.record.proxy?.fingerprint === "string"
        && ownership.record.proxy.fingerprint === proxyContext.summary.fingerprint;
      if (proxyMatches) {
        this.leaderProxyContext = proxyContext;
      }
      return {
        started: false,
        reason: proxyMatches
          ? "managed_leader_recovered"
          : ownership.valid
            ? "leader_proxy_unverified"
            : "leader_already_running",
        leader: existing,
        managed: proxyMatches,
        proxy: proxyContext.summary,
      };
    }

    mkdirSync(this.stateRoot, { recursive: true });
    this.removeStaleOwnedLock();
    let verifiedLeaderPid = null;
    const child = this.spawnProcess(this.grokBinary, [
      "agent",
      "leader",
      "--no-exit-on-disconnect",
      "--relay-on-demand",
      "--no-auto-update",
      "--leader-socket",
      this.socketPath,
    ], {
      cwd: fullCwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: proxyContext.environment,
    });
    this.leaderProcess = child;
    this.leaderCwd = fullCwd;
    child.stdout?.on("data", (chunk) => this.captureDiagnostic("leader_stdout", chunk));
    child.stderr?.on("data", (chunk) => this.captureDiagnostic("leader_stderr", chunk));
    child.once("exit", (code, signal) => {
      const ownershipRecord = readJsonFile(this.leaderOwnershipPath);
      const detachedLeaderSurvives = Number.isInteger(verifiedLeaderPid)
        && verifiedLeaderPid !== child.pid
        && ownershipRecord?.leaderPid === verifiedLeaderPid
        && processIsAlive(verifiedLeaderPid);
      this.record(detachedLeaderSurvives ? "leader_launcher_exit" : "leader_exit", {
        pid: child.pid,
        leaderPid: verifiedLeaderPid,
        code,
        signal,
      });
      if (!detachedLeaderSurvives) {
        this.clearLeaderOwnership(verifiedLeaderPid ?? child.pid);
      }
      if (this.leaderProcess === child) {
        this.leaderProcess = null;
        if (!detachedLeaderSurvives) {
          this.leaderCwd = null;
          this.leaderProxyContext = null;
          this.leaderProxyRoute = null;
        }
      }
    });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      const info = await this.leaderInfo();
      const leaderPid = Number.isInteger(info.pid) ? info.pid : child.pid;
      if (info.running && leaderPid) {
        verifiedLeaderPid = leaderPid;
        const ownership = this.writeLeaderOwnership({
          leaderPid,
          cwd: fullCwd,
          proxy: proxyContext.summary,
        });
        this.leaderProxyContext = proxyContext;
        this.leaderProxyRoute = null;
        this.record("leader_started", {
          pid: leaderPid,
          launcherPid: leaderPid === child.pid ? null : child.pid,
          socketPath: this.socketPath,
          proxy: proxyContext.summary,
        });
        return {
          started: true,
          pid: leaderPid,
          launcherPid: leaderPid === child.pid ? null : child.pid,
          cwd: fullCwd,
          leader: info,
          managed: true,
          ownerToken: ownership.ownerToken,
          proxy: proxyContext.summary,
        };
      }
      if (child.exitCode !== null) {
        break;
      }
    }
    throw new Error(`Leader did not become ready (exitCode=${child.exitCode}). Diagnostics: ${this.stderrTail.join(" | ")}`);
  }

  captureDiagnostic(kind, chunk) {
    const rawText = String(chunk).trim();
    const text = rawText.length > 2048
      ? `…${rawText.slice(-2048)}`
      : rawText;
    if (!text) {
      return;
    }
    this.stderrTail.push(`${kind}: ${text}`);
    if (this.stderrTail.length > 20) {
      this.stderrTail.shift();
    }
  }

  async launchTui({ sessionId, cwd, mode, confirmation }) {
    validateSessionId(sessionId);
    const fullCwd = validateWorkingDirectory(cwd);
    if (!new Set(["new", "resume"]).has(mode)) {
      throw new Error("mode must be new or resume");
    }
    if (confirmation !== "LAUNCH_VISIBLE_TUI") {
      throw new Error("confirmation must equal LAUNCH_VISIBLE_TUI");
    }
    const leader = await this.leaderInfo();
    if (!leader.running) {
      throw new Error("Dedicated Leader is not running");
    }
    const leaderOwnership = this.readLeaderOwnership();
    if (!leaderOwnership.valid) {
      throw new Error("Dedicated Leader is not backed by a verified plugin ownership record");
    }
    const active = this.readActiveSessions().filter((entry) => entry.session_id === sessionId);
    const ownedAcpPid = this.attachedSessionId === sessionId
      && typeof this.attachedCwd === "string"
      && samePath(this.attachedCwd, fullCwd)
      ? this.acpProcess?.pid ?? null
      : null;
    const foreignActive = active.find((entry) => !ownedAcpPid || entry.pid !== ownedAcpPid);
    const existingSavedSession = mode === "new" && listSessionCandidates({
      sessionRoot: this.sessionRoot,
      cwd: fullCwd,
      limit: 20,
    }).some((candidate) => candidate.sessionId === sessionId);
    if (foreignActive || existingSavedSession) {
      throw new Error(foreignActive
        ? `Session is already active in PID ${foreignActive.pid}; refusing a concurrent resume`
        : `Session ${sessionId} already exists; refusing to create it again`);
    }
    if (active.length > 0) {
      this.record("tui_launch_with_owned_acp_keepalive", {
        sessionId,
        acpPid: ownedAcpPid,
      });
    }

    const terminal = this.resolveTerminalPresentation();
    const launchId = randomUUID();
    mkdirSync(this.tuiStateRoot, { recursive: true });
    const statePath = assertPathWithin(this.tuiStateRoot, join(this.tuiStateRoot, `${launchId}.json`), "TUI state path");
    writeJsonAtomic(statePath, {
      schemaVersion: 1,
      launchId,
      leaderOwnerToken: leaderOwnership.record.ownerToken,
      status: "launching",
      mode,
      sessionId,
      cwd: fullCwd,
      hostPid: null,
      grokPid: null,
      updatedAt: new Date().toISOString(),
    });
    const args = buildWindowsTerminalArgs({
      profile: terminal.profile,
      title: buildTuiTitle({ cwd: fullCwd, sessionId, mode }),
      cwd: fullCwd,
      powerShellBinary: terminal.powerShellBinary,
      launcherScript: this.tuiLauncherScript,
      nodeBinary: this.nodeBinary,
      hostScript: this.tuiHostScript,
      statePath,
      grokBinary: this.grokBinary,
      leaderSocket: this.socketPath,
      leaderOwnerToken: leaderOwnership.record.ownerToken,
      mode,
      sessionId,
      launchId,
    });
    let launchError = null;
    const terminalProcess = this.spawnProcess(terminal.wtBinary, args, {
      cwd: fullCwd,
      detached: false,
      stdio: "ignore",
      windowsHide: false,
      env: this.leaderProxyContext?.environment || process.env,
    });
    terminalProcess.once("error", (error) => {
      launchError = error;
    });
    terminalProcess.unref?.();

    const deadline = Date.now() + this.tuiLaunchTimeoutMs;
    let lastTerminalPresentation = null;
    let observedTuiPid = null;
    let handoffRecorded = false;
    try {
      while (Date.now() < deadline) {
        if (launchError) {
          throw new Error(`Windows Terminal launch failed: ${launchError.message}`);
        }
        const state = readJsonFile(statePath);
        if (state?.launchId === launchId && state.status === "running" && Number.isInteger(state.grokPid)) {
          const processFingerprint = state.grokProcessFingerprint;
          const identity = this.inspectProcessIdentity(state.grokPid);
          const identityMatches = typeof processFingerprint === "string"
            && identity?.fingerprint === processFingerprint
            && typeof identity?.executablePath === "string"
            && samePath(identity.executablePath, this.grokBinary);
          if (!identityMatches) {
            throw new Error(`Grok TUI PID ${state.grokPid} could not be verified against its launch fingerprint; refusing ownership`);
          }
          observedTuiPid = state.grokPid;
          if (!this.tuiProcesses.has(state.grokPid)) {
            this.tuiProcesses.set(state.grokPid, {
              launchId,
              sessionId,
              cwd: fullCwd,
              mode,
              statePath,
              hostPid: state.hostPid ?? null,
              hostProcessFingerprint: state.hostProcessFingerprint ?? null,
              processFingerprint,
              terminalProfile: terminal.profileName,
              terminalPid: terminalProcess.pid ?? null,
            });
          }
          lastTerminalPresentation = this.inspectTerminalPresentation({
            hostPid: state.hostPid,
            launcherPid: terminalProcess.pid,
          });
          if (lastTerminalPresentation?.visible !== true) {
            if (terminalProcess.exitCode !== null && terminalProcess.exitCode !== 0) {
              throw new Error(`Windows Terminal launcher exited with code ${terminalProcess.exitCode}`);
            }
            if (terminalProcess.exitCode === 0 && !handoffRecorded) {
              handoffRecorded = true;
              this.record("terminal_launcher_handoff", {
                launcherPid: terminalProcess.pid ?? null,
                hostPid: state.hostPid ?? null,
                tuiPid: state.grokPid,
                sessionId,
              });
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, this.tuiPollIntervalMs));
            continue;
          }
          this.record("tui_launched", {
            pid: state.grokPid,
            hostPid: state.hostPid,
            sessionId,
            cwd: fullCwd,
            mode,
            statePath,
            terminalProfile: terminal.profileName,
            terminalPid: terminalProcess.pid ?? null,
            terminalWindowPid: lastTerminalPresentation.processId,
            terminalWindowHandle: lastTerminalPresentation.mainWindowHandle,
            presentationEvidence: lastTerminalPresentation.evidence,
          });
          return {
            launched: true,
            pid: state.grokPid,
            hostPid: state.hostPid ?? null,
            sessionId,
            cwd: fullCwd,
            mode,
            presentation: "windows_terminal",
            terminalProfile: terminal.profileName,
            terminalPid: terminalProcess.pid ?? null,
            visible: true,
            terminalWindowPid: lastTerminalPresentation.processId,
            terminalWindowHandle: lastTerminalPresentation.mainWindowHandle,
            terminalWindowTitle: lastTerminalPresentation.mainWindowTitle,
            presentationEvidence: lastTerminalPresentation.evidence,
            statePath,
          };
        }
        if (state?.launchId === launchId && new Set(["failed", "exited"]).has(state.status)) {
          throw new Error(`Grok TUI did not remain running (${state.status}): ${state.error || `exitCode=${state.exitCode}`}`);
        }
        if (terminalProcess.exitCode !== null && terminalProcess.exitCode !== 0) {
          throw new Error(`Windows Terminal launcher exited with code ${terminalProcess.exitCode}`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, this.tuiPollIntervalMs));
      }
      const visibility = lastTerminalPresentation
        ? `handle=${lastTerminalPresentation.mainWindowHandle}, process=${lastTerminalPresentation.processName || "unknown"}, evidence=${lastTerminalPresentation.evidence}`
        : "window process was not observable";
      throw new Error(`Windows Terminal Grok TUI did not present a visible window within ${this.tuiLaunchTimeoutMs}ms (${visibility}); state=${statePath}`);
    } catch (error) {
      if (Number.isInteger(observedTuiPid)) {
        error.ownedTuiPid = observedTuiPid;
        error.tuiStatePath = statePath;
      }
      throw error;
    }
  }

  async waitForTuiSession({ sessionId, pid, timeoutMs = 5000 }) {
    const deadline = Date.now() + timeoutMs;
    let activePids = [];
    while (Date.now() < deadline) {
      const matching = this.readActiveSessions().filter((entry) => entry.session_id === sessionId);
      activePids = matching.map((entry) => entry.pid).filter(Number.isInteger);
      const active = matching.find((entry) => entry.pid === pid);
      if (active) {
        return this.markTuiSessionReady({ sessionId, pid });
      }
      const owned = this.tuiProcesses.get(pid);
      if (!this.ownedTuiIdentityMatches(pid, owned)) {
        throw new Error(`Owned Grok TUI PID ${pid} exited before session ${sessionId} became active`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const pending = this.markTuiActivationPending({ sessionId, pid });
    this.record("tui_session_registry_pending", {
      sessionId,
      pid,
      timeoutMs,
      otherActivePids: activePids,
      activationState: pending.state,
    });
    return pending;
  }

  writeTuiActivationState({ sessionId, pid, statePath }, patch) {
    const state = readJsonFile(statePath);
    if (!state
      || state.sessionId !== sessionId
      || state.grokPid !== pid
      || !LIVE_TUI_STATUSES.has(state.status)) {
      return false;
    }
    writeJsonAtomic(statePath, {
      ...state,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  markTuiSessionReady({ sessionId, pid, statePath = null }) {
    const owned = this.tuiProcesses.get(pid);
    const resolvedStatePath = statePath || owned?.statePath || null;
    if (resolvedStatePath) {
      this.writeTuiActivationState({ sessionId, pid, statePath: resolvedStatePath }, {
        status: "running",
        sessionReadyAt: new Date().toISOString(),
      });
    }
    this.resolveWorkspaceTrust({
      sessionId,
      outcome: "trust",
      reason: "visible_tui_session_registered",
      tuiPid: pid,
    });
    const monitor = this.tuiActivationMonitors.get(pid);
    if (monitor?.timer) {
      clearTimeout(monitor.timer);
    }
    this.tuiActivationMonitors.delete(pid);
    this.record("tui_session_registered", { sessionId, pid, statePath: resolvedStatePath });
    return {
      observed: true,
      ready: true,
      state: "ready",
      pid,
      needsTerminalConfirmation: false,
    };
  }

  markTuiActivationPending({ sessionId, pid }) {
    const owned = this.tuiProcesses.get(pid);
    if (!owned) {
      throw new Error(`TUI PID ${pid} is not owned while activation remains pending`);
    }
    const trust = this.workspaceTrustForSession(sessionId);
    const state = trust ? "needs_workspace_trust" : "awaiting_session_registration";
    const storedStatus = trust ? "awaiting_workspace_trust" : "awaiting_session_registration";
    this.writeTuiActivationState({ sessionId, pid, statePath: owned.statePath }, {
      status: storedStatus,
      trustRequestId: trust?.trustRequestId ?? null,
      workspace: trust?.workspace ?? null,
      configKinds: trust?.configKinds ?? [],
      activationPendingAt: new Date().toISOString(),
    });
    this.startTuiActivationMonitor({
      sessionId,
      pid,
      cwd: owned.cwd,
      statePath: owned.statePath,
    });
    return {
      observed: false,
      ready: false,
      state,
      pid,
      needsTerminalConfirmation: true,
      trustRequest: trust,
    };
  }

  startTuiActivationMonitor({ sessionId, pid, cwd, statePath }) {
    if (this.tuiActivationMonitors.has(pid)) {
      return;
    }
    const monitor = { sessionId, pid, cwd, statePath, timer: null };
    const poll = () => {
      const current = this.tuiActivationMonitors.get(pid);
      if (current !== monitor) {
        return;
      }
      const state = readJsonFile(statePath);
      const ownership = this.readLeaderOwnership();
      const stateMatches = state
        && LIVE_TUI_STATUSES.has(state.status)
        && state.sessionId === sessionId
        && state.grokPid === pid
        && typeof state.cwd === "string"
        && samePath(state.cwd, cwd)
        && ownership.valid
        && state.leaderOwnerToken === ownership.record.ownerToken;
      if (!stateMatches) {
        this.resolveWorkspaceTrust({
          sessionId,
          outcome: "reject",
          reason: "tui_activation_ownership_lost",
          tuiPid: pid,
        });
        this.tuiActivationMonitors.delete(pid);
        this.record("tui_activation_stopped", { sessionId, pid, reason: "ownership_lost", statePath });
        return;
      }
      const activeSessions = this.readActiveSessions();
      const assessment = this.assessRecordedTui(state, activeSessions, ownership);
      if (assessment.activeRegistryMatch && assessment.processIdentityMatch && assessment.leaderOwnershipMatch) {
        this.markTuiSessionReady({ sessionId, pid, statePath });
        return;
      }
      if (!assessment.pidAlive || !assessment.processIdentityMatch || !assessment.leaderOwnershipMatch) {
        this.resolveWorkspaceTrust({
          sessionId,
          outcome: "reject",
          reason: "visible_tui_exited_before_session_registration",
          tuiPid: pid,
        });
        this.tuiProcesses.delete(pid);
        this.tuiActivationMonitors.delete(pid);
        this.record("tui_activation_stopped", { sessionId, pid, reason: "tui_exited", statePath });
        return;
      }
      monitor.timer = setTimeout(poll, Math.max(100, this.tuiPollIntervalMs));
      monitor.timer.unref?.();
    };
    this.tuiActivationMonitors.set(pid, monitor);
    monitor.timer = setTimeout(poll, Math.max(100, this.tuiPollIntervalMs));
    monitor.timer.unref?.();
  }

  async findPendingTui({ sessionId = null, cwd }) {
    if (sessionId) {
      validateSessionId(sessionId);
    }
    const fullCwd = validateWorkingDirectory(cwd);
    const leader = await this.leaderInfo();
    if (!leader.running) {
      return null;
    }
    const ownership = this.readLeaderOwnership();
    if (!ownership.valid) {
      return null;
    }
    const activeSessions = this.readActiveSessions();
    const candidates = [...listTuiStateRecords(this.tuiStateRoot)].reverse().filter(({ value }) => {
      if (!PENDING_TUI_STATUSES.has(value.status)
        || (sessionId && value.sessionId !== sessionId)
        || value.leaderOwnerToken !== ownership.record.ownerToken
        || typeof value.cwd !== "string"
        || !samePath(value.cwd, fullCwd)) {
        return false;
      }
      const assessment = this.assessRecordedTui(value, activeSessions, ownership);
      return assessment.pidAlive && assessment.processIdentityMatch && assessment.leaderOwnershipMatch;
    });
    if (candidates.length > 1) {
      throw codedError(
        "GROK_TUI_ACTIVATION_AMBIGUOUS",
        `Multiple Supervisor TUI launches are still awaiting activation for ${fullCwd}; refusing another launch`,
        { sessionIds: candidates.map(({ value }) => value.sessionId), pids: candidates.map(({ value }) => value.grokPid) },
      );
    }
    const record = candidates[0];
    if (!record) {
      return null;
    }
    const assessment = this.assessRecordedTui(record.value, activeSessions, ownership);
    if (assessment.activeRegistryMatch) {
      this.markTuiSessionReady({
        sessionId: record.value.sessionId,
        pid: record.value.grokPid,
        statePath: record.path,
      });
    } else {
      this.startTuiActivationMonitor({
        sessionId: record.value.sessionId,
        pid: record.value.grokPid,
        cwd: fullCwd,
        statePath: record.path,
      });
    }
    return {
      launched: false,
      recovered: true,
      ownedByCurrentMcp: this.tuiProcesses.has(record.value.grokPid),
      pid: record.value.grokPid,
      hostPid: record.value.hostPid ?? null,
      sessionId: record.value.sessionId,
      cwd: fullCwd,
      mode: "resume",
      presentation: "windows_terminal",
      statePath: record.path,
      launchId: record.value.launchId,
      ready: assessment.activeRegistryMatch,
      state: assessment.activeRegistryMatch
        ? "ready"
        : record.value.status === "awaiting_workspace_trust"
          ? "needs_workspace_trust"
          : "awaiting_session_registration",
      needsTerminalConfirmation: !assessment.activeRegistryMatch,
    };
  }

  async findRecoverableTui({ sessionId, cwd, activeSession }) {
    validateSessionId(sessionId);
    const fullCwd = validateWorkingDirectory(cwd);
    if (!activeSession || activeSession.session_id !== sessionId || !Number.isInteger(activeSession.pid)) {
      return null;
    }
    const leader = await this.leaderInfo();
    if (!leader.running) {
      return null;
    }
    const ownership = this.readLeaderOwnership();
    if (!ownership.valid) {
      return null;
    }
    const record = [...listTuiStateRecords(this.tuiStateRoot)].reverse().find(({ value }) => {
      if (value.status !== "running"
        || value.sessionId !== sessionId
        || value.leaderOwnerToken !== ownership.record.ownerToken
        || typeof value.cwd !== "string"
        || !samePath(value.cwd, fullCwd)
        || value.grokPid !== activeSession.pid) {
        return false;
      }
      return this.assessRecordedTui(value, [activeSession], ownership).processAlive;
    });
    if (!record) {
      return null;
    }
    return {
      launched: false,
      recovered: true,
      ownedByCurrentMcp: false,
      pid: record.value.grokPid,
      hostPid: record.value.hostPid ?? null,
      sessionId,
      cwd: fullCwd,
      mode: "resume",
      presentation: "windows_terminal",
      statePath: record.path,
      launchId: record.value.launchId,
    };
  }

  async stopOwnedTuiForRollback(pid) {
    const owned = this.tuiProcesses.get(pid);
    if (!owned) {
      throw new Error(`TUI PID ${pid} is not owned by this MCP process`);
    }
    const state = readJsonFile(owned.statePath);
    const stateMatches = state?.launchId === owned.launchId
      && state.grokPid === pid
      && state.grokProcessFingerprint === owned.processFingerprint
      && state.sessionId === owned.sessionId
      && typeof state.cwd === "string"
      && samePath(state.cwd, owned.cwd);
    if (!stateMatches || !this.ownedTuiIdentityMatches(pid, owned)) {
      this.tuiProcesses.delete(pid);
      throw new Error(`TUI PID ${pid} no longer matches the owned launch identity; refusing to terminate it`);
    }
    if (this.ownedTuiIdentityMatches(pid, owned)) {
      process.kill(pid);
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this.ownedTuiIdentityMatches(pid, owned)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (this.ownedTuiIdentityMatches(pid, owned)) {
      throw new Error(`Owned TUI PID ${pid} did not stop during rollback`);
    }
    const hostIdentity = owned.hostPid && typeof owned.hostProcessFingerprint === "string"
      ? this.inspectProcessIdentity(owned.hostPid)
      : null;
    if (hostIdentity?.fingerprint === owned.hostProcessFingerprint) {
      try {
        process.kill(owned.hostPid);
      } catch {
        // The fixed host may already be exiting after its Grok child stopped.
      }
    }
    this.tuiProcesses.delete(pid);
    if (state) {
      writeJsonAtomic(owned.statePath, {
        ...state,
        status: "rolled_back",
        updatedAt: new Date().toISOString(),
      });
    }
    this.record("tui_rollback_stopped", { pid, hostPid: owned.hostPid ?? null, statePath: owned.statePath });
    return { stopped: true, pid, hostPid: owned.hostPid ?? null };
  }

  async openSession({ mode, sessionId, cwd, presentation = "windows_terminal", confirmation }) {
    if (!new Set(["new", "resume"]).has(mode)) {
      throw new Error("mode must be new or resume");
    }
    if (!new Set(["windows_terminal", "none"]).has(presentation)) {
      throw new Error("presentation must be windows_terminal or none");
    }
    if (mode === "resume") {
      validateSessionId(sessionId);
    } else if (sessionId !== undefined && sessionId !== null && sessionId !== "") {
      throw new Error("sessionId must be omitted when mode is new");
    }
    const fullCwd = validateWorkingDirectory(cwd);
    const requiredConfirmation = presentation === "none"
      ? "OPEN_GROK_SESSION_HEADLESS"
      : "OPEN_GROK_SESSION";
    if (confirmation !== requiredConfirmation) {
      throw new Error(`confirmation must equal ${requiredConfirmation} for presentation ${presentation}`);
    }
    const requestedSessionId = mode === "resume" ? sessionId : undefined;
    const pendingTui = presentation === "windows_terminal"
      ? await this.findPendingTui({ sessionId: requestedSessionId || null, cwd: fullCwd })
      : null;
    const active = mode === "resume"
      ? this.readActiveSessions().find((entry) => entry.session_id === requestedSessionId)
      : null;
    const recoverableTui = active
      ? await this.findRecoverableTui({ sessionId: requestedSessionId, cwd: fullCwd, activeSession: active })
      : null;
    if (active && !recoverableTui && !pendingTui) {
      throw new Error(`Session is already active in PID ${active.pid}; refusing a concurrent open`);
    }

    let startedLeader = false;
    let tuiPid = null;
    const rollback = [];
    let finalSessionId = requestedSessionId;
    let bootstrapAttachment = null;
    try {
      const leader = await this.startLeader({ cwd: fullCwd });
      startedLeader = leader.started === true;
      if (!startedLeader && leader.managed !== true) {
        throw new Error(`Existing Leader is not backed by a verified plugin ownership record or matching proxy record (${leader.reason})`);
      }
      if (pendingTui) {
        finalSessionId = pendingTui.sessionId;
        const attachment = await this.attachSession({
          mode: "resume",
          sessionId: finalSessionId,
          cwd: fullCwd,
          interactiveWorkspaceTrust: true,
        });
        const activation = this.sessionActivationSnapshot(finalSessionId, fullCwd) || {
          state: pendingTui.state,
          sessionId: finalSessionId,
          cwd: fullCwd,
          tuiPid: pendingTui.pid,
          confirmationSurface: pendingTui.needsTerminalConfirmation ? "visible_tui" : null,
        };
        this.record("session_activation_recovered", {
          sessionId: finalSessionId,
          cwd: fullCwd,
          tuiPid: pendingTui.pid,
          statePath: pendingTui.statePath,
          activationState: activation.state,
        });
        return {
          opened: true,
          recovered: true,
          ready: pendingTui.ready === true,
          state: pendingTui.ready === true ? "ready" : activation.state,
          needsTerminalConfirmation: pendingTui.needsTerminalConfirmation === true,
          mode,
          sessionId: finalSessionId,
          cwd: fullCwd,
          presentation: "windows_terminal",
          requestedPresentation: presentation,
          leader,
          tui: pendingTui,
          attachment,
          activation,
        };
      }
      if (recoverableTui) {
        const attachment = await this.attachSession({
          mode: "resume",
          sessionId: finalSessionId,
          cwd: fullCwd,
          interactiveWorkspaceTrust: true,
        });
        this.record("session_recovered", {
          sessionId: finalSessionId,
          cwd: fullCwd,
          tuiPid: recoverableTui.pid,
          statePath: recoverableTui.statePath,
        });
        return {
          opened: true,
          recovered: true,
          ready: true,
          state: "ready",
          needsTerminalConfirmation: false,
          mode,
          sessionId: finalSessionId,
          cwd: fullCwd,
          presentation: "windows_terminal",
          requestedPresentation: presentation,
          leader,
          tui: recoverableTui,
          attachment,
        };
      }

      let tui = null;
      let attachment = null;
      let activation = null;
      if (presentation === "windows_terminal") {
        attachment = await this.attachSession({
          mode,
          sessionId: finalSessionId,
          cwd: fullCwd,
          interactiveWorkspaceTrust: true,
        });
        finalSessionId = attachment.sessionId;
        if (mode === "new") {
          bootstrapAttachment = attachment;
        }
        tui = await this.launchTui({
          sessionId: finalSessionId,
          cwd: fullCwd,
          mode: "resume",
          confirmation: "LAUNCH_VISIBLE_TUI",
        });
        tuiPid = tui.pid;
        activation = await this.waitForTuiSession({ sessionId: finalSessionId, pid: tuiPid });
      } else {
        attachment = await this.attachSession({
          mode,
          sessionId: finalSessionId,
          cwd: fullCwd,
          interactiveWorkspaceTrust: false,
        });
        finalSessionId = attachment.sessionId;
        activation = {
          observed: true,
          ready: true,
          state: "ready",
          needsTerminalConfirmation: false,
        };
      }
      this.record("session_opened", {
        mode,
        sessionId: finalSessionId,
        cwd: fullCwd,
        presentation,
        tuiPid,
        activationState: activation.state,
      });
      return {
        opened: true,
        recovered: false,
        ready: activation.ready === true,
        state: activation.state,
        needsTerminalConfirmation: activation.needsTerminalConfirmation === true,
        mode,
        sessionId: finalSessionId,
        cwd: fullCwd,
        presentation,
        leader,
        tui,
        attachment,
        bootstrapAttachment,
        activation,
      };
    } catch (error) {
      await this.disconnect()
        .then(() => rollback.push("acp_disconnected"))
        .catch((rollbackError) => rollback.push(`acp_disconnect_failed:${conciseError(rollbackError)}`));
      const rollbackTuiPid = tuiPid ?? (Number.isInteger(error?.ownedTuiPid) ? error.ownedTuiPid : null);
      if (rollbackTuiPid) {
        await this.stopOwnedTuiForRollback(rollbackTuiPid)
          .then(() => rollback.push("owned_tui_stopped"))
          .catch((rollbackError) => rollback.push(`owned_tui_stop_failed:${conciseError(rollbackError)}`));
      }
      if (startedLeader && (this.leaderProcess?.pid || this.readLeaderOwnership().valid)) {
        await this.stopOwnedLeader({ confirmation: "STOP_OWNED_LEADER" })
          .then(() => rollback.push("owned_leader_stopped"))
          .catch((rollbackError) => rollback.push(`owned_leader_stop_failed:${conciseError(rollbackError)}`));
      }
      const message = conciseError(error);
      const rollbackComplete = !rollback.some((step) => step.includes("_failed:"));
      this.record("session_open_failed", {
        mode,
        sessionId: finalSessionId,
        cwd: fullCwd,
        presentation,
        message,
        rollback,
        rollbackComplete,
        verificationRequired: true,
        bootstrapSessionId: bootstrapAttachment?.sessionId ?? null,
      });
      const openError = new Error(`Could not open Grok session${finalSessionId ? ` ${finalSessionId}` : ""}: ${message}. Rollback: ${rollback.join(", ") || "none"}`);
      openError.code = "GROK_SESSION_OPEN_FAILED";
      openError.details = {
        mode,
        sessionId: finalSessionId ?? null,
        cwd: fullCwd,
        presentation,
        rollback,
        rollbackComplete,
        verificationRequired: true,
      };
      throw openError;
    }
  }

  async attachSession({ mode = "resume", sessionId, cwd, interactiveWorkspaceTrust = false }) {
    if (!new Set(["new", "resume"]).has(mode)) {
      throw new Error("mode must be new or resume");
    }
    if (mode === "resume") {
      validateSessionId(sessionId);
    }
    const fullCwd = validateWorkingDirectory(cwd);
    if (this.acpConnection && !this.acpConnection.signal.aborted) {
      if (mode === "resume" && this.attachedSessionId === sessionId && samePath(this.attachedCwd, fullCwd)) {
        return { attached: false, reason: "already_attached", sessionId, cwd: fullCwd };
      }
      throw new Error(`ACP is already attached to ${this.attachedSessionId}; disconnect first`);
    }
    const leader = await this.leaderInfo();
    if (!leader.running) {
      throw new Error("Dedicated Leader is not running");
    }
    if (!this.leaderProxyContext?.environment) {
      throw new Error("Dedicated Leader proxy context is unavailable; refusing an unverified attachment");
    }

    const child = this.spawnProcess(this.grokBinary, buildGrokAcpArgs({
      leaderSocket: this.socketPath,
    }), {
      cwd: fullCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.leaderProxyContext.environment,
    });
    this.acpProcess = child;
    child.stderr?.on("data", (chunk) => this.captureDiagnostic("acp_stderr", chunk));
    child.once("exit", (code, signal) => {
      this.record("acp_exit", { pid: child.pid, code, signal });
      for (const pending of this.workspaceTrustSummaries().filter((entry) => samePath(entry.cwd, fullCwd))) {
        this.resolveWorkspaceTrust({
          sessionId: pending.sessionId,
          workspace: pending.workspace,
          outcome: "reject",
          reason: "acp_process_exited",
        });
      }
      if (this.acpProcess === child) {
        this.acpProcess = null;
      }
    });

    this.pendingAttachCwd = fullCwd;
    const app = acp
      .client({ name: "grok-build-supervisor" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.handlePermission(ctx.params))
      .onRequest(acp.methods.client.elicitation.create, (ctx) => this.handleElicitation(ctx.params));
    for (const method of WORKSPACE_TRUST_ACP_METHODS) {
      const parseRequest = method.startsWith("_")
        ? parseWorkspaceTrustGatewayRequest
        : parseWorkspaceTrustRequest;
      app.onRequest(method, parseRequest, (ctx) => this.handleWorkspaceTrustRequest(ctx.params));
    }
    app.onNotification(acp.methods.client.session.update, (ctx) => this.handleSessionUpdate(ctx.params));
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const connection = app.connect(stream);

    try {
      const clientCapabilities = buildAcpClientCapabilities({ interactiveWorkspaceTrust });
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities,
      });
      await this.ensureLeaderProxyRouteVerified();
      let finalSessionId = sessionId;
      let created = false;
      if (mode === "new") {
        const createdSession = await connection.agent.request(acp.methods.agent.session.new, {
          cwd: fullCwd,
          mcpServers: [],
        });
        finalSessionId = validateSessionId(createdSession.sessionId);
        created = true;
        this.record("session_created", { sessionId: finalSessionId, cwd: fullCwd });
      } else {
        if (initialized.agentCapabilities?.loadSession !== true) {
          throw new Error("Grok ACP agent did not advertise loadSession capability");
        }
        await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: finalSessionId,
          cwd: fullCwd,
          mcpServers: [],
        });
      }
      this.acpConnection = connection;
      this.acpContext = connection.agent;
      this.attachedSessionId = finalSessionId;
      this.attachedCwd = fullCwd;
      this.pendingAttachCwd = null;
      this.record("session_attached", { sessionId: finalSessionId, cwd: fullCwd, pid: child.pid, created });
      return {
        attached: true,
        created,
        sessionId: finalSessionId,
        cwd: fullCwd,
        pid: child.pid,
        protocolVersion: initialized.protocolVersion,
      };
    } catch (error) {
      for (const pending of this.workspaceTrustSummaries().filter((entry) => samePath(entry.cwd, fullCwd))) {
        this.resolveWorkspaceTrust({
          sessionId: pending.sessionId,
          workspace: pending.workspace,
          outcome: "reject",
          reason: "acp_attachment_failed",
        });
      }
      connection.close(error);
      child.kill();
      this.acpProcess = null;
      this.pendingAttachCwd = null;
      throw error;
    }
  }

  handleSessionUpdate(params) {
    const text = agentMessageText(params.update);
    if (text && this.activeRun?.status === "running" && this.activeRun.sessionId === params.sessionId) {
      const messageId = typeof params.update.messageId === "string" && params.update.messageId
        ? params.update.messageId
        : "__implicit__";
      const newMessage = messageId !== this.activeRun.latestMessageId;
      if (newMessage) {
        this.activeRun.messageCount += 1;
      }
      this.activeRun.totalMessageChars += text.length;
      this.activeRun.progress.lastChunkAt = new Date().toISOString();
      this.activeRun.progress.dirtySinceLastRecord = true;
      if (newMessage && this.activeRun.finalText) {
        const separator = "\n\n";
        const separatorRemaining = Math.max(0, MAX_FINAL_TEXT_CHARS - this.activeRun.finalText.length);
        this.activeRun.finalText += separator.slice(0, separatorRemaining);
        if (separator.length > separatorRemaining) {
          this.activeRun.finalTextTruncated = true;
        }
      }
      const remaining = Math.max(0, MAX_FINAL_TEXT_CHARS - this.activeRun.finalText.length);
      if (remaining > 0) {
        this.activeRun.finalText += text.slice(0, remaining);
      }
      if (text.length > remaining) {
        this.activeRun.finalTextTruncated = true;
      }
      if (messageId && messageId !== this.activeRun.latestMessageId) {
        this.activeRun.latestMessageId = messageId;
        this.activeRun.latestMessage = "";
        this.activeRun.latestMessageTruncated = false;
      }
      const messageRemaining = Math.max(0, MAX_FINAL_TEXT_CHARS - this.activeRun.latestMessage.length);
      if (messageRemaining > 0) {
        this.activeRun.latestMessage += text.slice(0, messageRemaining);
      }
      if (text.length > messageRemaining) {
        this.activeRun.latestMessageTruncated = true;
      }
    }
    if (params.update?.sessionUpdate === "agent_message_chunk"
      || params.update?.sessionUpdate === "agent_thought_chunk") {
      return null;
    }
    if (params.update?.sessionUpdate === "available_commands_update") {
      return this.handleAvailableCommandsUpdate(params.sessionId, params.update.availableCommands);
    }
    if (["tool_call", "tool_call_update", "plan"].includes(params.update?.sessionUpdate)) {
      const activeRunMatches = this.activeRun?.status === "running"
        && this.activeRun.sessionId === params.sessionId;
      return activeRunMatches
        ? this.updateRunProgress(params.sessionId, params.update)
        : this.recordInactiveRunActivity(params.sessionId, params.update);
    }
    return this.record("session_update", { sessionId: params.sessionId, update: params.update });
  }

  handleElicitation(params) {
    if (params.mode !== "form" || typeof params.sessionId !== "string" || params.sessionId !== this.attachedSessionId) {
      this.record("elicitation_declined", {
        sessionId: params.sessionId ?? null,
        mode: params.mode,
        reason: "only form elicitation for the attached session is supported",
      });
      return { action: "decline" };
    }
    const elicitationId = randomUUID();
    const summary = {
      elicitationId,
      sessionId: params.sessionId,
      toolCallId: params.toolCallId || null,
      message: typeof params.message === "string" ? params.message : "Grok needs additional input.",
      requestedSchema: compactForTransport(params.requestedSchema || { type: "object", properties: {} }, 8 * 1024),
      requestedAt: new Date().toISOString(),
    };
    this.record("elicitation_requested", summary);
    return new Promise((resolveElicitation) => {
      this.pendingElicitations.set(elicitationId, { params, summary, resolve: resolveElicitation });
    });
  }

  elicitationSummaries() {
    return [...this.pendingElicitations.values()].map((entry) => entry.summary);
  }

  answerElicitation({ elicitationId, action, content, confirmation }) {
    if (confirmation !== "ANSWER_GROK_INPUT") {
      throw new Error("confirmation must equal ANSWER_GROK_INPUT");
    }
    const pending = this.pendingElicitations.get(elicitationId);
    if (!pending) {
      throw new Error(`Unknown or already answered elicitation: ${elicitationId}`);
    }
    if (action === "cancel" || action === "decline") {
      pending.resolve({ action });
      this.pendingElicitations.delete(elicitationId);
      this.record("elicitation_answered", { elicitationId, action });
      return { answered: true, elicitationId, action };
    }
    if (action !== "accept") {
      throw new Error("elicitation action must be accept, decline, or cancel");
    }
    const validated = validateElicitationContent(pending.params.requestedSchema, content);
    pending.resolve({ action: "accept", content: validated });
    this.pendingElicitations.delete(elicitationId);
    this.record("elicitation_answered", { elicitationId, action, content: validated });
    return { answered: true, elicitationId, action };
  }

  respond(args) {
    const hasPermission = typeof args.permissionId === "string";
    const hasElicitation = typeof args.elicitationId === "string";
    if (hasPermission === hasElicitation) {
      throw new Error("provide exactly one of permissionId or elicitationId");
    }
    return hasPermission ? this.answerPermission(args) : this.answerElicitation(args);
  }

  handlePermission(params) {
    const permissionId = randomUUID();
    const summary = {
      permissionId,
      sessionId: params.sessionId,
      toolTitle: params.toolCall?.title || "Unnamed tool call",
      toolCallId: params.toolCall?.toolCallId || null,
      options: (params.options || []).slice(0, 20).map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      requestedAt: new Date().toISOString(),
    };
    this.record("permission_requested", summary);
    return new Promise((resolvePermission) => {
      this.pendingPermissions.set(permissionId, { params, summary, resolve: resolvePermission });
    });
  }

  permissionSummaries() {
    return [...this.pendingPermissions.values()].map((entry) => entry.summary);
  }

  answerPermission({ permissionId, action, optionId, confirmation }) {
    if (confirmation !== "ANSWER_GROK_PERMISSION") {
      throw new Error("confirmation must equal ANSWER_GROK_PERMISSION");
    }
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error(`Unknown or already answered permission: ${permissionId}`);
    }
    if (action === "cancel") {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.pendingPermissions.delete(permissionId);
      this.record("permission_answered", { permissionId, action: "cancel" });
      return { answered: true, permissionId, action: "cancel" };
    }
    if (action !== "select") {
      throw new Error("action must be select or cancel");
    }
    const allowed = pending.summary.options.some((option) => option.optionId === optionId);
    if (!allowed) {
      throw new Error("optionId is not one of the options returned by Grok");
    }
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    this.pendingPermissions.delete(permissionId);
    this.record("permission_answered", { permissionId, action: "select", optionId });
    return { answered: true, permissionId, action: "select", optionId };
  }

  startPrompt({ sessionId, prompt, confirmation, hostKind = "unknown" }) {
    validateSessionId(sessionId);
    if (confirmation !== "SEND_TO_GROK") {
      throw new Error("confirmation must equal SEND_TO_GROK");
    }
    if (!this.acpContext || !this.acpConnection || this.acpConnection.signal.aborted) {
      throw new Error("No live ACP attachment");
    }
    if (this.attachedSessionId !== sessionId) {
      throw new Error(`ACP is attached to ${this.attachedSessionId}, not ${sessionId}`);
    }
    const activation = this.sessionActivationSnapshot(sessionId, this.attachedCwd);
    if (activation?.state === "needs_workspace_trust") {
      throw codedError(
        "GROK_WORKSPACE_TRUST_PENDING",
        "The visible Grok terminal is waiting for workspace trust confirmation; confirm it there before sending work",
        activation,
      );
    }
    if (activation?.state === "awaiting_session_registration") {
      throw codedError(
        "GROK_TUI_ACTIVATION_PENDING",
        "The visible Grok terminal is still starting; wait for it to become ready before sending work",
        activation,
      );
    }
    if (this.activeRun?.status === "running") {
      throw new Error(`Prompt ${this.activeRun.runId} is still running`);
    }
    if (this.recovery.interruptedRun?.sessionId === sessionId) {
      throw new Error(`Prompt ${this.recovery.interruptedRun.runId} has unknown state after Supervisor restart; inspect it and explicitly cancel before sending a new prompt`);
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("prompt must be non-empty");
    }
    const normalizedHostKind = normalizeHostKind(hostKind);
    const supervisedPrompt = buildSupervisedPrompt(prompt, normalizedHostKind);
    if (supervisedPrompt.length > 100_000) {
      throw new Error("prompt plus the supervision contract must be at most 100000 characters");
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const run = {
      runId,
      sessionId,
      hostKind: normalizedHostKind,
      status: "running",
      startedAt,
      completedAt: null,
      terminalSequence: null,
      result: null,
      finalText: "",
      finalTextTruncated: false,
      latestMessageId: null,
      latestMessage: "",
      latestMessageTruncated: false,
      messageCount: 0,
      totalMessageChars: 0,
      toolCalls: new Map(),
      progress: {
        phase: "starting",
        current: null,
        filesRead: new Set(),
        filesChanged: new Set(),
        updatedAt: startedAt,
        heartbeatAt: null,
        lastChunkAt: null,
        dirtySinceLastRecord: true,
      },
      progressTimer: null,
      resultArtifact: null,
      resultSummary: null,
      artifactError: null,
      question: null,
      error: null,
    };
    this.inactiveRunActivity.clear();
    this.activeRun = run;
    const startedEvent = this.record("prompt_started", { runId, sessionId, hostKind: normalizedHostKind, promptLength: prompt.length });
    const progressEvent = this.recordRunProgress(run);
    this.startRunProgressHeartbeat(run);
    run.promise = this.acpContext.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: supervisedPrompt }],
    }).then((result) => {
      this.stopRunProgressHeartbeat(run);
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.progress.phase = "completed";
      run.progress.current = null;
      run.progress.updatedAt = run.completedAt;
      run.result = compactForTransport(result);
      run.messageCount ||= run.totalMessageChars > 0 ? 1 : 0;
      const aggregateText = run.finalText;
      const aggregateTextTruncated = run.finalTextTruncated;
      const terminalMessage = run.latestMessage || aggregateText;
      const terminalQuestion = parseSupervisorQuestion(terminalMessage);
      if (terminalQuestion && terminalMessage) {
        run.finalText = terminalMessage;
        run.finalTextTruncated = run.latestMessage
          ? run.latestMessageTruncated
          : aggregateTextTruncated;
      } else if (run.messageCount <= 1 && run.latestMessage) {
        run.finalText = run.latestMessage;
        run.finalTextTruncated = run.latestMessageTruncated;
      } else {
        run.finalText = aggregateText;
        run.finalTextTruncated = aggregateTextTruncated;
      }
      run.question = terminalQuestion;
      if (!run.question && run.finalText) {
        try {
          run.resultArtifact = this.persistResultArtifact({
            root: this.resultArtifactRoot,
            sessionId,
            runId,
            text: run.finalText,
            sourceChars: run.totalMessageChars,
            truncated: run.finalTextTruncated,
            inlineMaxBytes: this.inlineResultMaxBytes,
          });
          if (run.resultArtifact) {
            run.finalText = "";
            run.latestMessage = "";
          }
        } catch (error) {
          run.artifactError = conciseError(error);
          if (Buffer.byteLength(run.finalText, "utf8") > this.inlineResultMaxBytes) {
            run.resultSummary = summarizeResultText(run.finalText);
            run.finalText = "";
            run.latestMessage = "";
            run.finalTextTruncated = true;
          }
          this.record("result_artifact_failed", {
            runId,
            sessionId,
            message: run.artifactError,
          });
        }
      }
      const completedEvent = this.record("prompt_completed", {
        runId,
        sessionId,
        result: run.result,
        finalText: run.finalText || null,
        resultArtifact: run.resultArtifact,
        resultSummary: run.resultSummary,
        artifactError: run.artifactError,
        responseTruncated: run.finalTextTruncated,
        messageCount: run.messageCount,
        progress: runProgressSnapshot(run),
        question: run.question,
      });
      run.terminalSequence = completedEvent.sequence;
    }).catch((error) => {
      this.stopRunProgressHeartbeat(run);
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.progress.phase = "failed";
      run.progress.current = null;
      run.progress.updatedAt = run.completedAt;
      run.error = conciseError(error);
      const failedEvent = this.record("prompt_failed", {
        runId,
        sessionId,
        message: run.error,
        progress: runProgressSnapshot(run),
      });
      run.terminalSequence = failedEvent.sequence;
    });
    return {
      started: true,
      runId,
      sessionId,
      hostKind: normalizedHostKind,
      startedAt,
      nextAfterSequence: progressEvent?.sequence || startedEvent.sequence,
    };
  }

  updates({ afterSequence = 0, limit = DEFAULT_EVENT_LIMIT, sessionId = null } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT));
    return this.journal.updates({ afterSequence, limit: boundedLimit, sessionId });
  }

  async cancelPrompt({ sessionId, confirmation }) {
    validateSessionId(sessionId);
    if (confirmation !== "CANCEL_GROK_PROMPT") {
      throw new Error("confirmation must equal CANCEL_GROK_PROMPT");
    }
    if (!this.acpContext || this.attachedSessionId !== sessionId) {
      throw new Error("Requested session is not attached");
    }
    await this.acpContext.notify(acp.methods.agent.session.cancel, { sessionId });
    for (const [permissionId, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.pendingPermissions.delete(permissionId);
      this.record("permission_answered", { permissionId, action: "cancel", reason: "prompt_cancelled" });
    }
    for (const [elicitationId, pending] of this.pendingElicitations) {
      pending.resolve({ action: "cancel" });
      this.pendingElicitations.delete(elicitationId);
      this.record("elicitation_answered", { elicitationId, action: "cancel", reason: "prompt_cancelled" });
    }
    const runId = this.activeRun?.runId ?? this.recovery.interruptedRun?.runId ?? null;
    if (this.activeRun?.status === "running") {
      this.stopRunProgressHeartbeat(this.activeRun);
      this.activeRun.status = "cancel_requested";
    }
    this.record("prompt_cancel_requested", { sessionId, runId });
    if (this.recovery.interruptedRun?.sessionId === sessionId) {
      this.recovery.interruptedRun = null;
    }
    this.recovery.orphanedPermissions = this.recovery.orphanedPermissions
      .filter((permission) => permission.sessionId !== sessionId);
    this.recovery.orphanedElicitations = this.recovery.orphanedElicitations
      .filter((elicitation) => elicitation.sessionId !== sessionId);
    return { cancelRequested: true, sessionId };
  }

  async control({ action, sessionId, confirmation }) {
    if (confirmation !== "CONTROL_GROK_SESSION") {
      throw new Error("confirmation must equal CONTROL_GROK_SESSION");
    }
    if (action === "cancel_prompt") {
      return this.cancelPrompt({ sessionId, confirmation: "CANCEL_GROK_PROMPT" });
    }
    if (action === "disconnect") {
      return this.disconnect();
    }
    if (action === "stop_leader") {
      return this.stopOwnedLeader({ confirmation: "STOP_OWNED_LEADER" });
    }
    throw new Error("action must be cancel_prompt, disconnect, or stop_leader");
  }

  async disconnect() {
    for (const [permissionId, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.pendingPermissions.delete(permissionId);
      this.record("permission_answered", { permissionId, action: "cancel", reason: "disconnect" });
    }
    for (const [elicitationId, pending] of this.pendingElicitations) {
      pending.resolve({ action: "cancel" });
      this.pendingElicitations.delete(elicitationId);
      this.record("elicitation_answered", { elicitationId, action: "cancel", reason: "disconnect" });
    }
    for (const pending of this.workspaceTrustSummaries()) {
      this.resolveWorkspaceTrust({
        sessionId: pending.sessionId,
        workspace: pending.workspace,
        outcome: "reject",
        reason: "disconnect",
      });
    }
    if (this.activeRun?.status === "running" && this.acpContext && this.attachedSessionId) {
      await this.acpContext.notify(acp.methods.agent.session.cancel, { sessionId: this.attachedSessionId }).catch(() => {});
      this.stopRunProgressHeartbeat(this.activeRun);
      this.activeRun.status = "cancel_requested";
      this.record("prompt_cancel_requested", {
        sessionId: this.attachedSessionId,
        runId: this.activeRun.runId,
        reason: "disconnect",
      });
    }
    this.acpConnection?.close();
    if (this.acpProcess && processIsAlive(this.acpProcess.pid)) {
      this.acpProcess.kill();
    }
    const previous = this.attachedSessionId;
    this.acpProcess = null;
    this.acpConnection = null;
    this.acpContext = null;
    this.attachedSessionId = null;
    this.attachedCwd = null;
    this.pendingAttachCwd = null;
    this.availableCommandsSnapshots.clear();
    this.inactiveRunActivity.clear();
    this.record("session_disconnected", { sessionId: previous });
    return { disconnected: true, sessionId: previous };
  }

  async stopOwnedLeader({ confirmation }) {
    if (confirmation !== "STOP_OWNED_LEADER") {
      throw new Error("confirmation must equal STOP_OWNED_LEADER");
    }
    const ownership = this.readLeaderOwnership();
    const currentProcessPid = this.leaderProcess?.pid ?? null;
    if (!currentProcessPid && !ownership.valid) {
      throw new Error("No verified plugin ownership record exists for the Leader; refusing to stop it");
    }
    const ownerToken = ownership.valid ? ownership.record.ownerToken : null;
    const activeSessions = this.readActiveSessions();
    const recordedLiveTuis = listTuiStateRecords(this.tuiStateRoot)
      .filter(({ value }) => LIVE_TUI_STATUSES.has(value.status)
        && (!ownerToken || value.leaderOwnerToken === ownerToken)
        && this.assessRecordedTui(value, activeSessions, ownership).processAlive)
      .map(({ value }) => value.grokPid);
    const liveTuis = [...new Set([
      ...[...this.tuiProcesses.entries()]
        .filter(([pid, owned]) => this.ownedTuiIdentityMatches(pid, owned))
        .map(([pid]) => pid),
      ...recordedLiveTuis,
    ])];
    if (liveTuis.length > 0) {
      throw new Error(`Visible TUI still active in PID(s) ${liveTuis.join(", ")}; exit it normally first`);
    }
    await this.disconnect();
    const pid = ownership.valid ? ownership.record.leaderPid : currentProcessPid;
    if (currentProcessPid) {
      await this.runGrok(["leader", "--leader-socket", this.socketPath, "kill"]).catch(() => {});
    } else {
      await this.runGrok(["leader", "--leader-socket", this.socketPath, "kill"]);
    }
    if (currentProcessPid && processIsAlive(currentProcessPid)) {
      this.leaderProcess.kill();
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const info = await this.leaderInfo();
      if (!info.running && !processIsAlive(pid)) {
        this.removeStaleOwnedLock();
        this.clearLeaderOwnership(pid);
        this.leaderProxyContext = null;
        this.leaderProxyRoute = null;
        this.record("leader_stopped", { pid, socketPath: this.socketPath });
        return { stopped: true, pid, socketPath: this.socketPath };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    this.record("leader_stop_requested", { pid, socketPath: this.socketPath });
    throw new Error(`Leader stop did not settle within 5 seconds for PID ${pid}`);
  }
}
