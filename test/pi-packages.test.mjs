import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const buildScript = fileURLToPath(new URL("../scripts/build-pi-packages.mjs", import.meta.url));
const publishScript = fileURLToPath(new URL("../scripts/publish-pi-packages.ps1", import.meta.url));

function createFakeNpm(root) {
  const fakeNpmScript = join(root, "fake-npm.mjs");
  const fakeNpmCommand = join(root, process.platform === "win32" ? "npm.cmd" : "npm");
  writeFileSync(fakeNpmScript, `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0] || "";
const lookups = JSON.parse(process.env.FAKE_NPM_LOOKUPS || "{}");
const shasums = JSON.parse(process.env.FAKE_NPM_SHASUMS || "{}");
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");

if (command === "run" && args[1] === "build:pi-packages") {
  for (const [name, version] of [["pi-cursor-bridge", "0.1.8"], ["pi-grok-build-supervisor", "0.1.4"]]) {
    const packageRoot = resolve(".pi-package-stage", name);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, version, pi: { extensions: [] } }));
  }
  process.exit(0);
}

if (command === "pack") {
  const manifest = JSON.parse(readFileSync(resolve(args[1], "package.json"), "utf8"));
  const packRecord = { name: manifest.name, version: manifest.version, shasum: shasums[manifest.name] };
  console.log(JSON.stringify(process.env.FAKE_NPM_PACK_SHAPE === "keyed"
    ? { [manifest.name]: packRecord }
    : [packRecord]));
  process.exit(0);
}

if (command === "view") {
  const result = lookups[args[1]] || { kind: "error", code: "E500" };
  if (result.kind === "existing") {
    console.log(JSON.stringify(result.shasum));
    process.exit(0);
  }
  if (result.kind === "missing") {
    console.error("npm error code E404\\nnpm error No match found for version");
    process.exit(1);
  }
  console.error("npm error code " + (result.code || "E500") + "\\nnpm error registry lookup failed");
  process.exit(1);
}

if (command === "publish") {
  console.log("published " + args[1]);
  process.exit(0);
}

if (command === "whoami") {
  console.log("flyingmoonc");
  process.exit(0);
}

console.error("unsupported fake npm command: " + args.join(" "));
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

function runPublisherScenario(t, {
  lookups,
  packageNames,
  nodeAuthToken,
  npmToken,
  packShape,
  shasums = { "pi-cursor-bridge": "cursor-local", "pi-grok-build-supervisor": "grok-local" },
}) {
  const root = mkdtempSync(join(tmpdir(), "cursor-bridge-pi-publisher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logFile = join(root, "npm-calls.jsonl");
  writeFileSync(logFile, "");
  const fakeNpmCommand = createFakeNpm(root);
  const args = ["-NoProfile", "-File", publishScript, "-RepositoryRoot", root, "-NpmCommand", fakeNpmCommand];
  if (packageNames) args.push("-PackageName", ...packageNames);
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/request",
    FAKE_NPM_LOG: logFile,
    FAKE_NPM_LOOKUPS: JSON.stringify(lookups),
    FAKE_NPM_SHASUMS: JSON.stringify(shasums),
    FAKE_NPM_PACK_SHAPE: packShape || "array",
  };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  if (nodeAuthToken !== undefined) env.NODE_AUTH_TOKEN = nodeAuthToken;
  if (npmToken !== undefined) env.NPM_TOKEN = npmToken;
  const result = spawnSync("pwsh", args, { cwd: repositoryRoot, encoding: "utf8", env });
  const calls = readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return { result, calls };
}

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
  assert.equal(cursor.version, "0.1.8");
  assert.equal(cursor.piPackage.embeddedProductVersion, "5.7.0");
  assert.equal(grok.name, "pi-grok-build-supervisor");
  assert.equal(grok.version, "0.1.4");
  assert.equal(grok.piPackage.embeddedProductVersion, "0.3.7");
  assert.deepEqual(cursor.pi.extensions, ["./extensions/index.ts"]);
  assert.deepEqual(grok.pi.prompts, ["./prompts/grok_init.md", "./prompts/grok_execute.md"]);
  const cursorBundle = readFileSync(join(output, "pi-cursor-bridge", "dist", "cursor-bridge.mjs"), "utf8");
  assert.match(cursorBundle, /cursor_context_engine/);
  assert.match(cursorBundle, /cursor_model/);
  const cursorExtension = readFileSync(join(output, "pi-cursor-bridge", "extensions", "index.ts"), "utf8");
  assert.match(cursorExtension, /cwd: hostCwd/);
  assert.match(cursorExtension, /CODEX_THREAD_ID: undefined/);
  assert.match(cursorExtension, /CURSOR_BRIDGE_HOST_ID: `pi:\$\{hostWorkspaceId\}`/);
  assert.match(cursorExtension, /CURSOR_PROJECT_PATH: hostCwd/);
  assert.match(cursorExtension, new RegExp(`packageVersion: "${cursor.version.replaceAll('.', '\\.') }"`));
  const cursorMcpAdapter = readFileSync(join(output, "pi-cursor-bridge", "extensions", "mcp-stdio.ts"), "utf8");
  assert.match(cursorMcpAdapter, /DEFAULT_TOOL_TIMEOUT_MS = 15 \* 60 \* 1000/);
  assert.match(cursorMcpAdapter, /timeout: toolTimeoutMs/);
  assert.match(cursorMcpAdapter, /maxTotalTimeout: toolTimeoutMs/);
  const grokExtension = readFileSync(join(output, "pi-grok-build-supervisor", "extensions", "index.ts"), "utf8");
  assert.match(grokExtension, /CODEX_THREAD_ID: undefined/);
  assert.match(grokExtension, /CLAUDE_CODE_SESSION_ID: undefined/);
  assert.match(grokExtension, /GROK_SUPERVISOR_HOST_KIND: "pi"/);
  assert.match(grokExtension, new RegExp(`packageVersion: "${grok.version.replaceAll('.', '\\.') }"`));
  const grokBundle = readFileSync(join(output, "pi-grok-build-supervisor", "dist", "grok-build-supervisor.mjs"), "utf8");
  assert.match(grokBundle, /grok_session_inspect/);
  assert.match(grokBundle, /version: "0\.3\.7"/);
  assert.match(readFileSync(join(output, "pi-grok-build-supervisor", "prompts", "grok_execute.md"), "utf8"), /\$ARGUMENTS/);
});

test("Pi publisher uses GitHub Actions OIDC without weakening local account verification", () => {
  const script = readFileSync(join(repositoryRoot, "scripts", "publish-pi-packages.ps1"), "utf8");
  assert.match(script, /\$runningInGitHubActions = \$env:GITHUB_ACTIONS -eq 'true'/);
  assert.match(script, /\$env:ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(script, /requires permissions\.id-token: write/);
  assert.match(script, /nodeAuthTokenIsSetupNodePlaceholder/);
  assert.match(script, /\^\(\?:X\+\-\?\)\+\$/);
  assert.match(script, /must use npm Trusted Publishing without a real NODE_AUTH_TOKEN or NPM_TOKEN/);
  assert.match(script, /npm whoami is intentionally skipped/);
  assert.match(script, /else \{\s+\$npmUserOutput = @\(& \$NpmCommand whoami 2>&1\)/);
  assert.match(script, /\$npmUserOutput = @\(& \$NpmCommand whoami 2>&1\)/);
  assert.match(script, /\$npmUser -ne 'flyingmoonc'/);
  assert.doesNotMatch(script, /\(& npm whoami\)\.Trim\(\)/);
  assert.match(script, /\[ValidateSet\('pi-cursor-bridge', 'pi-grok-build-supervisor'\)\]/);
  assert.match(script, /\[string\[\]\]\$PackageName/);
  assert.match(script, /\$publishPlan = @\(\)/);
  assert.match(script, /\$NpmCommand pack \$package --json --dry-run/);
  assert.match(script, /\$NpmCommand view \$packageSpec dist\.shasum --json 2>&1/);
  assert.match(script, /publishedLookupError -notmatch/);
  assert.match(script, /\\bE404\\b/);
  assert.match(script, /Unable to determine whether \$packageSpec already exists on npm/);
  assert.match(script, /foreach \(\$candidate in \$publishPlan\)/);
  assert.match(script, /\$NpmCommand publish \$candidate\.Package/);
  assert.match(script, /published tarball differs from the local package/);
  assert.doesNotMatch(script, /Skipping \$packageSpec because it is already published/);
});

test("Pi publisher skips an identical package without calling publish", (t) => {
  const { result, calls } = runPublisherScenario(t, {
    packageNames: ["pi-cursor-bridge"],
    lookups: {
      "pi-cursor-bridge@0.1.8": { kind: "existing", shasum: "cursor-local" },
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(calls.some(([command]) => command === "whoami"), false);
  assert.equal(calls.some(([command]) => command === "publish"), false);
});

test("Pi publisher publishes only a registry-confirmed missing package", (t) => {
  const { result, calls } = runPublisherScenario(t, {
    packageNames: ["pi-cursor-bridge"],
    lookups: {
      "pi-cursor-bridge@0.1.8": { kind: "missing" },
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(calls.filter(([command]) => command === "publish").map(([, packageRoot]) => packageRoot), [
    join(".pi-package-stage", "pi-cursor-bridge"),
  ]);
});

test("Pi publisher accepts setup-node's documented placeholder token in an OIDC job", (t) => {
  const { result, calls } = runPublisherScenario(t, {
    packageNames: ["pi-cursor-bridge"],
    nodeAuthToken: "XXXXX-XXXXX-XXXXX-XXXXX",
    lookups: {
      "pi-cursor-bridge@0.1.8": { kind: "missing" },
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(calls.filter(([command]) => command === "publish").length, 1);
});

test("Pi publisher accepts npm 12's package-keyed pack JSON", (t) => {
  const { result, calls } = runPublisherScenario(t, {
    packageNames: ["pi-cursor-bridge"],
    nodeAuthToken: "XXXXX-XXXXX-XXXXX-XXXXX",
    packShape: "keyed",
    lookups: {
      "pi-cursor-bridge@0.1.8": { kind: "missing" },
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(calls.filter(([command]) => command === "publish").length, 1);
});

test("Pi publisher rejects a real npm token in an OIDC job", (t) => {
  const { result, calls } = runPublisherScenario(t, {
    packageNames: ["pi-cursor-bridge"],
    nodeAuthToken: "real-token-for-test",
    lookups: {},
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /without a real NODE_AUTH_TOKEN or NPM_TOKEN/);
  assert.deepEqual(calls, []);
});

test("Pi publisher fails closed on an uncertain registry lookup", (t) => {
  const { result, calls } = runPublisherScenario(t, {
    packageNames: ["pi-cursor-bridge"],
    lookups: {
      "pi-cursor-bridge@0.1.8": { kind: "error", code: "E503" },
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unable to determine whether pi-cursor-bridge@0\.1\.8 already exists on npm/);
  assert.equal(calls.some(([command]) => command === "publish"), false);
});

test("Pi publisher preflights every selected package before the first publish", (t) => {
  const { result, calls } = runPublisherScenario(t, {
    lookups: {
      "pi-cursor-bridge@0.1.8": { kind: "missing" },
      "pi-grok-build-supervisor@0.1.4": { kind: "existing", shasum: "different-grok-tarball" },
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /published tarball differs from the local package/);
  assert.equal(calls.some(([command]) => command === "publish"), false);
});

test("Pi publish workflow uses GitHub OIDC and only accepts release-tag dispatch refs", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "publish-pi.yml"), "utf8");
  const permissions = workflow.match(/^permissions:\r?\n((?:  [^\r\n]+\r?\n?)*)/m)?.[1];
  const publishPermissions = workflow.match(/^  publish:\r?\n[\s\S]*?^    permissions:\r?\n((?:      [^\r\n]+\r?\n?)*)/m)?.[1];
  const dispatchRef = workflow.match(/^      ref:\r?\n((?:        [^\r\n]+\r?\n?)*)/m)?.[1];

  assert.match(workflow, /^name: Publish Pi packages$/m);
  assert.match(workflow, /^  push:\r?\n    tags:/m);
  assert.match(workflow, /^\s*- ["']cursor-bridge--v\*["']$/m);
  assert.match(workflow, /^\s*- ["']grok-build-supervisor--v\*["']$/m);
  assert.match(workflow, /^  workflow_dispatch:\r?\n    inputs:\r?\n      ref:/m);
  assert.ok(dispatchRef, "workflow_dispatch.ref input is missing");
  assert.match(dispatchRef, /required: true/);
  assert.match(dispatchRef, /type: string/);
  assert.match(workflow, /REF: \$\{\{ inputs\.ref \}\}/);
  assert.match(workflow, /\^\(cursor-bridge--v\|grok-build-supervisor--v\)\[0-9\]\[0-9A-Za-z._-]\*\$/);
  assert.match(workflow, /git check-ref-format --allow-onelevel "refs\/tags\/\$REF"/);
  assert.match(workflow, /ref must be an exact cursor-bridge--v\* or grok-build-supervisor--v\* tag/);
  assert.match(workflow, /exit 1/);

  assert.ok(permissions, "top-level permissions block is missing");
  assert.deepEqual(
    permissions.replaceAll("\r\n", "\n").trim().split("\n").map((line) => line.trim()),
    ["contents: read"],
  );
  assert.ok(publishPermissions, "publish job permissions block is missing");
  assert.deepEqual(
    publishPermissions.replaceAll("\r\n", "\n").trim().split("\n").map((line) => line.trim()),
    ["contents: read", "id-token: write"],
  );
  assert.match(workflow, /^    runs-on: windows-latest$/m);
  assert.doesNotMatch(workflow, /self-hosted/i);
  assert.equal(workflow.match(/uses: actions\/checkout@v6/g)?.length, 2);
  assert.match(workflow, /git config --global core\.autocrlf true/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /path: \.release-tooling/);
  assert.match(workflow, /path: release/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && format\('refs\/tags\/\{0\}', inputs\.ref\) \|\| github\.ref \}\}/);
  assert.match(workflow, /uses: actions\/setup-node@v6/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /npm install --global npm@12/);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.ref \|\| github\.ref_name \}\}/);
  assert.match(workflow, /'pi-cursor-bridge'/);
  assert.match(workflow, /'pi-grok-build-supervisor'/);
  assert.match(workflow, /\.release-tooling\/scripts\/publish-pi-packages\.ps1/);
  assert.match(workflow, /-RepositoryRoot "\$env:GITHUB_WORKSPACE\/release"/);
  assert.match(workflow, /-PackageName \$packageName/);
  assert.match(workflow, /^  group: publish-pi-packages$/m);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\b/);
  assert.doesNotMatch(workflow, /\bsecrets\./i);
});
