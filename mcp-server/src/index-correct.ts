#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// WebSocket端口
const WEBSOCKET_PORT = 8766;

/**
 * 检查并清理端口占用 (跨平台支持)
 */
async function clearPort(port: number) {
  const isWindows = process.platform === 'win32';

  try {
    console.error(`🔍 检查端口 ${port} 是否被占用... (${isWindows ? 'Windows' : 'Linux/Unix'})`);

    let checkCommand: string, stdout: string;

    if (isWindows) {
      // Windows: 使用 netstat 和 findstr
      checkCommand = `netstat -ano | findstr :${port}`;
    } else {
      // Linux/Unix: 使用 ss 或 netstat 和 grep
      checkCommand = `ss -tuln | grep :${port} || netstat -tuln | grep :${port}`;
    }

    try {
      const result = await execAsync(checkCommand);
      stdout = result.stdout;
    } catch (error) {
      // 如果命令失败，可能是端口未被占用
      stdout = '';
    }

    if (stdout.trim()) {
      console.error(`⚠️ 端口 ${port} 被占用，正在清理...`);

      const pids = new Set<string>();

      if (isWindows) {
        // Windows: 从 netstat 输出提取 PID
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const pid = parts[parts.length - 1];
            if (pid && pid !== '0' && !isNaN(Number(pid))) {
              pids.add(pid);
            }
          }
        }
      } else {
        // Linux/Unix: 使用 lsof 获取 PID
        try {
          const { stdout: lsofOutput } = await execAsync(`lsof -ti :${port}`);
          const lines = lsofOutput.trim().split('\n');
          for (const line of lines) {
            const pid = line.trim();
            if (pid && !isNaN(Number(pid))) {
              pids.add(pid);
            }
          }
        } catch (lsofError) {
          // 如果 lsof 不可用，尝试使用 fuser
          try {
            const { stdout: fuserOutput } = await execAsync(`fuser ${port}/tcp 2>/dev/null`);
            const lines = fuserOutput.trim().split(/\s+/);
            for (const pid of lines) {
              if (pid && !isNaN(Number(pid))) {
                pids.add(pid);
              }
            }
          } catch (fuserError) {
            console.error(`⚠️ 无法获取占用进程PID: lsof 和 fuser 都不可用`);
          }
        }
      }

      // 终止占用端口的进程
      for (const pid of pids) {
        try {
          console.error(`🔪 终止进程 PID: ${pid}`);

          if (isWindows) {
            // Windows: 使用 taskkill
            await execAsync(`taskkill /PID ${pid} /F`);
            console.error(`✅ 进程 ${pid} 已终止`);
          } else {
            // Linux/Unix: 使用 kill
            await execAsync(`kill -9 ${pid}`);
            console.error(`✅ 进程 ${pid} 已终止`);
          }
        } catch (killError) {
          if (isWindows) {
            // Windows: 尝试使用 PowerShell
            try {
              await execAsync(`powershell "Stop-Process -Id ${pid} -Force"`);
              console.error(`✅ 进程 ${pid} 已终止 (PowerShell)`);
            } catch (psError) {
              console.error(`⚠️ 无法终止进程 ${pid}:`, (psError as Error).message);
            }
          } else {
            // Linux/Unix: 尝试使用 SIGTERM
            try {
              await execAsync(`kill -15 ${pid}`);
              console.error(`✅ 进程 ${pid} 已终止 (SIGTERM)`);
            } catch (termError) {
              console.error(`⚠️ 无法终止进程 ${pid}:`, (termError as Error).message);
            }
          }
        }
      }

      // 等待端口释放
      console.error(`⏳ 等待端口 ${port} 释放...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 再次检查端口状态
      try {
        const result = await execAsync(checkCommand);
        if (result.stdout.trim()) {
          console.error(`⚠️ 端口 ${port} 仍被占用，但将尝试启动服务器`);
        } else {
          console.error(`✅ 端口 ${port} 已成功释放`);
        }
      } catch (error) {
        console.error(`✅ 端口 ${port} 已释放`);
      }
    } else {
      console.error(`✅ 端口 ${port} 未被占用`);
    }
  } catch (error) {
    console.error(`⚠️ 检查端口占用失败:`, (error as Error).message);
    console.error(`🔄 将尝试直接启动服务器...`);
  }
}

/**
 * Cursor WebSocket服务 - 正确架构
 * MCP Server内置WebSocket服务器，等待VS Code控制台连接
 */
class CursorWebSocketService {
  private wss: WebSocketServer | null = null;
  private connectedClients: Set<any> = new Set();
  private pendingRequests: Map<string, any> = new Map();
  private connectionStatus: string = 'disconnected';

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
          } catch (error) {
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
    } catch (error) {
      console.error('❌ WebSocket服务器启动失败:', error);
      return false;
    }
  }

  /**
   * 处理客户端消息
   */
  handleClientMessage(ws: any, message: any) {
    switch (message.type) {
      case 'result':
        // 处理执行结果
        if (message.requestId && this.pendingRequests.has(message.requestId)) {
          const request = this.pendingRequests.get(message.requestId);
          if (message.success) {
            request.resolve(message.result);
          } else {
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

      case 'ping':
        // 处理心跳ping，立即返回pong
        console.error('💓 收到心跳ping，发送pong响应');
        const pongMessage = {
          type: 'pong',
          timestamp: message.timestamp, // 原样返回时间戳用于RTT计算
          serverTimestamp: Date.now(),  // 服务器时间戳
          clientId: message.clientId
        };
        
        try {
          ws.send(JSON.stringify(pongMessage));
          console.error('💚 心跳pong已发送');
        } catch (error) {
          console.error('💔 发送pong失败:', error);
        }
        break;

      default:
        console.error('⚠️ 未知消息类型:', message.type);
    }
  }

  /**
   * 发送新标签页请求到Cursor客户端
   */
  async sendNewTabRequest(timeout = 10000) {
    if (this.connectedClients.size === 0) {
      throw new Error('没有客户端连接');
    }

    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      // 设置超时
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`新标签页请求超时 (${timeout}ms)`));
      }, timeout);

      // 存储请求
      this.pendingRequests.set(requestId, {
        resolve: (result: any) => {
          clearTimeout(timeoutHandle);
          resolve(result);
        },
        reject: (error: any) => {
          clearTimeout(timeoutHandle);
          reject(error);
        }
      });

      const message = {
        type: 'newTab',
        requestId: requestId,
        timestamp: new Date().toISOString()
      };

      this.connectedClients.forEach(client => {
        if (client.readyState === 1) { // OPEN
          client.send(JSON.stringify(message));
        }
      });
    });
  }

  /**
   * 发送消息到Cursor并等待响应
   */
  async sendMessageAndWait(content: any) {
    const timeout = parseInt(process.env.CURSOR_MESSAGE_TIMEOUT || '360000');
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
        resolve: (result: any) => {
          clearTimeout(timeoutHandle);
          resolve(result);
        },
        reject: (error: any) => {
          clearTimeout(timeoutHandle);
          reject(error);
        }
      });

      // 添加可配置前缀
      const prefix = process.env.CURSOR_MESSAGE_PREFIX || "【项目分析模式】首先使用Cursor自带的搜索和分析工具深入了解项目：1)搜索相关代码文件和配置 2)分析项目架构和依赖关系 3)基于完整理解提供分析建议。不修改代码，不生成长代码块：";
      const enhancedContent = `${prefix}

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
const server = new Server(
  {
    name: 'cursor-project-advisor',
    version: '3.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 创建WebSocket服务实例
const cursorService = new CursorWebSocketService();

// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'consult',
        description: '项目顾问：基于项目架构理解的智能协助，只做分析和建议，不修改代码。超时时间由CURSOR_MESSAGE_TIMEOUT环境变量控制（默认6分钟）',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: '咨询内容：架构分析、性能评估、影响分析、代码审查、调试建议等。将获得基于项目完整理解的分析和建议',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'cursor_new_tab',
        description: '在Cursor中打开新标签页',
        inputSchema: {
          type: 'object',
          properties: {
            timeout: {
              type: 'integer',
              description: '超时时间（毫秒），默认10000',
              default: 10000,
            },
          },
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
        const { message } = args as any;
        console.error(`📤 发送咨询请求: "${message}"`);

        const result = await cursorService.sendMessageAndWait(message);
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

      case 'cursor_new_tab': {
        const { timeout = 10000 } = args as any;
        console.error(`🆕 发送新标签页请求`);

        const result = await cursorService.sendNewTabRequest(timeout);
        console.error(`✅ 新标签页请求执行完成`);

        return {
          content: [
            {
              type: 'text',
              text: `新标签页已打开: ${result}`,
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
  } catch (error) {
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