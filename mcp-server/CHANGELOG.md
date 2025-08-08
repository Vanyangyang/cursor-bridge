# Changelog

All notable changes to cursor-mcp-bridge will be documented in this file.

## [1.2.0] - 2025-01-08

### 🔥 Major Features Added

- **Heart Beat System**: Added comprehensive WebSocket heartbeat mechanism
  - Server-side ping/pong handling for connection health monitoring
  - Automatic detection and response to client heartbeat requests
  - Prevents connection drops in Linux environments

### 🐛 Bug Fixes

- **Linux Connectivity**: Fixed intermittent WebSocket disconnections on Linux systems
- **Connection Stability**: Improved WebSocket connection reliability across platforms
- **Message Handling**: Enhanced error handling for unknown message types

### 💡 Improvements

- **Cross-Platform Support**: Better compatibility between Windows and Linux environments
- **Connection Monitoring**: Added detailed logging for heartbeat operations
- **Debugging Tools**: Enhanced diagnostic information for connection issues

### 🔧 Technical Details

- Added `ping` message type handler in WebSocket server
- Implemented automatic `pong` response with timestamp for RTT calculation
- Enhanced connection stability through active keep-alive mechanism
- Server now responds to client heartbeat requests preventing timeout disconnections

### 📊 Impact

- **Linux Users**: Significantly improved connection stability (from frequent disconnections to reliable connections)
- **Windows Users**: Enhanced connection reliability and monitoring
- **Overall**: Better cross-platform consistency and debugging capabilities

---

## [1.1.1] - Previous Version

- Basic WebSocket bridge functionality
- MCP server implementation
- Cross-platform command support