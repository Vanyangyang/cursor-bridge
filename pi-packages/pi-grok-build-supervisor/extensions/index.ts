// @ts-nocheck
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioMcpExtension } from "./mcp-stdio.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default createStdioMcpExtension({
  label: "Grok Build Supervisor",
  clientName: "pi-grok-build-supervisor",
  packageVersion: "0.1.0",
  serverName: "grok-build-supervisor",
  serverScript: join(packageRoot, "dist", "grok-build-supervisor.mjs"),
  cwd: packageRoot,
  env: {
    GROK_SUPERVISOR_HOST_KIND: "pi"
  },
});
