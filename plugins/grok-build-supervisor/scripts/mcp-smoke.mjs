import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { SupervisorClient } from "./supervisor-transport.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDirectory);
const mcpManifest = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
const codexPluginManifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const configured = mcpManifest.mcpServers?.["grok-build-supervisor"];
if (!configured || typeof configured.command !== "string" || !Array.isArray(configured.args)) {
  throw new Error("Plugin MCP manifest does not define grok-build-supervisor");
}
const pluginRootToken = "${CLAUDE_PLUGIN_ROOT}";
const resolvePluginRoot = (value) => String(value).split(pluginRootToken).join(pluginRoot);
const configuredCommand = resolvePluginRoot(configured.command);
const configuredArgs = configured.args.map(resolvePluginRoot);
if ([configuredCommand, ...configuredArgs].some((value) => value.includes("${"))) {
  throw new Error("Plugin MCP manifest contains an unsupported unresolved placeholder");
}
const configuredCwd = resolve(pluginRoot, configured.cwd ? resolvePluginRoot(configured.cwd) : ".");
const smokeStateRoot = mkdtempSync(join(tmpdir(), "grok-build-supervisor-mcp-smoke-"));
const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter((entry) => typeof entry[1] === "string"));
const transport = new StdioClientTransport({
  command: configuredCommand,
  args: configuredArgs,
  cwd: configuredCwd,
  env: { ...cleanEnvironment, GROK_SUPERVISOR_STATE_ROOT: smokeStateRoot },
});
const client = new Client({ name: "grok-build-supervisor-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const status = await client.callTool({ name: "grok_session_inspect", arguments: {} });
  const daemonStatusCall = await client.callTool({ name: "grok_session_inspect", arguments: { view: "status" } });
  const names = listed.tools.map((tool) => tool.name).sort();
  if (names.length !== 6) {
    throw new Error(`Expected 6 tools, received ${names.length}`);
  }
  if (status.isError) {
    throw new Error("Read-only status tool returned an error");
  }
  const interactionText = status.content?.find((item) => item.type === "text")?.text;
  const interaction = JSON.parse(interactionText || "null");
  if (interaction?.view !== "interaction" || "status" in interaction) {
    throw new Error("Default inspect did not return the compact interaction view");
  }
  const daemonStatusText = daemonStatusCall.content?.find((item) => item.type === "text")?.text;
  const daemonStatus = JSON.parse(daemonStatusText || "null");
  if (daemonStatus?.status?.daemon?.protocolVersion !== 1) {
    throw new Error("Status did not confirm the persistent Supervisor daemon transport");
  }
  if (daemonStatus.status.daemon.capabilities?.hostIdentityEnvelope !== true
    || daemonStatus.status.daemon.capabilities?.cacheIndependentDaemonRuntime !== true
    || daemonStatus.status.daemon.capabilities?.interactionDeliveryV2 !== true
    || daemonStatus.status.daemon.capabilities?.persistentTuiRuntime !== true
    || daemonStatus.status.daemon.capabilities?.proxyInitialization !== true
    || daemonStatus.status.daemon.capabilities?.resultArtifacts !== true) {
    throw new Error("Status did not expose the required Supervisor capability gates");
  }
  const daemonRuntime = daemonStatus.status.daemon;
  if (daemonRuntime.runtimeVersion !== codexPluginManifest.version) {
    throw new Error(`Expected daemon runtime ${codexPluginManifest.version}, received ${daemonRuntime.runtimeVersion}`);
  }
  const expectedDaemonRuntimeRoot = join(smokeStateRoot, "runtime", "daemon-");
  if (typeof daemonRuntime.runtimeFingerprint !== "string"
    || daemonRuntime.runtimeFingerprint.length !== 64
    || typeof daemonRuntime.runtimeScript !== "string"
    || !daemonRuntime.runtimeScript.toLowerCase().startsWith(expectedDaemonRuntimeRoot.toLowerCase())) {
    throw new Error("Supervisor daemon is not running from the persistent content-addressed runtime");
  }
  const persistentRuntime = daemonStatus.status.tuiRuntime;
  if (persistentRuntime?.persistent !== true
    || !existsSync(join(persistentRuntime.runtimeRoot || "", "Start-GrokTui.ps1"))
    || !existsSync(join(persistentRuntime.runtimeRoot || "", "tui-host.mjs"))) {
    throw new Error("Supervisor daemon did not materialize a persistent TUI runtime snapshot");
  }
  const initTool = listed.tools.find((tool) => tool.name === "grok_init");
  const openTool = listed.tools.find((tool) => tool.name === "grok_session_open");
  const promptTool = listed.tools.find((tool) => tool.name === "grok_session_prompt");
  const inspectTool = listed.tools.find((tool) => tool.name === "grok_session_inspect");
  const respondTool = listed.tools.find((tool) => tool.name === "grok_session_respond");
  const initProperties = Object.keys(initTool?.inputSchema?.properties || {});
  const openProperties = Object.keys(openTool?.inputSchema?.properties || {});
  const openConfirmations = openTool?.inputSchema?.properties?.confirmation?.enum || [];
  const promptProperties = Object.keys(promptTool?.inputSchema?.properties || {});
  const inspectProperties = Object.keys(inspectTool?.inputSchema?.properties || {});
  const respondProperties = Object.keys(respondTool?.inputSchema?.properties || {});
  if (!initProperties.includes("proxyUrl")) {
    throw new Error("Init tool did not expose optional explicit local proxy selection");
  }
  if (!openProperties.includes("mode") || !openProperties.includes("presentation") || openProperties.includes("visible")) {
    throw new Error("Open tool did not expose the new/resume Windows Terminal presentation contract");
  }
  if (!openConfirmations.includes("OPEN_GROK_SESSION") || !openConfirmations.includes("OPEN_GROK_SESSION_HEADLESS")) {
    throw new Error("Open tool did not expose distinct visible and explicit-headless confirmations");
  }
  if (promptProperties.includes("hostKind")) {
    throw new Error("Prompt tool must derive host identity from the MCP frontend instead of trusting model arguments");
  }
  if (!inspectProperties.includes("sessionQuery") || !inspectProperties.includes("sessionLimit")
    || !inspectProperties.includes("view") || !inspectProperties.includes("sequences")
    || !inspectProperties.includes("runId") || !inspectProperties.includes("waitMs")) {
    throw new Error("Inspect tool did not expose compact waiting plus bounded diagnostic views");
  }
  if (!respondProperties.includes("permissionId") || !respondProperties.includes("elicitationId")
    || !respondProperties.includes("content")) {
    throw new Error("Respond tool did not expose both permission and clarification replies");
  }
  process.stdout.write(`${JSON.stringify({
    toolCount: names.length,
    tools: names,
    statusCallPassed: true,
    daemonProtocolVersion: daemonStatus.status.daemon.protocolVersion,
    daemonCapabilities: daemonStatus.status.daemon.capabilities,
    persistentDaemonRuntime: {
      version: daemonStatus.status.daemon.runtimeVersion,
      fingerprint: daemonStatus.status.daemon.runtimeFingerprint,
      script: daemonStatus.status.daemon.runtimeScript,
    },
    persistentTuiRuntime: {
      persistent: persistentRuntime.persistent,
      fingerprint: persistentRuntime.fingerprint,
    },
    initProperties,
    openProperties,
    openConfirmations,
    promptProperties,
    inspectProperties,
    respondProperties,
    configuredCommand,
    configuredArgs,
    configuredCwd,
  }, null, 2)}\n`);
} finally {
  await client.close();
  const daemon = new SupervisorClient({ stateRoot: smokeStateRoot });
  await daemon.shutdownIdleDaemon().catch(() => {});
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  rmSync(smokeStateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
