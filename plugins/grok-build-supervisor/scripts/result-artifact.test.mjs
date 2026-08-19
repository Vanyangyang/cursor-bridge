import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistResultArtifact,
  summarizeResultText,
} from "./result-artifact.mjs";

const SESSION_ID = "01a010fc-7377-7330-b20f-9089aa5d93b6";
const RUN_ID = "01900000-0000-7000-8000-000000000002";

test("short final responses stay inline without creating an artifact", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-result-short-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = persistResultArtifact({
    root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    text: "Short result.",
  });
  assert.equal(artifact, null);
  assert.equal(existsSync(join(root, SESSION_ID)), false);
});

test("long final responses become immutable hashed artifacts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-result-long-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const text = `# Long report\n\n${"evidence line\n".repeat(800)}`;
  const artifact = persistResultArtifact({
    root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    text,
    sourceChars: text.length + 25,
    truncated: true,
    now: () => "2026-08-19T00:00:00.000Z",
  });
  assert.equal(readFileSync(artifact.path, "utf8"), text);
  assert.equal(artifact.bytes, Buffer.byteLength(text));
  assert.equal(artifact.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(artifact.sourceChars, text.length + 25);
  assert.equal(artifact.capturedChars, text.length);
  assert.equal(artifact.truncated, true);
  assert.ok(artifact.summary.length <= 801);

  const repeated = persistResultArtifact({ root, sessionId: SESSION_ID, runId: RUN_ID, text });
  assert.equal(repeated.path, artifact.path);
  assert.equal(readFileSync(repeated.path, "utf8"), text);

  writeFileSync(artifact.path, "corrupted", "utf8");
  assert.throws(() => persistResultArtifact({ root, sessionId: SESSION_ID, runId: RUN_ID, text }), /content hash check/);
});

test("artifact identifiers cannot escape the persistent result root", () => {
  assert.throws(() => persistResultArtifact({
    root: tmpdir(),
    sessionId: "../outside",
    runId: RUN_ID,
    text: "x".repeat(5_000),
  }), /exact UUID/);
  assert.equal(summarizeResultText(`a  b\r\n${"c".repeat(2_000)}`, 120).length, 121);
});
