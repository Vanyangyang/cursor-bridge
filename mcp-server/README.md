# cursor-mcp-bridge

Bridge Claude Code with Cursor AI for intelligent project consultation through MCP (Model Context Protocol).

## 🚀 Quick Start

### Installation

You don't need to install anything! Just use `npx`:

```bash
npx cursor-mcp-bridge
```

### Configuration

Add to your Claude Code MCP configuration file:

**Windows:**
```json
{
  "mcpServers": {
    "cursor-project-advisor": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "cursor-mcp-bridge"]
    }
  }
}
```

**Mac/Linux:**
```json
{
  "mcpServers": {
    "cursor-project-advisor": {
      "command": "npx",
      "args": ["-y", "cursor-mcp-bridge"]
    }
  }
}
```

### 🎛️ Environment Configuration

Customize Cursor analysis behavior:

```json
{
  "mcpServers": {
    "cursor-project-advisor": {
      "command": "npx",
      "args": ["-y", "cursor-mcp-bridge"],
      "env": {
        "CURSOR_MESSAGE_PREFIX": "[Project Analysis Mode] Use Cursor's built-in search and analysis tools first: 1) Search related code files and configs 2) Analyze project architecture and dependencies 3) Provide analysis based on complete understanding. No code modifications, no long code blocks:",
        "CURSOR_MESSAGE_TIMEOUT": "360000"
      }
    }
  }
}
```

**Environment Variables:**

- **`CURSOR_MESSAGE_PREFIX`**: Customizes the analysis instruction prefix sent to Cursor for project-first analysis approach.
- **`CURSOR_MESSAGE_TIMEOUT`**: Request timeout in milliseconds. Default: 360000 (6 minutes). Adjust based on project complexity and network conditions.

### Usage in Claude Code

Once configured, you can use the MCP tool in Claude Code:

```
mcp__cursor-project-advisor__consult("Please analyze the project architecture")
```

## 📋 Requirements

- Node.js >= 18.0.0
- Cursor (latest version)
- Claude Code with MCP support

## 🛠️ CLI Commands

```bash
# Start the server (default)
npx cursor-mcp-bridge

# Show help
npx cursor-mcp-bridge help

# Show version
npx cursor-mcp-bridge version
```

## 🔧 How It Works

1. The MCP server starts a WebSocket server on port 8766
2. You run the client script in Cursor's developer console
3. Claude Code communicates with Cursor through this bridge
4. Cursor provides deep project understanding and context

## 📝 Features

- **Context Auto-expansion**: Cursor automatically retrieves and supplements relevant code based on key information
- **Deep Project Understanding**: Leverages retrieval models to understand entire codebase structure
- **Intelligent Association Analysis**: Finds related code patterns and potential impacts
- **Architecture Consistency**: Provides suggestions that align with existing code style
- **Configurable Timeouts**: Flexible timeout configuration via environment variables for different project needs

## 🐛 Troubleshooting

### WebSocket Connection Failed
- Ensure port 8766 is not in use
- Check firewall settings
- Restart both Cursor and Claude Code

### MCP Tool Not Available
- Verify the MCP configuration is correct
- Check Node.js version (must be >= 18.0.0)
- Review Claude Code logs for errors

## 📄 License

MIT

## 🔗 Links

- [GitHub Repository](https://github.com/Vanyangyang/cursor-bridge)
- [Report Issues](https://github.com/Vanyangyang/cursor-bridge/issues)