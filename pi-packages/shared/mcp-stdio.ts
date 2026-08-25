// @ts-nocheck
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function stringEnvironment(extra = {}) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra })
      .filter(([, value]) => typeof value === "string"),
  );
}

function toolContent(result) {
  const items = Array.isArray(result?.content) ? result.content : [];
  if (items.length === 0) {
    return [{ type: "text", text: JSON.stringify(result ?? null) }];
  }
  return items.map((item) => {
    if (item?.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    return { type: "text", text: JSON.stringify(item) };
  });
}

export function createStdioMcpExtension(options) {
  return async function registerStdioMcp(pi) {
    if (!existsSync(options.serverScript)) {
      throw new Error(`${options.label} MCP entrypoint is missing: ${options.serverScript}`);
    }

    const client = new Client(
      { name: options.clientName, version: options.packageVersion },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: options.nodeCommand || "node",
      args: [options.serverScript],
      cwd: options.cwd,
      env: stringEnvironment(options.env),
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      for (const tool of listed.tools || []) {
        if (!tool?.name || !tool?.inputSchema) continue;
        pi.registerTool({
          name: tool.name,
          label: tool.title || tool.name,
          description: tool.description || `${options.label} MCP tool ${tool.name}`,
          parameters: tool.inputSchema,
          async execute(_toolCallId, params, signal) {
            const result = await client.callTool(
              { name: tool.name, arguments: params || {} },
              undefined,
              { signal },
            );
            return {
              content: toolContent(result),
              details: {
                mcpServer: options.serverName,
                mcpTool: tool.name,
                isError: result?.isError === true,
              },
            };
          },
        });
      }
    } catch (error) {
      await client.close().catch(() => {});
      throw new Error(`${options.label} MCP startup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let closed = false;
    pi.on("session_shutdown", async () => {
      if (closed) return;
      closed = true;
      await client.close().catch(() => {});
    });
  };
}
