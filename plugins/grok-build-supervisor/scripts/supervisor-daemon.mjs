#!/usr/bin/env node
import { resolve } from "node:path";
import { SupervisorDaemon, writeDaemonStartupError } from "./supervisor-transport.mjs";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--state-root", "--runtime-version", "--runtime-fingerprint"].includes(argument)) {
      throw new Error(`Unknown daemon argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--state-root") values.stateRoot = resolve(value);
    if (argument === "--runtime-version") values.runtimeVersion = value;
    if (argument === "--runtime-fingerprint") values.runtimeFingerprint = value;
    index += 1;
  }
  return values;
}

const options = parseArgs(process.argv.slice(2));
const daemon = new SupervisorDaemon({
  stateRoot: options.stateRoot,
  runtimeVersion: options.runtimeVersion,
  runtimeFingerprint: options.runtimeFingerprint,
});

async function stopDaemon() {
  await daemon.stop().catch(() => {});
}

process.once("SIGINT", () => stopDaemon().finally(() => process.exit(0)));
process.once("SIGTERM", () => stopDaemon().finally(() => process.exit(0)));

try {
  await daemon.start();
} catch (error) {
  if (error?.code === "EADDRINUSE") {
    process.exit(0);
  }
  writeDaemonStartupError(options.stateRoot, error);
  process.exitCode = 1;
}
