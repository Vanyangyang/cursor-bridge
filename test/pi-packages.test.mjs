import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const buildScript = fileURLToPath(new URL("../scripts/build-pi-packages.mjs", import.meta.url));

test("Pi package staging keeps both products independent and complete", (t) => {
  const output = mkdtempSync(join(tmpdir(), "cursor-bridge-pi-packages-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const built = spawnSync(process.execPath, [
    buildScript,
    "--out",
    output,
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const cursor = JSON.parse(readFileSync(join(output, "pi-cursor-bridge", "package.json"), "utf8"));
  const grok = JSON.parse(readFileSync(join(output, "pi-grok-build-supervisor", "package.json"), "utf8"));
  assert.equal(cursor.name, "pi-cursor-bridge");
  assert.equal(cursor.version, "0.1.3");
  assert.equal(cursor.piPackage.embeddedProductVersion, "5.5.0");
  assert.equal(grok.name, "pi-grok-build-supervisor");
  assert.equal(grok.version, "0.1.2");
  assert.equal(grok.piPackage.embeddedProductVersion, "0.3.7");
  assert.deepEqual(cursor.pi.extensions, ["./extensions/index.ts"]);
  assert.deepEqual(grok.pi.prompts, ["./prompts/grok_init.md", "./prompts/grok_execute.md"]);
  assert.match(readFileSync(join(output, "pi-cursor-bridge", "dist", "cursor-bridge.mjs"), "utf8"), /cursor_context_engine/);
  const cursorExtension = readFileSync(join(output, "pi-cursor-bridge", "extensions", "index.ts"), "utf8");
  assert.match(cursorExtension, /cwd: hostCwd/);
  assert.match(cursorExtension, /CODEX_THREAD_ID: undefined/);
  assert.match(cursorExtension, /CURSOR_BRIDGE_HOST_ID: `pi:\$\{hostWorkspaceId\}`/);
  assert.match(cursorExtension, /CURSOR_PROJECT_PATH: hostCwd/);
  const cursorMcpAdapter = readFileSync(join(output, "pi-cursor-bridge", "extensions", "mcp-stdio.ts"), "utf8");
  assert.match(cursorMcpAdapter, /DEFAULT_TOOL_TIMEOUT_MS = 15 \* 60 \* 1000/);
  assert.match(cursorMcpAdapter, /timeout: toolTimeoutMs/);
  assert.match(cursorMcpAdapter, /maxTotalTimeout: toolTimeoutMs/);
  const grokExtension = readFileSync(join(output, "pi-grok-build-supervisor", "extensions", "index.ts"), "utf8");
  assert.match(grokExtension, /CODEX_THREAD_ID: undefined/);
  assert.match(grokExtension, /CLAUDE_CODE_SESSION_ID: undefined/);
  assert.match(grokExtension, /GROK_SUPERVISOR_HOST_KIND: "pi"/);
  const grokBundle = readFileSync(join(output, "pi-grok-build-supervisor", "dist", "grok-build-supervisor.mjs"), "utf8");
  assert.match(grokBundle, /grok_session_inspect/);
  assert.match(grokBundle, /version: "0\.3\.7"/);
  assert.match(readFileSync(join(output, "pi-grok-build-supervisor", "prompts", "grok_execute.md"), "utf8"), /\$ARGUMENTS/);
});

test("Pi publisher verifies registry tarball identity before skipping an existing version", () => {
  const script = readFileSync(join(repositoryRoot, "scripts", "publish-pi-packages.ps1"), "utf8");
  assert.match(script, /\$npmUserOutput = @\(& npm whoami 2>&1\)/);
  assert.doesNotMatch(script, /\(& npm whoami\)\.Trim\(\)/);
  assert.match(script, /npm pack \$package --json --dry-run/);
  assert.match(script, /npm view \$packageSpec dist\.shasum --json/);
  assert.match(script, /published tarball differs from the local package/);
  assert.doesNotMatch(script, /Skipping \$packageSpec because it is already published/);
});
