import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedText(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function readCandidate({ projectDirectory, entryName, cwd, includePaths = false }) {
  if (!UUID_RE.test(entryName)) {
    return null;
  }
  const sessionDirectory = join(projectDirectory, entryName);
  const summaryPath = join(sessionDirectory, "summary.json");
  if (!existsSync(summaryPath)) {
    return null;
  }
  try {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    return {
      sessionId: entryName,
      title: boundedText(summary.generated_title || summary.session_summary, 300) || "Untitled Grok session",
      cwd: boundedText(summary.info?.cwd, 500) || resolve(cwd),
      updatedAt: summary.updated_at || null,
      lastActiveAt: summary.last_active_at || null,
      lastTurnSummary: boundedText(summary.last_turn_summary, 1200),
      lastRecap: boundedText(summary.last_recap, 1200),
      model: boundedText(summary.current_model_id, 100),
      messageCount: Number.isInteger(summary.num_chat_messages) ? summary.num_chat_messages : null,
      authority: "AGENT_SUMMARY_CLAIM",
      ...(includePaths ? { sessionDirectory, summaryPath } : {}),
    };
  } catch {
    return null;
  }
}

export function defaultSessionRoot(env = process.env) {
  const grokHome = env.GROK_HOME || join(homedir(), ".grok");
  return join(grokHome, "sessions");
}

export function encodedCwdDirectory(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error("cwd must be absolute before resolving Grok sessions");
  }
  return encodeURIComponent(resolve(cwd));
}

export function listSessionCandidates({ sessionRoot = defaultSessionRoot(), cwd, query = "", limit = 5 }) {
  const projectDirectory = join(sessionRoot, encodedCwdDirectory(cwd));
  if (!existsSync(projectDirectory)) {
    return [];
  }
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
  const candidates = [];
  for (const entry of readdirSync(projectDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) {
      continue;
    }
    const candidate = readCandidate({ projectDirectory, entryName: entry.name, cwd });
    if (!candidate) {
      continue;
    }
    const searchable = [candidate.title, candidate.lastTurnSummary, candidate.lastRecap]
      .filter(Boolean).join("\n").toLocaleLowerCase();
    if (!normalizedQuery || searchable.includes(normalizedQuery)) {
      candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  return candidates.slice(0, boundedLimit);
}

export function readSessionSummary({ sessionRoot = defaultSessionRoot(), cwd, sessionId }) {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    return null;
  }
  const projectDirectory = join(sessionRoot, encodedCwdDirectory(cwd));
  if (!existsSync(projectDirectory)) {
    return null;
  }
  return readCandidate({ projectDirectory, entryName: sessionId, cwd, includePaths: true });
}
