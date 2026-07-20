# cursor-bridge

[![Version](https://img.shields.io/github/package-json/v/Vanyangyang/cursor-bridge?style=flat-square&logo=github&label=version)](https://github.com/Vanyangyang/cursor-bridge/tags)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square&logo=opensourceinitiative&logoColor=white)](./LICENSE)

让 **Codex / Claude Code 使用 Cursor agent 做语义检索与边界明确的委托执行**。它复用 Cursor 项目索引，把探索过程留在 Cursor 上下文中，并通过 CDP 直驱——无 console 注入、无回连通道，也不依赖 `/multitask`。

> **兼容性说明：** 暂时不支持 Cursor 3.0 新版 UI。

## 架构

```text
Codex / Claude Code -> stdio MCP adapter(s) -> shared lifecycle supervisor -> Cursor (CDP :9223)
```

- 每个 MCP 上下文可启动独立 adapter，但所有 adapter 共用一个用户级 supervisor。Windows 上它会脱离 Codex Job 生命周期，因此会话关闭不会带走 Cursor。
- GUI 输入串行：FIFO 使用当前对话，`parallel_agent` 使用独立顶层 Agent。

> [!WARNING]
> Cursor 是 agent，不是技术沙箱。只读与禁止修改属于 prompt 约束，不能当作文件系统隔离。

## 前提

- Cursor 已登录、已打开并索引目标项目，且使用 `--remote-debugging-port=9223` 启动。
- Node.js 18+。

## 安装

本仓库同时支持 Claude Code 与 Codex marketplace。

### Claude Code 插件

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

安装后重启 Claude Code 或执行 `/reload-plugins`。MCP server 和运行依赖会自动注册。

### Codex marketplace

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

安装后新建 Codex 任务或重启 Codex，使工具和 skill 进入会话。

<details>
<summary><strong>从源码运行</strong></summary>

```bash
git clone https://github.com/Vanyangyang/cursor-bridge.git
cd cursor-bridge
npm install
```

```json
{
  "mcpServers": {
    "cursor-bridge": {
      "command": "node",
      "args": ["path/to/cursor-bridge/server.mjs"]
    }
  }
}
```

adapter 会请求 supervisor 确保 Cursor 可用。`CURSOR_BRIDGE_NO_AUTOLAUNCH=1` 可关闭自动拉起；Linux 无法自动探测时请设置 `CURSOR_EXE`。

</details>

## MCP 工具

| 工具 | 作用 |
|---|---|
| `cursor_search` | 语义定位代码，返回精炼的 `path:行号` 清单。 |
| `cursor_do` | 提交有边界的 FIFO 或独立 `parallel_agent` 任务；并行写入需互不重叠的 `allowed_paths`。 |
| `cursor_status` | 只读查看连接、队列、占用和任务状态。 |
| `cursor_task_control` | 对单个任务执行 `reap`、定向 `cancel` 或明确承担风险的 `abandon`。 |
| `cursor_policy` | 查看或设置 `manual`、`auto`、`active`、`eager`，默认持久化。 |
| `cursor_launch` | 确保 Cursor 带 CDP 运行并返回生命周期诊断。 |

### 任务与恢复

- 提交 `cursor_do` 时使用 `background=true`、`new_chat=true`；保存 `task_id`，再用 `cursor_status(task_id)` 收回。
- `submitting`、`running`、`collecting` 都是正常进行态；超过两分钟本身不代表失败。`cursor_status` 不修改任务。
- `reap` 只用于已绑定孤儿，`cancel` 必须使用精确 `agentId`；Bridge 不会点击模糊的全局 Stop。
- FIFO 或未绑定孤儿会阻塞新委托，直到用户人工确认 Cursor 状态并显式承担 `abandon` 风险。
- 任务记录只存在于当前 Bridge 进程；重启后开始重叠工作前，先检查 Agent History 与工作区。

## 选择 Cursor 参与工作的程度

这是判断偏好，不是调用计数器。

| 档位 | 适合谁 | 主 Agent 会怎么做 |
|---|---|---|
| `manual` | 每次委托都需明确要求。 | 等待用户指令。 |
| `auto` | 偶尔使用，只接收益明确的工作。 | 仅委托范围干净、易验收的任务。 |
| `active` | 日常协作。**推荐。** | 非简单任务通常委托一个有价值的有界部分。 |
| `eager` | 频繁安全委托与并行。 | 使用每个合适的独立部分。 |

产品/架构决策、独占 GUI、范围不安全或用户要求本地完成的工作仍不会委托；最终验证始终由主 Agent 负责。

```text
cursor_policy({mode: "active"})
```

默认 scope 为 `persistent`；临时覆盖才使用 `scope: "session"`。`cursor_status` 会报告有效档位和重启档位。用户明确说“不要使用 Cursor”时始终优先。Codex 用户可调用 `$cursor-policy` 或使用自然语言；本项目不提供 `/cursor` 命令。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor 远程调试端口。 |
| `CURSOR_BRIDGE_TIMEOUT` | `180000` | 单次查询超时，单位毫秒。 |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | 未设置 | 设为 `1` 关闭启动时自动拉起 Cursor。 |
| `CURSOR_BRIDGE_POLICY` | `active` | 仅在没有持久化选择时使用的初始档位。旧值 `on` 映射为 `active`；后续启动优先采用持久化的 `cursor_policy` 选择。 |
| `CURSOR_PROJECT_PATH` | 自动判断 | Cursor 打开与建索引的项目根。 |
| `CURSOR_EXE` | 自动探测 | 自动探测失败时显式指定 `Cursor.exe`。 |

<details>
<summary><strong>高级与排障变量</strong></summary>

| 变量 | 默认 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_INLINE_ENSURE` / `CURSOR_BRIDGE_NO_SUPERVISOR` | 未设置 | 绕过单例 supervisor（仅兼容/排障；Windows Job 生命周期下不安全）。 |
| `CURSOR_BRIDGE_LIFECYCLE_DIR` | 平台用户状态目录 | 覆盖 supervisor 状态目录。Windows 默认 `%LOCALAPPDATA%\\cursor-bridge\\lifecycle`。 |
| `CURSOR_BRIDGE_SUPERVISOR_SOCK` | 派生 | 覆盖 supervisor IPC 端点。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 管理员开关；设为 `off` 会禁用并隐藏 `cursor_do`，修改后需重启 MCP server 或客户端。 |
| `CURSOR_BRIDGE_POLICY_FILE` | 平台用户配置目录 | 改写持久化策略文件路径。 |

</details>

## 开发

提交修改前运行 `npm test` 和 `npm run build`。完整发布检查见 [RELEASING.md](./RELEASING.md)。
