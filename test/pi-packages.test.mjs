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
  assert.equal(grok.name, "pi-grok-build-supervisor");
  assert.deepEqual(cursor.pi.extensions, ["./extensions/index.ts"]);
  assert.deepEqual(grok.pi.prompts, ["./prompts/grok_init.md", "./prompts/grok_execute.md"]);
  assert.match(readFileSync(join(output, "pi-cursor-bridge", "dist", "cursor-bridge.mjs"), "utf8"), /cursor_context_engine/);
  assert.match(readFileSync(join(output, "pi-grok-build-supervisor", "dist", "grok-build-supervisor.mjs"), "utf8"), /grok_session_inspect/);
  assert.match(readFileSync(join(output, "pi-grok-build-supervisor", "prompts", "grok_execute.md"), "utf8"), /\$ARGUMENTS/);
});
