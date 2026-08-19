import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const TUI_RUNTIME_FILES = [
  "Start-GrokTui.ps1",
  "tui-host.mjs",
  "proxy-environment.mjs",
  "process-identity.mjs",
  "tui-presentation.mjs",
];

function writeDerivedFile(target, content) {
  if (existsSync(target) && readFileSync(target).equals(content)) {
    return;
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content);
  try {
    renameSync(temporary, target);
  } catch (error) {
    if (!existsSync(target)) {
      rmSync(temporary, { force: true });
      throw error;
    }
    rmSync(target, { force: true });
    renameSync(temporary, target);
  }
}

export function materializeTuiRuntime({
  sourceDirectory,
  stateRoot,
  files = TUI_RUNTIME_FILES,
} = {}) {
  const sourceRoot = resolve(sourceDirectory || "");
  const persistentRoot = resolve(stateRoot || "");
  if (!sourceDirectory || !stateRoot) {
    throw new Error("sourceDirectory and stateRoot are required to materialize the TUI runtime");
  }
  const contents = files.map((name) => {
    const sourcePath = join(sourceRoot, name);
    if (!existsSync(sourcePath)) {
      throw new Error(`Required TUI runtime file is missing: ${sourcePath}`);
    }
    return { name, content: readFileSync(sourcePath) };
  });
  const digest = createHash("sha256");
  for (const item of contents) {
    digest.update(item.name);
    digest.update("\0");
    digest.update(item.content);
    digest.update("\0");
  }
  const fingerprint = digest.digest("hex");
  const runtimeRoot = join(persistentRoot, "runtime", `tui-${fingerprint.slice(0, 20)}`);
  mkdirSync(runtimeRoot, { recursive: true });
  for (const item of contents) {
    writeDerivedFile(join(runtimeRoot, item.name), item.content);
  }
  return {
    fingerprint,
    runtimeRoot,
    launcherScript: join(runtimeRoot, "Start-GrokTui.ps1"),
    hostScript: join(runtimeRoot, "tui-host.mjs"),
    files: contents.map((item) => join(runtimeRoot, item.name)),
  };
}
