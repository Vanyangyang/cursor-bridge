# cursor-bridge

[English](./README.md) | [简体中文](./README.zh-CN.md)

> **兼容性说明：** 暂时不支持 Cursor 3.0 新版 UI。
>
> MCP server：让 **Codex / Claude Code 直驱 Cursor IDE agent 做语义检索与边界明确的委托执行**。
> **CDP 直驱架构，无 console 注入、无 WebSocket 回连。**

借用 Cursor 原生 embedding 与执行能力，为主 Agent 提供语义定位、FIFO 委托，以及不依赖 `/multitask` 的独立顶层 Agent 并行池。

## 优点

- **节省主 Agent 上下文**：检索、读文件与局部推理在 Cursor 自己的上下文中执行，只把精炼的 `path:行号` 清单或有界实现结果回传。
- **借用 Cursor 的项目理解力**：Cursor 将项目 embedding 索引与 agent 多轮检索、引用跟踪结合，适合按意图定位与跨文件理解。

## 架构

```text
Codex / Claude Code  --(MCP stdio)-->  cursor-bridge server  --(CDP :9223 Runtime.evaluate + Input)-->  Cursor 渲染进程
```

- GUI 输入通过互斥锁串行，避免多个任务争抢输入框；`parallel_agent` 提交完成后，各顶层 Cursor Agent 可并行运行，再按稳定 `agentId` 逐项取回。
- Cursor 没有独立的纯检索接口，因此语义搜索经 `@Codebase` 或 agent chat 执行：填写查询、发送真实 Enter、等待生成并抓取回复。
- FIFO 完成信号来自停止钮状态与回复稳定性；`parallel_agent` 还会结合 Agent History 与稳定 `agentId` 回收。

> [!WARNING]
> Cursor 是 agent，不是技术沙箱。只读与禁止修改属于 prompt 约束，不能当作文件系统隔离。

## 前提

- Cursor 已登录、已打开并索引目标项目，且使用 `--remote-debugging-port=9223` 启动。
- Node.js 18+。

## 安装

本仓库同时支持 Claude Code 插件与 Codex marketplace。

### Claude Code 插件

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

安装后重启 Claude Code，或执行 `/reload-plugins`。MCP server 会自动注册；运行依赖已打包进 `dist/cursor-bridge.mjs`，无需额外 `npm install`。

### Codex marketplace

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

安装后新建 Codex 任务或重启 Codex，使 `cursor_search`、`cursor_do`、`cursor_status`、`cursor_policy`、`cursor_launch` 与 `cursor-delegate` skill 进入会话。

### 从源码运行

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

server 启动时会自动确保 Cursor 带 CDP 运行。设置 `CURSOR_BRIDGE_NO_AUTOLAUNCH=1` 可关闭自动拉起。

自动拉起目前仅支持 Windows。macOS / Linux 需先手动使用 `--remote-debugging-port=9223 --remote-allow-origins=http://localhost:9223` 启动 Cursor。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `cursor_search` | 使用自然语言意图让 Cursor agent 定位代码，并返回精炼的 `path:行号` 清单。调用串行，常见耗时约 90 秒。 |
| `cursor_do` | 委托有边界的任务。`execution=fifo` 保持串行兼容；`execution=parallel_agent` 提交独立顶层 Agent。并行写任务必须提供互不重叠的 `allowed_paths`。 |
| `cursor_status` | 检查 CDP、队列与并行 Agent；按 `task_id` 精确收回任务，并回显当前生效策略。 |
| `cursor_policy` | 设置或查询当前会话的委托策略：`off`、`manual`、`auto`、`active`、`eager`。使用 `scope=session`，返回实际生效策略。 |
| `cursor_launch` | 确保 Cursor 带 CDP 调试口运行；必要时自动拉起。 |

`cursor_do` 默认使用 `background=true`、`new_chat=true`。保存返回的 `task_id`，再用 `cursor_status(task_id)` 收回。`submitting`、`running`、`collecting` 都是正常进行态；超过两分钟本身不代表失败。Bridge 不需要唯一终止标记或最低回复长度。

## 委托策略

策略控制的是**主 Agent 考虑调用 Cursor 的积极度**，不是“每 N 次工具调用一次 Cursor”这种机械频率。任何策略都不会放松路径、产品、架构或最终验证边界。

| 策略 | 调度行为 |
|---|---|
| `off` | 不使用 `cursor_do` 委托执行。 |
| `manual` | 只有用户明确要求使用 Cursor，或显式调用委托工作流时才委托。 |
| `auto` | 偏谨慎；范围、收益与收回成本都较明确时才委托。 |
| `active` | **推荐默认档。** 主动委托有界的中轻型实现、有限调查、测试、文档、配置与独立第二检查面。 |
| `eager` | 在安全边界内最大化有界委托与不重叠并行，包括小型只读探针与机械任务。 |

```text
cursor_policy({mode: "active"})
```

`cursor_status` 会回显有效策略。用户明确禁用的指令始终高于策略。

Codex 用户可调用 `$cursor-policy`，也可用自然语言要求主 Agent 查看或切换模式。本项目不宣称内建 `/cursor` 命令：Codex 插件 manifest 没有自定义 slash command 接口，其他宿主可能不同。未经当前宿主确认时，请使用 skill、`cursor_policy` 或自然语言指令。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor 远程调试端口。 |
| `CURSOR_BRIDGE_TIMEOUT` | `180000` | 单次查询超时，单位毫秒。 |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | 未设置 | 设为 `1` 关闭启动时自动拉起 Cursor。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 设为 `off` 禁用并隐藏 `cursor_do`；其他工具保持可用。修改后需重启 MCP server 或客户端。 |
| `CURSOR_BRIDGE_POLICY` | `active` | 初始会话策略：`off`、`manual`、`auto`、`active` 或 `eager`。旧值 `on` 映射为 `active`；`cursor_policy` 可修改当前会话的内存策略。 |
| `CURSOR_PROJECT_PATH` | 自动判断 | Cursor 打开与建索引的项目根。 |
| `CURSOR_EXE` | 自动探测 | 自动探测失败时显式指定 `Cursor.exe`。 |

PowerShell 临时关闭委托：

```powershell
$env:CURSOR_BRIDGE_DELEGATION='off'
codex
```

## 使用建议

- 用 `cursor_search` 做按意图的语义召回与跨文件理解。
- 把 Cursor 当作执行副手；产品方向、范围、架构与最终验证仍由主 Agent 负责。
- 只有互不依赖且写入路径不重叠的任务才使用 `parallel_agent`，否则使用 `fifo`。
- 始终按 `task_id` 收回；不要根据当前可见对话猜测任务身份。
- 允许 Cursor 在明确任务信封内做有限调查，不要求主 Agent 在委托前逐行预解实现。

## 文件结构

```text
.claude-plugin/         # Claude Code plugin 与 marketplace 清单
.agents/plugins/        # Codex marketplace 入口
.codex-plugin/          # Codex plugin 清单与 MCP 配置
.mcp.json               # 指向 dist/cursor-bridge.mjs 的 MCP 声明
dist/cursor-bridge.mjs  # 插件实际运行的单文件打包产物
server.mjs              # MCP server 源码
launch-cursor.mjs       # Cursor/CDP 启动器
build.mjs               # esbuild 打包入口
skills/cursor-delegate/ # 委托策略、派发、收回与复核规则
skills/cursor-policy/   # 会话策略查询与切换工作流
test/                   # 调度、路径冲突与 Agent 身份测试
probe-*.mjs             # CDP 链路探针
```

插件运行 `dist/cursor-bridge.mjs`。修改 `server.mjs` 或 `launch-cursor.mjs` 后，运行 `npm install && npm run build` 重建。发布流程见 [RELEASING.md](./RELEASING.md)。
