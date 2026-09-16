#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFlag = process.argv.indexOf("--out");
if (outputFlag < 0 || !process.argv[outputFlag + 1]) {
  throw new Error("Usage: node scripts/build-mcp-packages.mjs --out <absolute-output-directory>");
}
const outputRoot = resolve(process.argv[outputFlag + 1]);

function copyRequired(source, target) {
  if (!existsSync(source)) throw new Error(`Required package source is missing: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function copyPackageSource(name) {
  const source = join(repositoryRoot, "mcp-packages", name);
  const target = join(outputRoot, name);
  copyRequired(source, target);
  copyRequired(join(repositoryRoot, "LICENSE"), join(target, "LICENSE"));
  return target;
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const cursor = copyPackageSource("vanyangyang-cursor-bridge");
copyRequired(join(repositoryRoot, "dist", "cursor-bridge.mjs"), join(cursor, "dist", "cursor-bridge.mjs"));
copyRequired(
  join(repositoryRoot, "dist", "cursor-lifecycle-supervisor.mjs"),
  join(cursor, "dist", "cursor-lifecycle-supervisor.mjs"),
);
copyRequired(join(repositoryRoot, "skills", "cce-routing"), join(cursor, "skills", "cce-routing"));
copyRequired(join(repositoryRoot, "skills", "cursor-delegate"), join(cursor, "skills", "cursor-delegate"));

const grok = copyPackageSource("vanyangyang-grok-build-supervisor");
copyRequired(
  join(repositoryRoot, "plugins", "grok-build-supervisor", "dist"),
  join(grok, "dist"),
);
for (const file of [
  "Start-GrokTui.ps1",
  "tui-host.mjs",
  "proxy-environment.mjs",
  "process-identity.mjs",
  "tui-presentation.mjs",
]) {
  copyRequired(
    join(repositoryRoot, "plugins", "grok-build-supervisor", "scripts", file),
    join(grok, "scripts", file),
  );
}
copyRequired(
  join(repositoryRoot, "plugins", "grok-build-supervisor", "skills", "grok-build-supervisor"),
  join(grok, "skills", "grok-build-supervisor"),
);
for (const skill of ["grok-executor-on", "grok-executor-off"]) {
  copyRequired(
    join(repositoryRoot, "plugins", "grok-build-supervisor", "skills", skill),
    join(grok, "skills", skill),
  );
}
for (const file of ["grok_init.md", "grok_execute.md"]) {
  copyRequired(
    join(repositoryRoot, "plugins", "grok-build-supervisor", "commands", file),
    join(grok, "prompts", file),
  );
}

for (const packageRoot of [cursor, grok]) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (!manifest.name || !manifest.version || !manifest.bin || !manifest.mcpPackage) {
    throw new Error(`Invalid generated MCP package manifest: ${packageRoot}`);
  }
  if (manifest.pi || String(manifest.name).startsWith("pi-")) {
    throw new Error(`Generic MCP package must not be a Pi wrapper: ${packageRoot}`);
  }
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`built ${manifest.name}@${manifest.version} -> ${packageRoot}`);
}
