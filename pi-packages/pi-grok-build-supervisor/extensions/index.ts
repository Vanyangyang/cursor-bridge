// @ts-nocheck
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioMcpExtension } from "./mcp-stdio.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default createStdioMcpExtension({
  label: "Grok Build Supervisor",
  clientName: "pi-grok-build-supervisor",
  packageVersion: "0.1.5",
  serverName: "grok-build-supervisor",
  serverScript: join(packageRoot, "dist", "grok-build-supervisor.mjs"),
  cwd: packageRoot,
  env: {
    // A Pi process can be launched from Codex or Claude Code during testing.
    // Keep host identity tied to this Pi adapter rather than inherited markers.
    CODEX_THREAD_ID: undefined,
    CLAUDE_PROJECT_DIR: undefined,
    CLAUDE_CODE_PROJECT_DIR: undefined,
    CLAUDE_CODE_SESSION_ID: undefined,
    CLAUDE_SESSION_ID: undefined,
    GROK_SUPERVISOR_HOST_KIND: "pi"
  },
});
