# Cursor Project Advisor - MCP工具

通过WebSocket实现Claude Code与Cursor AI的实时通信桥接，利用Cursor对项目的深度理解能力。

## 快速使用

1. **在 `.mcp.json` 中添加配置**：

   **Windows 配置**：
   ```json
   "mcpServers": {
       "cursor-project-advisor": {
         "command": "cmd",
         "args": [
           "/c",
           "npx",
           "-y",
           "cursor-mcp-bridge"
         ]
       }
     }
   ```

   **Mac/Linux 配置**：
   ```json
   "mcpServers": {
     "cursor-project-advisor": {
       "command": "npx",
       "args": [
         "-y",
         "cursor-mcp-bridge"
       ]
     }
   }
   ```
  **或者直接使用命令行安装**：
  
   **Windows 配置**：
   ```json
     claude mcp add cursor-project-advisor -- cmd /c npx -y cursor-mcp-bridge
   ```

   **Mac/Linux 配置**：
   ```json
    claude mcp add cursor-project-advisor npx -y cursor-mcp-bridge
   ```

2. **在Cursor开发者工具（Help->Toggle Developer Tools）Console中运行**：
   `console-complete-fixed.js`（控制台开启复制粘贴的代码 allow pasting）

3. **在Claude Code中使用MCP工具**：
   - `mcp__cursor-project-advisor__consult` - 咨询Cursor获取基于项目上下文的专业建议

## 核心价值

- **上下文自动扩展**：基于传递的关键信息，Cursor自动检索补充相关代码
- **深度项目理解**：利用检索模型理解整个代码库结构和依赖关系
- **智能关联分析**：自动找到相关代码模式、类似实现和潜在影响
- **架构一致性**：基于项目现有代码风格提供符合规范的建议

## 技术架构

- **MCP服务器**：`cursor-project-advisor` (重命名自cursor-bridge-correct)
- **WebSocket通信**：端口8766
- **DOM分析**：精确的消息检测和内容提取
- **双AI协作**：Claude Code分析 + Cursor项目理解

