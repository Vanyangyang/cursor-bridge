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
- `cursor_init` 会为当前 Codex 或 Claude Code 上下文初始化一个工作区；再次执行只替换当前宿主上下文的工作区。显式初始化前，Codex 可通过 `CODEX_THREAD_ID` 推断工作区，Claude Code 使用项目根目录 / 工作目录作为首次回退。
- supervisor 会把解析出的项目绑定到经过校验的 Editor CDP target。缓存 target 的窗口标题若已不匹配就会失效，因此旧的 `cursor-bridge` 窗口不能再冒充 VESPERIX。
- Editor 工作区选择与 Agent UI 选择分离。Cursor Agents v2 与旧 workbench 同时打开时，Bridge 优先 Agents v2，并从匹配仓库分组创建新 Agent——不会再落到 `Home`。Agents v2 未打开时才回退到旧版项目 workbench。
- FIFO 即先进先出：任务通过 UI lock 串行执行，并且默认各自在干净对话中开始。
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

安装后的插件还包含一份由 Codex 与 Claude Code 共用的 `cce-routing` Skill：陌生项目、未知实现位置、跨模块关系追踪会优先匹配 CCE；已知文件读取、测试、日志、构建、Git 与外部文档则继续使用更便宜的原生路径。它能提高自动选择的命中率，但不会把由模型决定的工具调用宣传成百分之百确定。

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
- 使用“初始化 CCE 工作区为……”将该项目持久设为当前 CCE 工作区。项目索引由 Cursor 自己完成；`cursor_init` 与 lifecycle supervisor 不负责构建索引。
- Bridge 会自动管理 CCE 所需的本地连接。如果 Cursor 在 Bridge 之前启动且没有该连接，只需保存工作、正常退出 Cursor 一次，再重复同一句初始化指令。
- 只有 Windows 支持真实顶层窗口抑制。其他平台会保存运行模式，但明确报告窗口控制不支持。

## 安装

### Codex

首次安装：

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add cursor-bridge@vanyangyang
```

更新已有安装：

```bash
codex plugin marketplace upgrade vanyangyang
codex plugin add cursor-bridge@vanyangyang
```

安装或更新后，重启 Codex 并新建任务，使新版 MCP 工具和 skills 进入新会话。

### Claude Code

首次安装：

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

更新已有安装：

```bash
claude plugin update cursor-bridge@vanyangyang
```

安装或更新后，重启 Claude Code 或执行 `/reload-plugins`。

## 初始化 CCE

当前 Codex 或 Claude Code 上下文初始化一次即可。初始化会校验并持久化工作区，通过系统对应的方式查找 Cursor，确保所需 CDP 生命周期可用，并打开或核验匹配的项目 target。结果保存在插件缓存之外，adapter / 插件重启后仍然有效；需要切换项目时再次初始化即可覆盖。

直接用自然语言告诉 Codex 或 Claude Code：

```text
初始化 CCE 工作区为 C:\absolute\path\to\project
```

宿主会把这句话映射到单参数工具 `cursor_init({path})`。Cursor Bridge 不再提供需要记忆、也可能与宿主冲突的 slash 命令。没有持久化初始化结果时，当前宿主路径与 `CURSOR_PROJECT_PATH` 仍可作为兼容回退；显式初始化拥有最高优先级。

路径必须指向已存在的项目文件夹或 `.code-workspace` 文件。带引号路径、Windows UNC / 扩展路径以及 macOS `~` 路径都会在内部规范化；相对路径和无关普通文件会直接给出简单纠正提示。

Cursor 可执行文件的查找完全由内部处理，不增加初始化参数。Windows 会先检查 Cursor shell / 卸载注册信息，再检查标准用户级与系统级安装位置；macOS 会检查 `/Applications/Cursor.app` 与 `~/Applications/Cursor.app`。只有便携版或自定义安装通常需要设置 `CURSOR_EXE`；它可以指向 `Cursor.exe`、Windows Cursor 安装文件夹、macOS `.app`，或其中的 `Contents/MacOS/Cursor`。带引号路径也会自动规范化。

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
| `cursor_init` | 使用一个绝对工作区路径初始化或重新初始化 CCE。 |
| `cursor_context_engine` | 自适应只读项目理解，返回紧凑、可核验的 `path:line` 证据；唯一参数是 `query`。 |
| `cursor_do` | 提交有边界的 FIFO（先进先出的串行队列）或独立 `parallel_agent` 任务。 |
| `cursor_status` | 只读查看连接、队列、占用、运行时和任务状态。 |
| `cursor_task_control` | 对单个任务执行 `reap`、定向 `cancel` 或显式 `abandon`。 |
| `cursor_runtime` | 在可见的 `normal` 与后台 `minimal` 模式之间持久切换。 |

## 极简运行时

直接告诉 Codex 或 Claude Code：“将 CCE 切换到极简模式。”需要再次使用 Cursor 界面时，说：“将 CCE 切换到普通模式。”

极简模式是希望无感使用 Cursor Bridge 时的推荐选项，但它不会默认开启：全新安装仍使用可见的 `normal` 模式。目前只有 Windows 11 的顶层窗口抑制经过实机测试成功。用户明确开启后，选择会持久化；Bridge 会预热真实 Cursor 进程并隐藏其顶层窗口，同时保留项目索引、Agent DOM 与任务队列。它是 **UI-suppressed runtime**，不是重新实现的 headless Cursor。

- **优点：** `cursor_context_engine` 与 `cursor_do` 可以持续在后台使用，不会让 Cursor 界面打断当前工作。
- **代价：** 极简模式启用期间，手动打开 Cursor 只会复用受守卫的单实例，窗口会再次被隐藏。要恢复日常 Cursor 界面使用，必须先让 CCE **切换到普通模式**；无需再记一个临时显示状态。

如果 Cursor 在 CCE 建立连接前已经打开，初始化仍会保存工作区，并只给出一个安全动作：保存当前工作，正常退出 Cursor 一次。随后重复同一句初始化指令，Bridge 会按照当前选择的 `normal` 或 `minimal` 模式自动重新打开 Cursor；无需重启 Codex 或 Claude Code。

- `cursor_runtime({mode: "normal"})`：恢复普通可见行为。
- `cursor_runtime({mode: "minimal"})`：保持 CCE 可用，同时持续隐藏 Cursor 窗口。

切换回 `normal` 时，即使 Windows 已认为 Electron 窗口可见，也会强制执行原生 restore 与 redraw，避免有完整 DOM 的 Agents Window 恢复成白色合成表面。

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
| `CURSOR_PROJECT_PATH` | 未设置 | 仅在没有持久化 `cursor_init` 工作区时使用的可选兼容回退；未设置时自动探测宿主项目。 |
| `CURSOR_EXE` | 自动探测 | 便携版/自定义安装使用的可选可执行文件、Windows 安装目录或 macOS `.app` 覆盖。 |

高级 lifecycle 覆盖主要用于兼容诊断；Windows 上不建议绕过单例 supervisor。

</details>

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](./assets/star-history.svg)](https://github.com/Vanyangyang/cursor-bridge/stargazers)
