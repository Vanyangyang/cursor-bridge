// @ts-nocheck
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioMcpExtension } from "./mcp-stdio.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostCwd = resolve(process.cwd());
const hostWorkspaceId = hostCwd.replace(/\\/g, "/").toLowerCase();

export default createStdioMcpExtension({
  label: "Cursor Bridge",
  clientName: "pi-cursor-bridge",
  packageVersion: "0.1.5",
  serverName: "cursor-bridge",
  serverScript: join(packageRoot, "dist", "cursor-bridge.mjs"),
  cwd: hostCwd,
  env: {
    // A Pi process can be launched from Codex or Claude Code during testing.
    // Do not let inherited host variables steal Pi's workspace identity.
    CODEX_THREAD_ID: undefined,
    CLAUDE_PROJECT_DIR: undefined,
    CLAUDE_CODE_PROJECT_DIR: undefined,
    CLAUDE_CODE_SESSION_ID: undefined,
    CLAUDE_SESSION_ID: undefined,
    CURSOR_BRIDGE_HOST_ID: `pi:${hostWorkspaceId}`,
    CURSOR_PROJECT_PATH: hostCwd,
  },
});
