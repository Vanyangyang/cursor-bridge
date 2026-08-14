# cursor-bridge

[English](./README.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

**把你真实、已登录的 Cursor 会话所拥有的项目理解能力，直接交给 Codex / Claude Code / Grok Build。**

> [!NOTE]
> **实机验证环境：** Windows 11 + Cursor 3.16.17，含 Grok Build TUI。需要 Node.js 18+、已安装并登录的 Cursor，以及 Cursor 能打开的本地项目。macOS 尚未实机验证。

## CCE 是什么？

**Cursor Context Engine（CCE）通过 MCP，把 Cursor 已有的项目索引与 Agent 搜索能力交给 Codex / Claude Code / Grok Build 使用。**

你只需要问一次真实的项目问题。Cursor 自己决定要使用语义检索、精确搜索、源码读取、引用追踪还是 Agent 探索；Cursor Bridge 最后只把精简、可追溯到源码的 `path:line` 证据与相关性说明交回主 Agent，而不是把整个搜索过程塞进主上下文。

这样可以减少猜目录、重复 `grep` 和无效上下文消耗。

Cursor Bridge 不检查或管理 Cursor 订阅。已登录 Cursor 能使用哪些模型、额度与 BYOK 选项，仍取决于你自己的 Cursor 配置。

## 快速开始

### Codex

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add cursor-bridge@vanyangyang
```

### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

### Grok Build

```bash
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge
```

Grok 的插件默认是关闭的，装完必须 `enable`。`--trust` 用来放行插件自带的 MCP 和 hooks。当前会话不会热加载刚装的插件：打开 `/plugins` 按 `r`，或新开一个 Grok 会话。

不先加市场也可以直接装：`grok plugin install Vanyangyang/cursor-bridge --trust`。

重启 Codex 并新建任务，重启 Claude Code / 执行 `/reload-plugins`，或按上面的方式重载 Grok。然后用自然语言初始化项目：

```text
初始化 CCE 工作区为 C:\absolute\path\to\project
```

直接问真正的项目问题：

```text
这个状态由谁持有？从存档加载、运行时使用到保存写回的完整链路是什么？
```

初始化结果会持久保存。需要切换项目时，再用另一个绝对路径重复同一句初始化指令即可。

> [!TIP]
> **Windows 11 推荐：极简模式**
>
> 初始化完成后，说“将 CCE 切换到极简模式”。真实 Cursor、项目索引、Agent DOM 与任务队列会继续在后台运行，只隐藏顶层窗口；你可以把 Cursor 作为插件背后的能力无感使用，`cursor_context_engine` 和 `cursor_do` 仍然可用。
>
> **代价：**极简模式期间，手动打开 Cursor 只会复用受守卫的单实例，并继续保持隐藏。需要重新使用 Cursor 界面时，先说“将 CCE 切换到普通模式”。
>
> 这是 Windows 11 上经过实测的显式、持久选择，不是重新实现的 headless Cursor。切回普通模式时不会主动抢走键盘焦点；最小化、最大化与贴靠布局仍由你控制。

## 兼容性

支持的 Cursor 版本（Windows 11）：

| Cursor | 说明 |
|---|---|
| **3.16.17** | 已实机验证。workbench 和 Agents Window。 |
| **3.7.42** | 已实机验证。workbench 和 Agents Window。 |

其他 Cursor 版本尚未测试。打不开 Agents Window 时，会改用 workbench。

支持的宿主：**Codex**、**Claude Code**、**Grok Build**。Grok 安装后执行 `grok plugin enable cursor-bridge`，再在 `/plugins` 按 `r`，或新开一个会话。

## 两项核心能力

- **理解项目：** `cursor_context_engine` 会追踪所有权、调用链、数据流、注册关系和跨模块联系，最后只返回精简的源码锚点、覆盖范围、缺口与置信度。
- **委派有边界任务：** `cursor_do` 会把明确限定范围的子任务交给 Cursor Agent，并返回任务 ID；最终结果和工作区改动仍由主 Agent 审核。

## 完整 MCP 工具说明

| 工具 | 作用 |
|---|---|
| **`cursor_init`** | 使用一个绝对路径初始化 CCE，或切换工作区。 |
| **`cursor_context_engine`** | 使用一个自然语言 `query` 进行只读项目理解。 |
| **`cursor_do`** | 把明确、有边界的子任务交给 Cursor Agent 执行。 |
| **`cursor_status`** | 只读查看连接、队列、运行时和任务状态。 |
| `cursor_runtime` | 在可见 `normal` 与经过 Windows 11 实测的 UI 抑制 `minimal` 模式之间切换。 |
| `cursor_task_control` | 对指定任务执行 `reap`、`cancel` 或显式确认风险的 `abandon`。 |

> [!WARNING]
> Cursor 是 Agent，不是文件系统沙箱。CCE 会强提示只读调查，但提示词与允许路径并不是操作系统级隔离；重要结论和工作区改动仍需核验。

<details>
<summary><strong>更新已有安装</strong></summary>

Codex：

```bash
codex plugin marketplace upgrade vanyangyang
codex plugin add cursor-bridge@vanyangyang
```

Claude Code：

```bash
claude plugin marketplace update vanyangyang
claude plugin update cursor-bridge@vanyangyang
```

Grok Build：

```bash
grok plugin marketplace update cursor-bridge
grok plugin update cursor-bridge
```

更新后请重启 Codex 并新建任务，重启 Claude Code / 执行 `/reload-plugins`，或在 Grok 打开 `/plugins` 按 `r` / 新开会话。

</details>

<details>
<summary><strong>CCE 如何搜索，以及返回什么证据</strong></summary>

`cursor_context_engine` 只有一个公开参数：`query`。问题需要多深，由 Cursor 根据实际发现的证据自行决定。

它可以组合：

- 索引语义检索；
- 精确文本搜索；
- 符号与引用追踪；
- 定向源码核对；
- 跨文件核验确实需要时使用 Cursor Explore。

为什么这条路可行？因为 Cursor 的项目理解本身就结合了语义索引、精确搜索、定向读取和 Agent 探索。Cursor Bridge 选择复用这套现成能力，而不是再造一套代码搜索栈。

简单定位应快速收敛；调用链、数据流、注册关系、接口实现和所有权问题可以跨模块继续追踪，直到取得最小充分证据。

安装后的 `cce-routing` Skill 会为陌生项目语义问题提供有边界的 CCE 路由指引，同时让已知文件读取、测试、日志、构建、Git 和外部文档继续使用原生工具。Grok Build 在插件启用后会加载同一套 plugin skill。Claude Code 还有一个很窄、失败开放的竞争检索路由保护；最终是否调用工具，仍由宿主模型决定。

返回格式：

```text
CCE_SEARCH_RESULT
intent: <标准化意图>
coverage: <focused|extended> | <为什么当前深度已经足够>
evidence:
- path/to/file.ts:42-67 | symbolOrAnchor | 已核验的相关性或关系 | reference
gaps: none
confidence: high
```

- 证据按强度排序。
- 语义相似不会被包装成已证明调用边。
- 缺少证据时返回 `NOT_FOUND` 和实际搜索范围，而不是按框架惯例猜测。
- 对话式前言会被移除，但不会编造证据。

</details>

<details>
<summary><strong>工作区、Cursor UI 与生命周期</strong></summary>

```text
Codex / Claude Code / Grok Build
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

- `cursor_init` 为当前宿主上下文校验并持久化一个工作区；再次执行即可切换项目。
- 项目索引由 Cursor 自己负责。Bridge 只确保连接，并选择经过校验、与项目匹配的 CDP target。
- 多个 MCP adapter 共用一个用户级 lifecycle supervisor，并在读取状态或执行生命周期操作前重新同步持久运行模式。
- workbench 和 Agents Window 同时开着时，Bridge 优先在当前项目的 Agents Window 里工作；只有 workbench 时就用 workbench。不会落到 `Home`。
- Agents Window 已经打开时，ensure 会复用该 CDP 页，不再执行 `Cursor.exe --new-window`。只有 Cursor 已连接、且既没有 Agents Window、也没有标题匹配的编辑器窗口时，才会再开一个 workbench。
- `cursor_status` 只列 CDP 页标题，不再探测页面 DOM。Agents Window 白屏时，CCE 会先对该页做一次 reload，再继续。
- 缓存 target 的窗口标题不再匹配项目时会被拒绝；但 `Cursor Agents` 这个 Agents Window 标题是合法的可复用 target。
- Cursor 使用旧 UI、新 UI 还是同时开启，仍由用户决定；Bridge 不会改写偏好。
- Windows 上 supervisor 不会随单个 Codex、Claude Code 或 Grok 会话关闭而退出 Cursor。

初始化路径可以是已存在的项目目录或 `.code-workspace` 文件。带引号路径、Windows UNC / 扩展路径和 macOS `~` 路径会自动规范化；相对路径和无关文件会被拒绝。

Cursor 可执行文件通常无需配置。Bridge 会自动检查 Windows 注册位置、标准用户/系统安装，以及 macOS 的 `/Applications/Cursor.app`、`~/Applications/Cursor.app`。只有便携版或自定义安装通常需要 `CURSOR_EXE`。

macOS 的路径规范化与可执行文件发现只是已实现逻辑，不代表完成了端到端支持验证；这些分支目前尚未实机测试。

如果 Cursor 已经在运行、但没有 Bridge 所需的连接能力，Bridge 会返回一次 `close_cursor_and_retry`，不会自行终止 Cursor。请先保存工作，正常退出 Cursor 一次，再重复初始化指令。

</details>

<details>
<summary><strong>cursor_do 执行与恢复</strong></summary>

- FIFO 即先进先出：普通任务通过一个 UI lock 串行执行，并在干净对话中开始。
- 独立 `parallel_agent` 使用不同的顶层 Cursor Agent。并行写任务必须提供互不重叠的 `allowed_paths`；只读任务使用 `read_only=true`。
- 保存返回的 `task_id`，再用 `cursor_status(task_id)` 回收。
- `submitting`、`running`、`collecting` 都是正常非终态。
- Bridge 会确认 Cursor 是否接受提示。提示仍留在输入框时只尝试一次精确 Send 控件，仍失败则返回 `submit_not_accepted`，不会静默制造孤儿。
- provider-error 托盘会被保留为失败证据；Bridge 不会自动点击 Retry。
- 发送后状态不确定时保留占用，不会静默释放或重投。
- `reap` 用于已绑定孤儿；定向 `cancel` 需要精确 Agent ID；`abandon` 需要显式确认风险。
- 任务记录只存在于当前进程。MCP 重启后，开始重叠工作前应检查 Agent History 与工作区变化。

</details>

<details>
<summary><strong>从源码运行与高级覆盖</strong></summary>

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

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor 远程调试端口。 |
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | 搜索完成超时，单位毫秒。 |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | 未设置 | 设为 `1` 可关闭启动预热。 |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | 没有持久化选择时的初始模式。 |
| `CURSOR_BRIDGE_RUNTIME_FILE` | 用户配置目录 | 覆盖持久运行模式文件。 |
| `CURSOR_BRIDGE_WORKSPACE_FILE` | 用户 lifecycle 目录 | 覆盖持久工作区绑定文件。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 设为 `off` 可禁用并隐藏 `cursor_do`。 |
| `CURSOR_PROJECT_PATH` | 未设置 | 仅在没有持久初始化时使用的兼容回退。 |
| `CURSOR_EXE` | 自动探测 | 便携/自定义可执行文件、Windows 安装目录或 macOS `.app` 覆盖。 |

高级 lifecycle 覆盖用于兼容诊断；Windows 上不建议绕过单例 supervisor。

</details>

## 友情链接

- [LINUX DO](https://linux.do) — 新的理想型社区

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/master/assets/star-history.svg?v=692b701592ba)](https://github.com/Vanyangyang/cursor-bridge)

由 GitHub 仓库 API 自动更新，不依赖外部图表服务，也不需要手工维护 PAT。
