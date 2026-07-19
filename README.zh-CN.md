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

安装后新建 Codex 任务或重启 Codex，使 `cursor_search`、`cursor_do`、`cursor_status`、`cursor_task_control`、`cursor_policy`、`cursor_launch` 与 `cursor-delegate`、`cursor-policy` skill 进入会话。

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
| `cursor_status` | 只读检查 CDP、队列与并行 Agent；按 `task_id` 返回内存中的精确状态和已经收回的回复，但不会切换 Agent、回收、停止或重挂任务。 |
| `cursor_task_control` | 不重发任务，按同一进程内的原 `task_id` 恢复或终止：`reap` 显式重查并收回已绑定 Agent，`cancel` 定向停止精确 Agent，`abandon` 只在明确承担风险后释放孤儿占用。 |
| `cursor_policy` | 设置或查询主 Agent 多主动地把工作交给 Cursor。公开选项为 `manual`、`auto`、`active`、`eager`；默认跨 MCP server 重启持久化，并把当前 guidance 注入 Codex 可见的实时工具描述。 |
| `cursor_launch` | 确保 Cursor 带 CDP 调试口运行；必要时自动拉起。 |

`cursor_do` 默认使用 `background=true`、`new_chat=true`。保存返回的 `task_id`，再用 `cursor_status(task_id)` 收回。`submitting`、`running`、`collecting` 都是正常进行态；超过两分钟本身不代表失败。Bridge 不需要唯一终止标记或最低回复长度。

`cursor_status` 刻意保持纯只读。并行孤儿仍有原 `agentId` 时，显式调用 `cursor_task_control(action="reap")`：仍在生成就重挂监控，稳定终态就收回回复。若终态回复 DOM 暂时不可用，任务保持 `terminal_uncollected` 和原占用，允许之后再次 `reap`，不会因一次提取失败误释放。`cancel` 必须携带已经公开的精确 `expected_agent_id`（在 `submitting` 阶段锁存取消时可能尚未公开 ID）；只有同一 composer 的精确 Stop 按钮确实被点击、且 Agent History 达到稳定终态后才释放占用。

Cursor 可能显示输入区的 `Stop generation`，也可能在前台 shell/工具调用期间只显示工具卡片上的 `Stop command`。Bridge 只接受位于目标 composer 内、可见且启用的唯一控件，并要求 composer ID 与当前选中 Agent 一致、状态仍为 `generating`；它不会在全局模糊搜索 Stop。取消确认后会报告 `status=cancelled`、`underlyingStopConfirmed=true`、`terminalEvidence=targeted_stop:<agentId>`，并释放任务占用。

FIFO 或未绑定孤儿没有可安全定向的身份，因此持有全局占用并阻断全部新委托。必须先在 Cursor UI 人工确认，再显式 `abandon`；Bridge 不会退回模糊的 `Stop`、`Cancel` 或工作台控件选择器。

当前任务记录与占用只存在于 Bridge 进程内：只有同一 MCP server 进程仍存活时，原 `task_id` 才能恢复。重启 Codex 或 MCP server 后，内存记录会丢失，但底层 Cursor Agent 仍可能运行；此时必须人工检查 Agent History 与工作区改动，再开始任何重叠写入。跨进程持久任务租约尚未实现。下文的委托策略持久化是另一套机制，仍然有效。

## 选择 Cursor 参与工作的程度

这不是“每 N 次调用一次 Cursor”的计数器。主 Agent 会看当前任务是否值得交接，而不是机械地凑调用次数。

| 档位 | 适合谁 | 主 Agent 会怎么做 |
|---|---|---|
| `manual` | 你希望每次交接都由自己决定。 | 只有你明确要求使用 Cursor 时才派出任务。 |
| `auto` | 你只想偶尔借用 Cursor，不希望后台任务太多。 | 只有范围清楚、结果容易检查，而且收益明显高于派发与复核成本时才委托。 |
| `active` | 你希望 Cursor 成为日常实现副手。**推荐大多数用户使用。** | 面对非简单任务时，通常会寻找一个有价值且边界清楚的部分交给 Cursor，例如局部实现、测试、文档、配置或第二检查面；主 Agent 同时继续其他工作。 |
| `eager` | 当前有较多互不冲突的工作，适合频繁委托或并行 Agent。 | 只要能切出安全且可验收的任务，就尽量使用 Cursor，包括小型只读探针和独立机械修改；写入路径不重叠时可并行。 |

适合派给 Cursor 的任务通常有明确目标、有限路径或子系统，并且主 Agent 能用 diff、测试、计数或明确的文档断言检查结果。重复修改、局部实现定位、测试、文档、配置和独立复查尤其合适。

以下情况不会派 Cursor：

- 你明确说不要使用；
- 只是一个直接完成更快的微小修改；
- 尚未解决的是产品方向、架构、创作意图或其他必须由主 Agent 决定的问题；
- 任务依赖独占 GUI 状态或共享的可变运行时状态；
- 无法划出干净范围、安全路径边界或实际可执行的验收方式。

切换档位不会放松这些边界，也不会把最终验证交给 Cursor。

```text
cursor_policy({mode: "active"})
```

默认 scope 为 `persistent`。只有明确需要临时覆盖时才使用 `scope: "session"`，该值会在重启后恢复为持久化档位。持久化文件在 Windows 默认为 `%APPDATA%\cursor-bridge\policy.json`，其他平台默认为 `$XDG_CONFIG_HOME/cursor-bridge/policy.json`（或 `~/.config/cursor-bridge/policy.json`）；可通过 `CURSOR_BRIDGE_POLICY_FILE` 改写路径。

`cursor_status` 会回显有效档位、持久化状态和重启后档位。Bridge 还会把当前 policy 与 guidance 写入工具描述，并在切换后发送 `tools/list_changed`，使后续决策和新建 Codex 任务能够看到这项持久偏好。用户明确说“不要使用 Cursor”时，始终以用户指令为准。

Codex 用户可调用 `$cursor-policy`，也可用自然语言要求主 Agent 查看或切换模式。本项目不宣称内建 `/cursor` 命令：Codex 插件 manifest 没有自定义 slash command 接口，其他宿主可能不同。未经当前宿主确认时，请使用 skill、`cursor_policy` 或自然语言指令。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor 远程调试端口。 |
| `CURSOR_BRIDGE_TIMEOUT` | `180000` | 单次查询超时，单位毫秒。 |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | 未设置 | 设为 `1` 关闭启动时自动拉起 Cursor。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 管理员级兼容停用开关。只有宿主需要彻底禁用并隐藏 `cursor_do` 时才设为 `off`；它不是普通用户档位。其他工具仍可用，修改后需重启 MCP server 或客户端。 |
| `CURSOR_BRIDGE_POLICY` | `active` | 仅在没有持久化选择时使用的初始档位。旧值 `on` 映射为 `active`；后续启动优先采用持久化的 `cursor_policy` 选择。 |
| `CURSOR_BRIDGE_POLICY_FILE` | 平台用户配置目录 | 改写持久化策略文件路径。Windows 默认位于 `%APPDATA%\cursor-bridge\policy.json`，其他平台默认使用 XDG 用户配置目录。 |
| `CURSOR_PROJECT_PATH` | 自动判断 | Cursor 打开与建索引的项目根。 |
| `CURSOR_EXE` | 自动探测 | 自动探测失败时显式指定 `Cursor.exe`。 |

管理员可在 PowerShell 中为一次 Codex 启动临时关闭委托：

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

## 开发验证

发布改动前，在源码仓库运行完整回归并重建插件实际加载的打包产物：

```bash
node --check server.mjs
npm test
npm run build
node --check dist/cursor-bridge.mjs
git diff --check
```

取消回归测试会在模拟 React adapter/composer 表面上真实执行注入选择器，同时覆盖 `Stop generation` 与 `Stop command`。现场端到端验证还应创建一次性只读 `parallel_agent`，等待精确 `agentId`，通过 `cursor_task_control` 取消，并确认不再保留占用或阻塞任务。

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
skills/cursor-policy/   # 持久策略查询与切换工作流
test/                   # 调度、路径冲突与 Agent 身份测试
probe-*.mjs             # CDP 链路探针
```

插件运行 `dist/cursor-bridge.mjs`。修改 `server.mjs` 或 `launch-cursor.mjs` 后，运行 `npm install && npm run build` 重建。发布流程见 [RELEASING.md](./RELEASING.md)。
