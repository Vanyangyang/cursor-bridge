import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEFAULT_INLINE_RESULT_MAX_BYTES = 4_000;
export const DEFAULT_RESULT_SUMMARY_CHARS = 800;

function exactUuid(value, name) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`${name} must be an exact UUID`);
  }
  return value;
}

export function summarizeResultText(text, maxChars = DEFAULT_RESULT_SUMMARY_CHARS) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  const bounded = Math.max(100, Math.min(Number(maxChars) || DEFAULT_RESULT_SUMMARY_CHARS, 2_000));
  return normalized.length > bounded
    ? `${normalized.slice(0, bounded)}…`
    : normalized;
}

export function persistResultArtifact({
  root,
  sessionId,
  runId,
  text,
  sourceChars = null,
  truncated = false,
  inlineMaxBytes = DEFAULT_INLINE_RESULT_MAX_BYTES,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("result artifact root is required");
  }
  exactUuid(sessionId, "sessionId");
  exactUuid(runId, "runId");
  if (typeof text !== "string") {
    throw new Error("result artifact text must be a string");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const boundedInlineBytes = Math.max(0, Number(inlineMaxBytes) || 0);
  if (bytes <= boundedInlineBytes) {
    return null;
  }

  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const artifactRoot = resolve(root);
  const directory = join(artifactRoot, sessionId);
  const artifactPath = join(directory, `${runId}-${digest.slice(0, 16)}.md`);
  mkdirSync(directory, { recursive: true });
  if (existsSync(artifactPath)) {
    const existingDigest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
    if (existingDigest !== digest) {
      throw new Error(`Existing result artifact failed its content hash check: ${artifactPath}`);
    }
  }
  if (!existsSync(artifactPath)) {
    const temporaryPath = join(directory, `.${runId}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        renameSync(temporaryPath, artifactPath);
      } catch (error) {
        if (!existsSync(artifactPath)) {
          throw error;
        }
        rmSync(temporaryPath, { force: true });
      }
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
  const storedDigest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  if (storedDigest !== digest) {
    throw new Error(`Persisted result artifact failed its content hash check: ${artifactPath}`);
  }

  return {
    schemaVersion: 1,
    path: artifactPath,
    bytes,
    sha256: digest,
    mediaType: "text/markdown; charset=utf-8",
    summary: summarizeResultText(text),
    capturedChars: text.length,
    sourceChars: Number.isInteger(sourceChars) && sourceChars >= text.length ? sourceChars : text.length,
    truncated: truncated === true,
    createdAt: now(),
  };
}
