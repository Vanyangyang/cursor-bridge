# cursor-bridge

[English](./README.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/stargazers)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

一个让 **Codex / Claude Code 把 Cursor 当作可核验 Cursor Context Engine（CCE）与有边界执行器**的 MCP server。它复用 Cursor 项目索引与 Agent UI，把仓库检索过程留在 Cursor 上下文中，并通过 CDP 驱动真实 Cursor 应用——无 console 注入、无回连服务，也不依赖 `/multitask`。

> **兼容性：** 同时支持旧版 Cursor workbench 与 Cursor Agents v2 UI。Windows Cursor 3.7.42 属于实机验证集合；未来 Cursor UI 变化仍可能需要更新 adapter。

## 架构

```text
Codex / Claude Code
        │ MCP
        ▼
Cursor Bridge adapter(s)
        │ singleton IPC
        ▼
Shared lifecycle supervisor
        │ ensure / CDP :9223
        ▼
Cursor Agent + project index
```

- 每个 MCP 上下文可以启动 adapter；所有 adapter 共用一个用户级 supervisor。
- FIFO 使用当前对话，并通过 UI lock 串行执行。
- `parallel_agent` 使用独立顶层 Cursor Agent。
- Windows 上 supervisor 会脱离 Codex Job 生命周期，因此关闭一个会话不会带走 Cursor。

## Cursor Context Engine

Cursor Bridge 提供两种只读 CCE 搜索深度。两者都返回工作区相对的紧凑源码证据，供主 Agent 在真实文件中核验。

### `cursor_search`：平衡定位

用于自然语言概念、行为所有权、未知命名等意图到代码定位任务。它会组合：

- Cursor 索引语义检索
- 精确文本搜索
- 符号与引用追踪
- 少量定向源码核对

它有意避免宽泛遍历仓库。如果问题需要多跳、数据流或跨模块证明，`gaps` 会返回 `deep_search_recommended: <原因>`，而不是静默扩大调查。

### `cursor_search_deep`：仓库调查

问题已经需要跨文件或跨子系统关系证明时使用，例如：

- route → service → storage
- producer → queue → consumer
- config → registration → implementation
- interface → concrete implementations
- 跨模块所有权或数据流
- 横跨多个子系统的实现上下文

Deep 搜索取得最小充分代码上下文后就会停止，不输出实现计划或大片代码。

### 搜索路由

| 问题形状 | 使用方式 |
|---|---|
| 已知字面量、文件名或精确符号 | 调用方 Grep / `rg` |
| 概念、行为所有者、未知命名 | `cursor_search` |
| 调用链、数据流、跨模块/子系统关系 | `cursor_search_deep` |
| 平衡搜索返回 `deep_search_recommended` | 将该问题升级到 `cursor_search_deep` |

不要默认同时运行平衡搜索和深度搜索；按问题实际深度选择。

### 结果合同

```text
CCE_SEARCH_RESULT
intent: <标准化意图>
evidence:
- path/to/file.ts:42-67 | symbolOrAnchor | 已核验的相关性或关系 | reference
gaps: none
confidence: high
```

- 结果按证据强度排序。
- 语义相似不会被包装成已证明调用边。
- 缺少证据时返回 `NOT_FOUND`，并列出实际搜索过的词、符号、引用或范围。
- 结果归一化会移除对话式前言，但不会编造证据。

> [!WARNING]
> Cursor 是 Agent，不是技术沙箱。搜索 prompt 有强只读要求，但不等于文件系统隔离；应在真实工作树中核验返回锚点。

## 前提

- Node.js 18+。
- Cursor 已登录，并打开且索引目标项目。
- Cursor 使用 `--remote-debugging-port=9223`；受支持环境中 Bridge 可以自动管理该生命周期。
- 只有 Windows 支持真实顶层窗口抑制。其他平台会保存运行模式，但明确报告窗口控制不支持。

## 安装

### Codex

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
```

重启 Codex 并新建任务，使 MCP 工具和 skills 进入新会话。

### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

重启 Claude Code 或执行 `/reload-plugins`。

<details>
<summary><strong>从源码运行</strong></summary>

```bash
git clone https://github.com/Vanyangyang/cursor-bridge.git
cd cursor-bridge
npm install
npm run build
```

```json
{
  "mcpServers": {
    "cursor-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/cursor-bridge/server.mjs"]
    }
  }
}
```

设置 `CURSOR_BRIDGE_NO_AUTOLAUNCH=1` 可以关闭自动拉起；Linux 无法自动探测时请设置 `CURSOR_EXE`。

</details>

## MCP 工具

| 工具 | 作用 |
|---|---|
| `cursor_search` | 平衡型只读 CCE 定位，返回紧凑 `path:line` 证据。 |
| `cursor_search_deep` | 深度只读仓库调查，用于核验跨文件关系。 |
| `cursor_do` | 提交有边界的 FIFO 或独立 `parallel_agent` 工作。 |
| `cursor_status` | 只读查看连接、队列、占用、运行时和任务状态。 |
| `cursor_task_control` | 对单个任务执行 `reap`、定向 `cancel` 或显式 `abandon`。 |
| `cursor_policy` | 查看或设置 `manual`、`auto`、`active`、`eager`。 |
| `cursor_runtime` | 查看或设置 `normal` / `minimal` Cursor 展示方式。 |
| `cursor_launch` | 确保 Cursor 带 CDP 运行并返回生命周期诊断。 |

## 极简运行时

```text
cursor_runtime({mode: "minimal"})
```

极简模式会持久化，并把 Cursor 启动延迟到首次 `cursor_search`、`cursor_search_deep` 或 `cursor_do`。Windows 上 Bridge 会隐藏顶层 Cursor 窗口，同时保留真实 Cursor 进程、项目索引、Agent DOM 与任务队列。它是 **UI-suppressed runtime**，不是重新实现的 headless Cursor。

- `cursor_runtime({action: "show"})`：临时显示 Cursor，用于登录、升级或诊断。
- `cursor_runtime({action: "hide"})`：再次隐藏，不改变已保存模式。
- `cursor_runtime({mode: "normal"})`：恢复普通可见行为。

## 任务执行与恢复

- 使用 `background=true` 提交 `cursor_do`，保存返回的 `task_id`，再用 `cursor_status(task_id)` 回收。
- 并行写任务需要互不重叠的 `allowed_paths`；只读任务使用 `read_only=true`。
- `submitting`、`running`、`collecting` 都是正常非终态；`cursor_status` 不修改任务。
- 新出现的 `LLM provider error` 托盘属于失败终态。Bridge 会记录正文和 Request ID，不会自动点击重试。
- 超时表示 Bridge 无法同时确认“助手回复完整”和“生成已经结束”，不代表底层 Agent 已停止。
- Stop 仍激活时的半截 Markdown 不会被当作成功。
- 发送后状态不确定时保留 Agent 或全局占用；Bridge 不会静默释放、重投或点击模糊的全局 Stop。
- `reap` 只用于已绑定孤儿；定向 `cancel` 必须使用已发布的精确 `agentId`。
- FIFO 或未绑定孤儿会阻塞新委托，直到用户人工确认 Cursor 状态并显式承担 `abandon` 风险。
- 任务记录只存在于当前进程；MCP 重启后，开始重叠工作前应检查 Agent History 和工作区变化。

## Cursor 参与策略

`cursor_policy` 是判断偏好，不是调用计数器或硬调度器。

| 模式 | 行为 |
|---|---|
| `manual` | 等待用户明确要求。 |
| `auto` | 仅在收益清晰时选择性使用。 |
| `active` | 把 Cursor 当作常规有边界队友，推荐默认值。 |
| `eager` | 使用每个安全、独立的机会。 |

产品决策、重叠写入、独占 GUI 状态和最终验收始终由主 Agent 负责。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor 远程调试端口。 |
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | 搜索完成超时，单位毫秒。 |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | 未设置 | 设为 `1` 可关闭 normal 模式的自动拉起。 |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | 没有持久化选择时的初始运行模式。 |
| `CURSOR_BRIDGE_RUNTIME_FILE` | 用户配置目录 | 覆盖持久化运行模式文件。 |
| `CURSOR_BRIDGE_POLICY` | `active` | 没有持久化选择时的初始参与策略。 |
| `CURSOR_BRIDGE_POLICY_FILE` | 用户配置目录 | 覆盖持久化策略文件。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 设为 `off` 可禁用并隐藏 `cursor_do`。 |
| `CURSOR_PROJECT_PATH` | 自动探测 | Cursor 应打开并索引的项目。 |
| `CURSOR_EXE` | 自动探测 | 显式 Cursor 可执行文件路径。 |

高级 lifecycle 覆盖主要用于兼容诊断；Windows 上不建议绕过单例 supervisor。

## 开发

```bash
npm install
npm run build
npm test
```

安装后的插件直接执行 `dist/cursor-bridge.mjs`。修改运行源码后必须重新构建并提交 bundle。双 marketplace 发布流程见 [RELEASING.md](./RELEASING.md)，发布历史见 [CHANGELOG.md](./CHANGELOG.md)。

报告 Cursor UI 兼容问题时，请附上 Cursor 版本、操作系统、目标 UI flavor，以及脱敏后的 lifecycle / task 证据。

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](./assets/star-history.svg)](https://github.com/Vanyangyang/cursor-bridge/stargazers)
