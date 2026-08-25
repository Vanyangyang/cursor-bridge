#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SupervisorClient } from "./supervisor-transport.mjs";

const supervisor = new SupervisorClient();
// Release the versioned plugin cache immediately. Persistent work runs from the
// content-addressed daemon/TUI snapshots under the user-level state directory.
process.chdir(supervisor.paths.stateRoot);
const server = new McpServer({ name: "grok-build-supervisor", version: "0.3.6" });

function toolResult(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    isError,
  };
}

function register(name, definition, handler) {
  server.registerTool(name, definition, async (args) => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      const payload = { error: error instanceof Error ? error.message : String(error) };
      if (error && typeof error === "object" && typeof error.code === "string") {
        payload.code = error.code;
      }
      if (error && typeof error === "object" && error.details && typeof error.details === "object") {
        payload.details = error.details;
      }
      return toolResult(payload, true);
    }
  });
}

register("grok_init", {
  description: "Explicitly initialize or reinitialize the persistent local HTTP proxy used by Grok Build Supervisor. With no URL, discovers and CONNECT-verifies a local listener; with proxyUrl, verifies that exact loopback endpoint. Refuses while the Supervisor has active work and never opens a TUI or sends a prompt.",
  inputSchema: {
    proxyUrl: z.string().max(2048).optional().describe("Optional exact loopback http:// proxy URL selected by the user; omit for bounded local discovery"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, (args) => supervisor.initializeProxy(args));

register("grok_session_inspect", {
  description: "Read cursor-coalesced state from the persistent Grok Supervisor daemon, including exact workspace-trust requests, optionally waiting up to 25 seconds for completion, failure, permission, or clarification. A workspace-trust request is confirmed only in the visible Grok terminal; do not answer it as a tool permission or rerun session open. Working polls suppress message bodies and return progress.phase plus cursor-relative newActivity, responseChars, lastChunkAt, and heartbeatAt liveness metadata. A short completed response is cursor-delivered once; multiple ACP messages are preserved in order; and a long response is persisted as resultArtifact metadata. Terminal progress includes bounded changedFiles and commandsRun hints with needsHostVerification. Diagnostic views remain explicit.",
  inputSchema: {
    view: z.enum(["interaction", "status", "summary", "delta", "evidence"]).optional().default("interaction"),
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(25).optional(),
    runId: z.string().uuid().optional().describe("Exact prompt run UUID used by the compact interaction view"),
    waitMs: z.number().int().min(0).max(25000).optional().default(0).describe("Bounded wait for a terminal state, permission, or clarification; interaction view only"),
    sequences: z.array(z.number().int().positive()).max(20).optional().describe("Exact durable event sequence IDs used only by the evidence view"),
    sessionId: z.string().max(64).optional().describe("Exact session UUID whose bounded Grok-authored summary may be returned as an unverified agent claim"),
    cwd: z.string().max(2048).optional().describe("Absolute existing project directory used for saved-session discovery"),
    sessionQuery: z.string().max(200).optional().describe("Optional title or summary phrase used to filter saved sessions"),
    sessionLimit: z.number().int().min(1).max(20).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, (args) => supervisor.inspect(args));

register("grok_session_open", {
  description: "Transactionally create or resume one daemon-owned Grok session. The default and normal presentation is a visible Windows Terminal PowerShell TUI. If Grok requires workspace trust, returns needs_workspace_trust while preserving and reusing the same visible terminal until the user confirms there; repeated open never launches a duplicate. Headless ACP-only presentation is allowed only after an explicit user request and the separate OPEN_GROK_SESSION_HEADLESS confirmation. Attempts rollback of owned processes on failure and reports whether cleanup completed.",
  inputSchema: {
    mode: z.enum(["new", "resume"]),
    sessionId: z.string().max(64).optional().describe("Exact Grok session UUID; required for resume and omitted for new"),
    cwd: z.string().max(2048).describe("Absolute existing project directory"),
    presentation: z.enum(["windows_terminal", "none"]).optional().default("windows_terminal").describe("Use windows_terminal unless the user explicitly requested headless ACP-only operation"),
    confirmation: z.enum(["OPEN_GROK_SESSION", "OPEN_GROK_SESSION_HEADLESS"]).describe("Use OPEN_GROK_SESSION_HEADLESS only for an explicit user request for presentation none"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, (args) => supervisor.openSession(args));

register("grok_session_prompt", {
  description: "Start one asynchronous prompt turn in the exact attached Grok session. The prompt may cause Grok actions; call only after user authorization and pass SEND_TO_GROK.",
  inputSchema: {
    sessionId: z.string().describe("Exact attached Grok session UUID"),
    prompt: z.string().min(1).max(100000).describe("Full supervision instruction to send"),
    confirmation: z.literal("SEND_TO_GROK"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, (args) => supervisor.startPrompt(args));

register("grok_session_respond", {
  description: "Answer one exact pending Grok ACP permission or form-elicitation request. Never guesses a permission option or clarification value.",
  inputSchema: {
    permissionId: z.string().uuid().optional(),
    elicitationId: z.string().uuid().optional(),
    action: z.enum(["select", "cancel", "accept", "decline"]),
    optionId: z.string().optional(),
    content: z.record(z.string(), z.union([
      z.string().max(4000),
      z.number(),
      z.boolean(),
      z.array(z.string().max(4000)).max(20),
    ])).optional(),
    confirmation: z.enum(["ANSWER_GROK_PERMISSION", "ANSWER_GROK_INPUT"]),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, (args) => supervisor.respond(args));

register("grok_session_control", {
  description: "Cancel the active prompt, disconnect ACP, or stop the Supervisor-owned Leader. Leader stop refuses while the visible TUI is still running.",
  inputSchema: {
    action: z.enum(["cancel_prompt", "disconnect", "stop_leader"]),
    sessionId: z.string().optional(),
    confirmation: z.literal("CONTROL_GROK_SESSION"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, (args) => supervisor.control(args));

const transport = new StdioServerTransport();
transport.onclose = () => {
  supervisor.detach().catch(() => {});
};
await server.connect(transport);
