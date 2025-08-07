# Cursor Project Advisor - MCP工具

通过WebSocket实现Claude Code与Cursor AI的实时通信桥接，利用Cursor对项目的深度理解能力。

## 快速使用

1. **在 `.mcp.json` 中添加配置**：

   **Windows 配置**：
   ```json
   "cursor-project-advisor": {
     "command": "cmd",
     "args": [
       "/c",
       "npx",
       "-y",
       "cursor-mcp-bridge"
     ]
   }
   ```

   **Mac/Linux 配置**：
   ```json
   "cursor-project-advisor": {
     "command": "npx",
     "args": [
       "-y",
       "cursor-mcp-bridge"
     ]
   }
   ```

   **环境变量配置（可选）**：
   ```json
   "cursor-project-advisor": {
     "command": "npx",
     "args": ["-y", "cursor-mcp-bridge"],
     "env": {
       "CURSOR_MESSAGE_PREFIX": "【项目分析模式】请务必先使用Cursor自带的搜索工具全面了解项目，不要直接分析：1)先搜索相关代码文件和配置 2)再分析项目架构和依赖关系 3)基于完整搜索结果提供建议。不修改代码，不生成长代码块："
     }
   }
   ```

   > **新功能说明**: `CURSOR_MESSAGE_PREFIX` 环境变量允许自定义发送给Cursor的分析指令前缀。默认配置专门优化了Cursor的项目索引工具调用成功率，引导Cursor优先使用自身的搜索和分析工具进行深度项目理解，从而提供更准确的项目级建议。

2. **在Cursor开发者工具（Help->Toggle Developer Tools）Console中运行**：
   - **推荐使用**: `console-complete-fixed.js`（稳定增强版，包含完整功能和New Tab支持）
   - **备份版本**: `console-complete-backup.js`（功能完整的备份脚本）

3. **在Claude Code中使用MCP工具**：
   - `mcp__cursor-project-advisor__consult` - 咨询Cursor获取基于项目上下文的专业建议
   - `mcp__cursor-project-advisor__cursor_new_tab` - 在Cursor中打开新标签页

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

