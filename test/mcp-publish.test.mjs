import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const publishScript = fileURLToPath(new URL("../scripts/publish-cursor-mcp.ps1", import.meta.url));

function createFakeNpm(root) {
  const fakeNpmScript = join(root, "fake-npm.mjs");
  const fakeNpmCommand = join(root, process.platform === "win32" ? "npm.cmd" : "npm");
  writeFileSync(fakeNpmScript, `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0] || "";
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");

if (command === "run" && args[1] === "build:mcp-packages") {
  const packageRoot = resolve(".mcp-package-stage", "vanyangyang-cursor-bridge");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "vanyangyang-cursor-bridge", version: "0.1.1" }));
  process.exit(0);
}
if (command === "pack") {
  const manifest = JSON.parse(readFileSync(resolve(args[1], "package.json"), "utf8"));
  const record = { name: manifest.name, version: manifest.version, shasum: "local-shasum" };
  console.log(JSON.stringify(process.env.FAKE_NPM_PACK_SHAPE === "keyed" ? { [manifest.name]: record } : [record]));
  process.exit(0);
}
if (command === "view") {
  if (process.env.FAKE_NPM_LOOKUP === "existing") {
    console.log(JSON.stringify(process.env.FAKE_NPM_MISMATCH === "true" ? "other-shasum" : "local-shasum"));
    process.exit(0);
  }
  if (process.env.FAKE_NPM_LOOKUP === "missing") {
    console.error("npm error code E404\\nnpm error No match found for version");
    process.exit(1);
  }
  console.error("npm error code E500\\nnpm error registry lookup failed");
  process.exit(1);
}
if (command === "publish") process.exit(0);
if (command === "whoami") {
  console.log(process.env.NPM_EXPECTED_USER || "publisher");
  process.exit(0);
}
process.exit(2);
`.trimStart());
  if (process.platform === "win32") {
    writeFileSync(fakeNpmCommand, `@echo off\r\n"${process.execPath}" "${fakeNpmScript}" %*\r\n`);
  } else {
    writeFileSync(fakeNpmCommand, `#!/bin/sh\nexec "${process.execPath}" "${fakeNpmScript}" "$@"\n`);
    chmodSync(fakeNpmCommand, 0o755);
  }
  return fakeNpmCommand;
}

function runScenario(t, { lookup, mismatch = false, tag = "cursor-bridge-mcp--v0.1.1", token } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cursor-bridge-mcp-publisher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logFile = join(root, "npm-calls.jsonl");
  writeFileSync(logFile, "");
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/request",
    FAKE_NPM_LOG: logFile,
    FAKE_NPM_LOOKUP: lookup || "missing",
    FAKE_NPM_MISMATCH: String(mismatch),
  };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  if (token !== undefined) env.NPM_TOKEN = token;
  const result = spawnSync("pwsh", [
    "-NoProfile", "-File", publishScript,
    "-RepositoryRoot", root,
    "-NpmCommand", createFakeNpm(root),
    "-ExpectedTag", tag,
  ], { cwd: repositoryRoot, encoding: "utf8", env });
  const calls = readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return { result, calls };
}

test("Cursor generic MCP workflow is an independent OIDC publisher", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "publish-cursor-mcp.yml"), "utf8");
  assert.match(workflow, /cursor-bridge-mcp--v\*/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /publish-cursor-mcp\.ps1/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.doesNotMatch(workflow, /publish-pi-packages\.ps1/);
});

test("Cursor generic MCP publisher publishes only a registry-confirmed missing package", (t) => {
  const { result, calls } = runScenario(t, { lookup: "missing" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const publishes = calls.filter(([command]) => command === "publish");
  assert.deepEqual(publishes, [["publish", join(".mcp-package-stage", "vanyangyang-cursor-bridge"), "--access", "public"]]);
});

test("Cursor generic MCP publisher skips an identical immutable version and rejects mismatches", (t) => {
  for (const mismatch of [false, true]) {
    const { result, calls } = runScenario(t, { lookup: "existing", mismatch });
    assert.equal(result.status === 0, !mismatch, result.stderr || result.stdout);
    assert.equal(calls.some(([command]) => command === "publish"), false);
  }
});

test("Cursor generic MCP publisher rejects wrong tags, uncertain registry state, and real tokens", (t) => {
  for (const scenario of [
    { tag: "cursor-bridge-mcp--v9.9.9", lookup: "missing" },
    { tag: "cursor-bridge-mcp--v0.1.1", lookup: "error" },
    { tag: "cursor-bridge-mcp--v0.1.1", lookup: "missing", token: "real-secret" },
  ]) {
    const { result, calls } = runScenario(t, scenario);
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.equal(calls.some(([command]) => command === "publish"), false);
  }
});
