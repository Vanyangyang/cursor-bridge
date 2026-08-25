// @ts-nocheck
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioMcpExtension } from "./mcp-stdio.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default createStdioMcpExtension({
  label: "Cursor Bridge",
  clientName: "pi-cursor-bridge",
  packageVersion: "0.1.0",
  serverName: "cursor-bridge",
  serverScript: join(packageRoot, "dist", "cursor-bridge.mjs"),
  cwd: packageRoot,
});
