# cursor-bridge

[English](./README.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/stargazers)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

一个让 **Codex / Claude Code 把 Cursor 当作可核验 Cursor Context Engine（CCE）与有边界执行器**的 MCP server。它复用 Cursor 项目索引与 Agent UI，把仓库检索过程留在 Cursor 上下文中，并通过 CDP 驱动真实 Cursor 应用。

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
- `cursor_init` 会把当前 Codex 任务或 Claude Code 项目持久绑定到一个工作区；再次执行只替换当前宿主上下文的绑定。显式初始化前，Codex 可通过 `CODEX_THREAD_ID` 推断任务目录，Claude Code 使用项目根目录 / 工作目录作为首次回退。
- supervisor 会把解析出的项目绑定到经过校验的 Editor CDP target。缓存 target 的窗口标题若已不匹配就会失效，因此旧的 `cursor-bridge` 窗口不能再冒充 VESPERIX。
- Editor 工作区选择与 Agent UI 选择分离。Cursor Agents v2 与旧 workbench 同时打开时，Bridge 优先 Agents v2，并从匹配仓库分组创建新 Agent——不会再落到 `Home`。Agents v2 未打开时才回退到旧版项目 workbench。
- FIFO 使用当前对话，并通过 UI lock 串行执行。
- `parallel_agent` 使用独立顶层 Cursor Agent。
- Windows 上 supervisor 会脱离 Codex Job 生命周期，因此关闭一个会话不会带走 Cursor。

## Cursor Context Engine

Cursor Bridge 只提供一个只读入口 `cursor_context_engine`，且只有一个参数：`query`。调用方一次说清意图；问题究竟需要多深，由 Cursor 根据真实检索结果自行判断。

它可以组合：

- Cursor 索引语义检索
- 精确文本搜索
- 符号与引用追踪
- 定向源码核对
- 确有助于跨文件核验时使用 Cursor Explore 能力

简单定位会快速收敛；调用链、数据流、注册关系、接口实现和跨模块问题则继续追踪到最小充分证据，例如：

- route → service → storage
- producer → queue → consumer
- config → registration → implementation
- interface → concrete implementations
- 跨模块所有权或数据流
- 横跨多个子系统的实现上下文

Bridge 只约束只读边界、证据质量和停止条件，不假装能够替 Cursor 编排其内部 harness，也不会强迫所有问题走同一套搜索配方。

### 结果合同

```text
CCE_SEARCH_RESULT
intent: <标准化意图>
coverage: <focused|extended> | <为什么该检索力度已经足够>
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
- Cursor 已安装并登录；目标项目存在于本机，并且能够由 Cursor 正常打开。
- 使用“初始化 CCE 工作区为……”建立持久绑定。项目索引由 Cursor 自己完成；`cursor_init` 与 lifecycle supervisor 不负责构建索引。
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

## 首次使用：绑定工作区

每个 Codex 任务或 Claude Code 项目初始化一次即可。绑定保存在插件缓存之外，adapter / 插件重启后仍然有效；需要切换项目时再次 init 就会覆盖当前绑定。

直接用自然语言告诉 Codex 或 Claude Code：

```text
初始化 CCE 工作区为 C:\absolute\path\to\project
```

宿主会把这句话映射到单参数工具 `cursor_init({path})`。Cursor Bridge 不再提供需要记忆、也可能与宿主冲突的 slash 命令。当前任务路径仍可作为首次使用的安全自动回退，但显式初始化拥有最高优先级。

Cursor 使用旧 workbench、新 Agents Window，还是两者同时开启，仍由用户自己选择；Bridge 不会改写这项偏好。两者同时存在时，请求默认选择新的 Agents Window，并从已初始化仓库分组创建对话，而不是放进 `Home`。

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
| `cursor_init` | 把当前 Codex 任务 / Claude Code 项目持久绑定或重新绑定到一个绝对工作区路径。 |
| `cursor_context_engine` | 自适应只读项目理解，返回紧凑、可核验的 `path:line` 证据；唯一参数是 `query`。 |
| `cursor_do` | 提交有边界的 FIFO 或独立 `parallel_agent` 工作。 |
| `cursor_status` | 只读查看连接、队列、占用、运行时和任务状态。 |
| `cursor_task_control` | 对单个任务执行 `reap`、定向 `cancel` 或显式 `abandon`。 |
| `cursor_runtime` | 查看或设置 `normal` / `minimal` Cursor 展示方式。 |
| `cursor_launch` | 确保 Cursor 带 CDP 运行并返回生命周期诊断。 |

## 极简运行时

```text
cursor_runtime({mode: "minimal"})
```

极简模式是希望无感使用 Cursor Bridge 时的推荐选项，但它不会默认开启：全新安装仍使用可见的 `normal` 模式。目前只有 Windows 11 的顶层窗口抑制经过实机测试成功。用户明确开启后，选择会持久化；Bridge 会预热真实 Cursor 进程并隐藏其顶层窗口，同时保留项目索引、Agent DOM 与任务队列。它是 **UI-suppressed runtime**，不是重新实现的 headless Cursor。

- **优点：** `cursor_context_engine` 与 `cursor_do` 可以持续在后台使用，不会让 Cursor 界面打断当前工作。
- **代价：** 极简模式启用期间，手动打开 Cursor 只会复用受守卫的单实例，窗口会再次被隐藏。要恢复日常 Cursor 界面使用，必须先让 CCE **切换到普通模式**。

如果 Bridge 启动前已经存在不带 CDP 的 Cursor，Bridge 仍不会强杀它，以免丢失未保存内容。只需安全退出该实例一次；下次 adapter 启动会预热隐藏的 CDP runtime，后续“用 Cursor 打开”也会安全复用它。

- `cursor_runtime({action: "show"})`：临时显示 Cursor，用于登录、升级或诊断；日常交互使用仍应切换到普通模式。
- `cursor_runtime({action: "hide"})`：再次隐藏，不改变已保存模式。
- `cursor_runtime({mode: "normal"})`：恢复普通可见行为。

`show` 路径即使在 Windows 已认为 Electron 窗口可见时，也会强制执行原生 restore 与 redraw，避免有完整 DOM 的 Agents Window 恢复成白色合成表面。

## 任务执行与恢复

- 使用 `background=true` 提交 `cursor_do`，保存返回的 `task_id`，再用 `cursor_status(task_id)` 回收。
- 并行写任务需要互不重叠的 `allowed_paths`；只读任务使用 `read_only=true`。
- `submitting`、`running`、`collecting` 都是正常非终态；`cursor_status` 不修改任务。
- 新出现的 `LLM provider error` 托盘属于失败终态。Bridge 会记录正文和 Request ID，不会自动点击重试。
- Bridge 会确认 Cursor 是否真正接受提交。若 Enter 后提示仍留在输入框，会精确点击一次 Cursor Send 控件；仍未提交则数秒内返回 `submit_not_accepted`，不会空等五分钟或制造孤儿占用。
- Agents v2 已打开时，Bridge 会优先使用它，并从已初始化仓库的侧栏分组创建新工作；仓库缺失或同名歧义会 fail closed，不再回退到 `Home` 或其他项目。Agents v2 不存在时，才使用已校验的旧版 Editor target 与原生 Chat sidepanel。
- 超时表示 Bridge 无法同时确认“助手回复完整”和“生成已经结束”，不代表底层 Agent 已停止。
- Stop 仍激活时的半截 Markdown 不会被当作成功。
- 发送后状态不确定时保留 Agent 或全局占用；Bridge 不会静默释放、重投或点击模糊的全局 Stop。
- `reap` 只用于已绑定孤儿；定向 `cancel` 必须使用已发布的精确 `agentId`。
- FIFO 或未绑定孤儿会阻塞新委托，直到用户人工确认 Cursor 状态并显式承担 `abandon` 风险。
- 任务记录只存在于当前进程；MCP 重启后，开始重叠工作前应检查 Agent History 和工作区变化。

<details>
<summary><strong>高级环境覆盖</strong></summary>

这些是部署与兼容控制，不属于日常 CCE 调用面。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor 远程调试端口。 |
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | 搜索完成超时，单位毫秒。 |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | 未设置 | 设为 `1` 可关闭 normal 与 minimal 模式的启动预热。 |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | 没有持久化选择时的初始运行模式；只有明确需要首次静默运行时才设为 `minimal`。 |
| `CURSOR_BRIDGE_RUNTIME_FILE` | 用户配置目录 | 覆盖持久化运行模式文件。 |
| `CURSOR_BRIDGE_WORKSPACE_FILE` | 用户 lifecycle 目录 | 覆盖按宿主持久化的 `cursor_init` 绑定文件。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 设为 `off` 可禁用并隐藏 `cursor_do`。 |
| `CURSOR_PROJECT_PATH` | 自动探测 | Cursor 应打开并索引的项目。 |
| `CURSOR_EXE` | 自动探测 | 显式 Cursor 可执行文件路径。 |

高级 lifecycle 覆盖主要用于兼容诊断；Windows 上不建议绕过单例 supervisor。

</details>

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](./assets/star-history.svg)](https://github.com/Vanyangyang/cursor-bridge/stargazers)
