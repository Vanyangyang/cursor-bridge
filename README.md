注：暂时不支持cursor3.0 新版UI
# cursor-bridge

> MCP server：让 **Codex/Claude Code 直驱 Cursor IDE agent 做语义检索与边界明确的委托执行**。
> **CDP 直驱架构，无 console 注入、无 WebSocket 回连。**

借用 Cursor 原生 embedding 和执行能力，为主 Agent 提供语义定位、FIFO 委托，以及不依赖 `/multitask` 的独立顶层 Agent 并行池。

## 优点

- **省主调 agent 的上下文**：检索、读文件、推理这些重活都在 Cursor 自己的上下文里跑，只把精炼的 `path:行号` 清单回传给主调方。主调 agent 的上下文窗口不被中间的大量文件内容和搜索噪音占用——相当于把「探索」外包出去，只拿回「结论」。
- **借 Cursor 的项目理解力**：Cursor 对整个项目建了 embedding 语义索引，叠加 agent 自动编排（多轮检索、跟引用），对「按意图找」「跨文件理解」这类语义查询的召回质量，强于纯关键字检索。

## 架构

```
Codex / Claude Code  --(MCP stdio)-->  cursor-bridge server  --(CDP :9223 Runtime.evaluate + Input)-->  Cursor 渲染进程
```

- GUI 操作通过互斥锁串行，避免多个任务同时争抢输入框；`parallel_agent` 提交完成后，各顶层 Cursor Agent 可并行运行，再按稳定 `agentId` 逐项取回。
- Cursor 的语义搜索没有纯检索接口/独立 UI，只能经 `@Codebase`/agent chat 跑：填查询 → 真实 Enter → 等生成完成 → 抓回复。
- FIFO 完成信号来自停止钮（`codicon-stop` 等）与回复稳定性；`parallel_agent` 还会结合 Agent History 状态和稳定 `agentId` 回收结果。

> ⚠️ Cursor 是 agent（比纯检索更主动）。prompt 已强约束「只列 `path:行号`、不读正文、不改代码」，但这是 **prompt 约束而非技术沙箱**——理论上 agent 仍有写能力，勿当隔离环境。

## 前提

- **Cursor 带远程调试口启动**：`--remote-debugging-port=9223`，已登录、已打开目标项目（并完成建索引）。
- Node.js 18+。

## 安装与使用

> 本仓库是一个 **双制式插件仓库**：同时支持 Claude Code 插件和 Codex marketplace。

### 方式 A：作为 Claude Code 插件安装

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

安装后重启 Claude Code（或 `/reload-plugins`），`cursor-bridge` MCP server 会**自动注册并连接**，无需手动改 `.mcp.json`。
运行所需依赖已打包进 `dist/cursor-bridge.mjs`（零额外安装）。

> 默认让 Cursor 建索引的项目根 = 当前工作目录；要指定的话给该 MCP server 设环境变量 `CURSOR_PROJECT_PATH`。

### 方式 B：作为 Codex marketplace 安装

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

Codex 会读取仓库内 `.agents/plugins/marketplace.json` 和 `.codex-plugin/plugin.json`，注册 `cursor_search` / `cursor_do` / `cursor_status` / `cursor_launch`。安装后开启新 Codex 线程或重启 Codex，让新工具与 `cursor-delegate` skill 进入会话。

### 方式 C：从源码运行（开发/其它 MCP 客户端）

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

server 启动时会**自动确保 Cursor 带 CDP 在跑**（fire-and-forget）；设 `CURSOR_BRIDGE_NO_AUTOLAUNCH=1` 可关闭。

> 🪟 **平台**：自动拉起 Cursor 目前仅支持 **Windows**（用 `tasklist` + 默认 `Cursor.exe` 安装路径，可用 `CURSOR_EXE` 覆盖）。macOS/Linux 下请先手动带 `--remote-debugging-port=9223 --remote-allow-origins=http://localhost:9223` 启动 Cursor，再用 `cursor_search`。

## 工具

| 工具 | 作用 |
|------|------|
| `cursor_search` | 用 Cursor agent 检索定位代码，入参 `query`（自然语言意图）。返回 `path:行号` 清单。单次约 ~90s（实测 66~175s 波动）、串行。 |
| `cursor_do` | 委托边界明确的任务。`execution=fifo` 保持兼容；`execution=parallel_agent` 提交独立顶层 Agent。并行只读任务设 `read_only=true`；并行写任务必须给出两两不重叠的 `allowed_paths`。设置 `CURSOR_BRIDGE_DELEGATION=off` 后不再暴露。 |
| `cursor_status` | 检查 CDP、队列、活动并行 Agent；传 `task_id` 精确取回对应状态与原始回复。 |
| `cursor_launch` | 确保 Cursor 带 CDP 调试口在运行；未运行则自动拉起（带 `--remote-debugging-port` + `--remote-allow-origins` + 打开项目建索引）。返回 `already`/`launched`/`running-no-debug`/`port-not-cursor`/`no-exe`/`timeout`。 |

`cursor_do` 默认以 `background=true`、`new_chat=true` 使用；主 Agent 保存返回的 `task_id`，再通过 `cursor_status(task_id)` 回收。`submitting`、`running`、`collecting` 都是正常进行态，超过两分钟本身不代表失败。Bridge 不要求唯一终止标记或最低回复长度。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor 远程调试端口 |
| `CURSOR_BRIDGE_TIMEOUT` | `180000` | 单次查询超时（ms） |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | — | 设 `1` 关闭启动即自动拉起 Cursor |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 设 `off` 禁用并隐藏 `cursor_do`；`cursor_search`、`cursor_status`、`cursor_launch` 保持可用。修改后需重启 MCP server / Codex / Claude Code。 |
| `CURSOR_PROJECT_PATH` | 自动判断 | 让 Cursor 打开/建索引的项目根；未设置且运行目录是插件缓存时，不传路径并让 Cursor 恢复上次工作区 |
| `CURSOR_EXE` | 自动探测 | `Cursor.exe` 路径（自动探测失败时显式指定） |

临时关闭 Codex 委托执行（PowerShell）：

```powershell
$env:CURSOR_BRIDGE_DELEGATION='off'
codex
```

关闭后 `cursor-delegate` skill 必须由主 Agent 直接完成任务，不得尝试绕过或要求重新启用。删除该环境变量或设为 `on`，再重启客户端即可恢复。

## 使用建议

- ✅ 用于按「意图」做语义召回的代码定位、跨文件理解（借 Cursor 原生 embedding 质量）。
- ✅ 把 Cursor 当执行副手：产品方向、范围裁决和最终验证仍由主 Agent 负责。
- 🔀 只有任务互不依赖且写入范围不重叠时才用 `parallel_agent`；其余情况使用 `fifo`。
- 🪪 始终用 `task_id` 查询；并行任务还会绑定 Agents Window 的 `local:<UUID>`，不靠当前可见对话猜结果。

## 文件结构

```
.claude-plugin/
  plugin.json          # 插件清单
  marketplace.json     # 自带 marketplace（仓库即市场）
.agents/plugins/
  marketplace.json     # Codex marketplace 入口
.codex-plugin/
  plugin.json          # Codex 插件清单 + MCP 配置
.mcp.json              # 声明 MCP server，指向 dist/cursor-bridge.mjs
dist/cursor-bridge.mjs # 打包产物：零依赖单文件（插件实际运行的就是它）
server.mjs             # MCP server 源码主入口（CDP 直驱 + 工具定义）
launch-cursor.mjs      # 确保/拉起带 CDP 的 Cursor
build.mjs              # esbuild 打包脚本（npm run build → 重建 dist/）
skills/cursor-delegate/ # 委托门禁、拆分、收回与主 Agent 复核规则
test/                  # 调度、路径冲突与 Agent 身份选择的 node:test 门禁
probe-*.mjs            # CDP 链路探针（实测脚本）
agents-autopilot.mjs / autopilot-switch.py  # autopilot 辅助
test-*.mjs             # 检索/批量自测脚本
```

> 插件运行的是 **`dist/cursor-bridge.mjs`**（已内联 `@modelcontextprotocol/sdk`、`ws`），所以 Claude Code / Codex 安装后无需任何额外 `npm install`。改了 `server.mjs`/`launch-cursor.mjs` 后跑 `npm install && npm run build` 重建该产物。发布流程见 [`RELEASING.md`](./RELEASING.md)。
