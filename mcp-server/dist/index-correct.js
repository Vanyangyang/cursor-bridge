#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
// WebSocket端口
const WEBSOCKET_PORT = 8766;
/**
 * 清理端口占用
 */
async function clearPort(port) {
    const isWindows = process.platform === 'win32';
    try {
        console.error(`🔍 检查端口 ${port} 占用情况...`);
        if (isWindows) {
            // Windows: 查找占用端口的PID
            const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
            const lines = stdout.trim().split('\n');
            const pids = new Set();
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 5 && line.includes('LISTENING')) {
                    const pid = parts[parts.length - 1];
                    if (pid && pid !== '0') {
                        pids.add(pid);
                    }
                }
            }
            // 结束进程
            for (const pid of pids) {
                console.error(`⚠️ 结束占用端口的进程 PID: ${pid}`);
                try {
                    // 使用cmd.exe来执行Windows命令
                    await execAsync(`cmd.exe /c "taskkill /PID ${pid} /F"`);
                    console.error(`✅ 已结束进程 ${pid}`);
                }
                catch (error) {
                    console.error(`❌ 无法结束进程 ${pid}`);
                }
            }
        }
        else {
            // Linux/Mac: 使用 lsof 和 kill
            try {
                const { stdout } = await execAsync(`lsof -ti :${port}`);
                const pids = stdout.trim().split('\n').filter(pid => pid);
                for (const pid of pids) {
                    console.error(`⚠️ 结束占用端口的进程 PID: ${pid}`);
                    await execAsync(`kill -9 ${pid}`);
                }
            }
            catch (error) {
                // 端口可能未被占用
            }
        }
        console.error(`✅ 端口 ${port} 已清理`);
    }
    catch (error) {
        console.error(`⚠️ 清理端口时出错:`, error);
    }
}
/**
 * Cursor WebSocket服务 - 正确架构
 * MCP Server内置WebSocket服务器，等待VS Code控制台连接
 */
class CursorWebSocketService {
    wss = null;
    connectedClients = new Set();
    pendingRequests = new Map();
    connectionStatus = 'disconnected';
    constructor() {
        // 初始化在声明时完成
    }
    /**
     * 启动WebSocket服务器
     */
    async start() {
        try {
            this.wss = new WebSocketServer({ port: WEBSOCKET_PORT });
            this.wss.on('connection', (ws) => {
                console.error('🔗 VS Code控制台已连接');
                this.connectedClients.add(ws);
                this.connectionStatus = 'connected';
                // 发送欢迎消息
                ws.send(JSON.stringify({
                    type: 'welcome',
                    message: 'Cursor MCP WebSocket服务器已连接',
                    timestamp: new Date().toISOString()
                }));
                // 处理消息
                ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleClientMessage(ws, message);
                    }
                    catch (error) {
                        console.error('❌ 消息解析错误:', error);
                    }
                });
                // 处理断开
                ws.on('close', () => {
                    console.error('❌ VS Code控制台断开连接');
                    this.connectedClients.delete(ws);
                    if (this.connectedClients.size === 0) {
                        this.connectionStatus = 'disconnected';
                    }
                });
                // 处理错误
                ws.on('error', (error) => {
                    console.error('❌ WebSocket错误:', error);
                    this.connectedClients.delete(ws);
                });
            });
            console.error(`🚀 Cursor WebSocket服务器启动在端口 ${WEBSOCKET_PORT}`);
            return true;
        }
        catch (error) {
            console.error('❌ WebSocket服务器启动失败:', error);
            return false;
        }
    }
    /**
     * 处理客户端消息
     */
    handleClientMessage(ws, message) {
        switch (message.type) {
            case 'result':
                // 处理执行结果
                if (message.requestId && this.pendingRequests.has(message.requestId)) {
                    const request = this.pendingRequests.get(message.requestId);
                    if (message.success) {
                        request.resolve(message.result);
                    }
                    else {
                        request.reject(new Error(message.error || 'Unknown error'));
                    }
                    this.pendingRequests.delete(message.requestId);
                }
                break;
            case 'status':
                console.error('📊 客户端状态更新:', message.status);
                break;
            case 'error':
                console.error('❌ 客户端错误:', message.message);
                break;
            default:
                console.error('⚠️ 未知消息类型:', message.type);
        }
    }
    /**
     * 生成不同工具类型的前缀
     */
    generateToolPrefix(toolType) {
        return `【项目顾问模式】- 基于项目架构理解的智能协助
1. ⚠️ 绝对不要修改任何代码，只做分析和建议
2. ⚠️ 不要生成长代码块或示例代码，只提供简洁的分析和建议
3. ⚠️ 必须先搜索项目中相关的所有内容进行全面分析，包括：
   - 搜索所有相关文件和引用
   - 分析调用关系和依赖链
   - 理解完整的上下文和架构`;
    }
    /**
     * 发送消息到Cursor并等待响应
     */
    async sendMessageAndWait(content, timeout = 240000) {
        if (this.connectedClients.size === 0) {
            throw new Error('没有客户端连接');
        }
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            // 设置超时
            const timeoutHandle = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`请求超时 (${timeout}ms)`));
            }, timeout);
            // 存储请求
            this.pendingRequests.set(requestId, {
                resolve: (result) => {
                    clearTimeout(timeoutHandle);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timeoutHandle);
                    reject(error);
                }
            });
            // 添加简单前缀
            const enhancedContent = `不修改代码。不生成长代码块。使用cursor自带的工具进行分析：

${content}`;
            const message = {
                type: 'sendAndWait',
                requestId: requestId,
                content: enhancedContent,
                timeout: timeout
            };
            this.connectedClients.forEach(client => {
                if (client.readyState === 1) { // OPEN
                    client.send(JSON.stringify(message));
                }
            });
        });
    }
    /**
     * 检查状态
     */
    async checkStatus() {
        return {
            connected: this.connectionStatus === 'connected',
            clients: this.connectedClients.size,
            pending: this.pendingRequests.size
        };
    }
}
// 创建MCP服务器
const server = new Server({
    name: 'cursor-project-advisor',
    version: '3.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
// 创建WebSocket服务实例
const cursorService = new CursorWebSocketService();
// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'consult',
                description: '项目顾问：基于项目架构理解的智能协助，只做分析和建议，不修改代码',
                inputSchema: {
                    type: 'object',
                    properties: {
                        message: {
                            type: 'string',
                            description: '咨询内容：架构分析、性能评估、影响分析、代码审查、调试建议等。将获得基于项目完整理解的分析和建议',
                        },
                        timeout: {
                            type: 'integer',
                            description: '超时时间（毫秒），默认240000',
                            default: 240000,
                        },
                    },
                    required: ['message'],
                },
            },
            {
                name: 'status',
                description: '检查Cursor项目顾问连接状态',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
        ],
    };
});
// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(`\n=== 工具调用: ${name} ===`);
    try {
        switch (name) {
            case 'consult': {
                const { message, timeout = 240000 } = args;
                console.error(`📤 发送咨询请求: "${message}"`);
                const result = await cursorService.sendMessageAndWait(message, timeout);
                console.error(`✅ 收到咨询响应`);
                return {
                    content: [
                        {
                            type: 'text',
                            text: result,
                        },
                    ],
                };
            }
            case 'status': {
                const status = await cursorService.checkStatus();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(status, null, 2),
                        },
                    ],
                };
            }
            default:
                throw new Error(`未知工具: ${name}`);
        }
    }
    catch (error) {
        console.error(`❌ 工具调用错误:`, error);
        return {
            content: [
                {
                    type: 'text',
                    text: `错误: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
});
// 启动服务器
async function main() {
    console.error('🚀 启动Cursor MCP Bridge服务器（正确架构）...');
    // 先清理端口
    await clearPort(WEBSOCKET_PORT);
    // 启动WebSocket服务器
    const wsStarted = await cursorService.start();
    if (!wsStarted) {
        console.error('❌ WebSocket服务器启动失败');
        process.exit(1);
    }
    // 启动MCP服务器
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('✅ MCP服务器启动成功');
    console.error('⏳ 等待VS Code控制台连接...');
}
// 错误处理
process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
});
// 优雅关闭
process.on('SIGINT', () => {
    console.error('\n🛑 正在关闭服务器...');
    process.exit(0);
});
main().catch((error) => {
    console.error('❌ 致命错误:', error);
    process.exit(1);
});
//# sourceMappingURL=index-correct.js.map