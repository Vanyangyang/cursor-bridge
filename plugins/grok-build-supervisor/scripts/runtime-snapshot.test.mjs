import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_RUNTIME_ENTRY,
  materializeDaemonRuntime,
  materializeTuiRuntime,
  TUI_RUNTIME_FILES,
} from "./runtime-snapshot.mjs";

test("TUI runtime survives deletion of the plugin cache source", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-runtime-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "ephemeral-plugin-cache", "scripts");
  const stateRoot = join(root, "persistent-state");
  mkdirSync(sourceDirectory, { recursive: true });
  for (const name of TUI_RUNTIME_FILES) {
    writeFileSync(join(sourceDirectory, name), `runtime:${name}\n`, "utf8");
  }

  const first = materializeTuiRuntime({ sourceDirectory, stateRoot });
  const second = materializeTuiRuntime({ sourceDirectory, stateRoot });
  assert.equal(first.runtimeRoot, second.runtimeRoot);
  assert.equal(first.fingerprint, second.fingerprint);
  rmSync(join(root, "ephemeral-plugin-cache"), { recursive: true, force: true });

  assert.equal(existsSync(first.launcherScript), true);
  assert.equal(existsSync(first.hostScript), true);
  for (const file of first.files) assert.match(readFileSync(file, "utf8"), /^runtime:/);
});

test("a changed runtime gets a new immutable directory without deleting the old snapshot", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-runtime-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "source");
  const stateRoot = join(root, "state");
  mkdirSync(sourceDirectory, { recursive: true });
  for (const name of TUI_RUNTIME_FILES) writeFileSync(join(sourceDirectory, name), `${name}:v1\n`, "utf8");
  const first = materializeTuiRuntime({ sourceDirectory, stateRoot });

  writeFileSync(join(sourceDirectory, "tui-host.mjs"), "tui-host:v2\n", "utf8");
  const second = materializeTuiRuntime({ sourceDirectory, stateRoot });
  assert.notEqual(first.runtimeRoot, second.runtimeRoot);
  assert.equal(existsSync(first.hostScript), true);
  assert.equal(existsSync(second.hostScript), true);
});

test("daemon runtime survives deletion of the versioned plugin cache", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-daemon-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheRoot = join(root, "versioned-plugin-cache");
  const sourceDirectory = join(cacheRoot, "scripts");
  const daemonBundle = join(cacheRoot, "dist", DAEMON_RUNTIME_ENTRY);
  const stateRoot = join(root, "persistent-state");
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(join(cacheRoot, "dist"), { recursive: true });
  writeFileSync(daemonBundle, "daemon:bundle\n", "utf8");
  for (const name of TUI_RUNTIME_FILES) {
    writeFileSync(join(sourceDirectory, name), `daemon-runtime:${name}\n`, "utf8");
  }

  const runtime = materializeDaemonRuntime({ daemonBundle, sourceDirectory, stateRoot });
  rmSync(cacheRoot, { recursive: true, force: true });

  assert.match(runtime.runtimeRoot, /[\\/]runtime[\\/]daemon-[0-9a-f]{20}$/);
  assert.equal(existsSync(runtime.daemonScript), true);
  assert.equal(readFileSync(runtime.daemonScript, "utf8"), "daemon:bundle\n");
  for (const file of runtime.files) assert.equal(existsSync(file), true);
});
