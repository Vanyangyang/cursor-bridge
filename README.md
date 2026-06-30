# cursor-bridge

> MCP server：让 **Claude Code 直驱 Cursor IDE 里的 agent 做代码检索**（语义搜索 + Instant Grep，agent 自动编排）。
> **CDP 直驱架构，无 console 注入、无 WebSocket 回连。**

借用 Cursor 原生 embedding 的语义召回质量，给 Claude Code 补一个「语义代码定位」能力——当本地 grep / codegraph 不足以靠关键字命中、需要语义召回时使用。

## 架构

```
Claude Code  --(MCP stdio)-->  cursor-bridge server  --(CDP :9223 Runtime.evaluate + Input)-->  Cursor 渲染进程
```

- server 每次查询新建一条 CDP 连接（**串行**，GUI 单输入框一次只能跑一个），直接驱动 Cursor 的 chat DOM + 真实键盘事件。
- Cursor 的语义搜索没有纯检索接口/独立 UI，只能经 `@Codebase`/agent chat 跑：填查询 → 真实 Enter → 等生成完成 → 抓回复。
- 完成信号 = 停止钮（`codicon-stop` 等）数量从 `>0 → 0`。

> ⚠️ Cursor 是 agent（比纯检索更主动）。prompt 已强约束「只列 `path:行号`、不读正文、不改代码」，但这是 **prompt 约束而非技术沙箱**——理论上 agent 仍有写能力，勿当隔离环境。

## 前提

- **Cursor 带远程调试口启动**：`--remote-debugging-port=9223`，已登录、已打开目标项目（并完成建索引）。
- Node.js 18+。

## 安装与使用

> 本仓库是一个 **Claude Code 插件**，并自带 marketplace（仓库即市场）。

### 方式 A：作为 Claude Code 插件安装（推荐）

```bash
claude plugin marketplace add github:Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

安装后重启 Claude Code（或 `/reload-plugins`），`cursor-bridge` MCP server 会**自动注册并连接**，无需手动改 `.mcp.json`。
运行所需依赖已打包进 `dist/cursor-bridge.mjs`（零额外安装）。

> 默认让 Cursor 建索引的项目根 = 当前工作目录；要指定的话给该 MCP server 设环境变量 `CURSOR_PROJECT_PATH`。

### 方式 B：从源码运行（开发/其它 MCP 客户端）

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
| `cursor_status` | 检查与 Cursor CDP（9223）的连接/队列状态。 |
| `cursor_launch` | 确保 Cursor 带 CDP 调试口在运行；未运行则自动拉起（带 `--remote-debugging-port` + `--remote-allow-origins` + 打开项目建索引）。返回 `already`/`launched`/`running-no-debug`/`port-not-cursor`/`no-exe`/`timeout`。 |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor 远程调试端口 |
| `CURSOR_BRIDGE_TIMEOUT` | `180000` | 单次查询超时（ms） |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | — | 设 `1` 关闭启动即自动拉起 Cursor |
| `CURSOR_PROJECT_PATH` | 当前工作目录 | 让 Cursor 打开/建索引的项目根 |
| `CURSOR_EXE` | 自动探测 | `Cursor.exe` 路径（自动探测失败时显式指定） |

## 何时用 / 何时不用

- ✅ 需要 Cursor 原生 embedding 语义召回质量的代码定位（关键字搜不准、要按「意图」找）。
- ❌ 关键字/符号能直接命中时——用本地 grep 或 codegraph（亚秒级，远快于经 GUI 遥控 agent 的 ~90s）。

## 文件结构

```
.claude-plugin/
  plugin.json          # 插件清单
  marketplace.json     # 自带 marketplace（仓库即市场）
.mcp.json              # 声明 MCP server，指向 dist/cursor-bridge.mjs
dist/cursor-bridge.mjs # 打包产物：零依赖单文件（插件实际运行的就是它）
server.mjs             # MCP server 源码主入口（CDP 直驱 + 工具定义）
launch-cursor.mjs      # 确保/拉起带 CDP 的 Cursor
build.mjs              # esbuild 打包脚本（npm run build → 重建 dist/）
probe-*.mjs            # CDP 链路探针（实测脚本）
agents-autopilot.mjs / autopilot-switch.py  # autopilot 辅助
test-*.mjs             # 检索/批量自测脚本
```

> 插件运行的是 **`dist/cursor-bridge.mjs`**（已内联 `@modelcontextprotocol/sdk`、`ws`），所以 `/plugin install` 后无需任何额外 `npm install`。改了 `server.mjs`/`launch-cursor.mjs` 后跑 `npm install && npm run build` 重建该产物。发布流程见 [`RELEASING.md`](./RELEASING.md)。
