<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge"><img alt="30 Star milestone" src="https://img.shields.io/badge/30_STAR_MILESTONE-THANK_YOU!-FFD700?style=for-the-badge&amp;logo=github&amp;logoColor=white&amp;labelColor=181717" /></a>
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/master"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center"><strong>✨ 30 Stars 达成，感谢每一位关注者！本项目将长期维护，其中 Cursor Bridge 会持续跟进 Cursor 最新版本。如果这个项目对您有帮助，欢迎点亮一个 ⭐ Star，感谢您的支持！✨</strong></p>

<p align="center"><sub><strong>版本兼容说明：</strong>Cursor Bridge 只维护 Cursor 最新版本，不再主动兼容上一版本。如果需要使用历史 Cursor 版本，请先前往 <a href="./COMPATIBILITY.zh-CN.md">Cursor Bridge 兼容与更新历史</a>，精确切换到已列出的对应版本；历史版本不再维护。如果历史版本仍不能满足您的需求，请点击仓库右上角的 <strong>Fork</strong>，并在自己的 Fork 中自行适配。</sub></p>

# Cursor Bridge + Grok Build Supervisor

[English](./README.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

> [!WARNING]
> **目前仅支持 Windows：** Cursor Bridge 和 Grok Build Supervisor 当前都只支持 Windows；macOS 和 Linux 尚不支持，也未通过端到端验收。

**两个独立安装、互不影响的 Coding Agent MCP 插件，可用于 Codex、Claude Code、Grok Build 和 Pi；只安装自己需要的 Bridge 即可。**

| 插件 | 用途 | 文档 |
|---|---|---|
| **Cursor Bridge** | 让 Codex / Claude Code / Grok Build / Pi 通过 Cursor CCE 自动理解项目、找准代码、查清调用关系；需要时，可以让可选功能 `cursor_do` 执行明确的任务 | [继续阅读](#cursor-bridge) |
| **Grok Build Supervisor** | 让 Codex / Claude Code / Pi 负责规划和把关，自动调度 Grok Build 执行任务、跟进过程并核验结果 | [中文](./plugins/grok-build-supervisor/README.zh-CN.md) · [English](./plugins/grok-build-supervisor/README.md) |

## 让你正在使用的客户端同时调用 Cursor 与 Grok Build

继续使用你原本就在用的 **Codex（推荐）**、Claude Code 或 Pi 作为常用代码客户端。两个插件互相独立：只安装 Cursor Bridge，当前客户端就能使用 Cursor；只安装 Grok Build Supervisor，就能协调 Grok Build；两者都安装后，则可以在同一段对话里同时使用这两种能力。

```text
Codex（推荐）/ Claude Code / Pi
        你原本使用的开发客户端
              │
        插件赋予协调能力
          ┌───┴──────────────┐
          ▼                  ▼
    Cursor Bridge     Grok Build Supervisor
   CCE + cursor_do       受监督的 Grok Build
```

- 先用 `cursor_context_engine` 获取精简、可回到源码核验的项目理解。
- 需要 Cursor 动手时，直接使用现在更明确的 `cursor_do` 路径执行有边界任务；最终 diff 和测试仍由当前客户端验收。
- 需要 Grok Build 执行时，开启 `/grok_execute on`；当前客户端继续负责计划、看进度、处理问题与核验结果。

这个仓库不是一款新的“协调器”，而是给你正在使用的客户端增加这些能力；按需安装即可。

## Grok Build Supervisor（New）

**让 Codex、Claude Code 或 Pi 负责规划和把关，自动调度 Grok Build 执行任务、跟进过程并核验结果。**

它与 Cursor Bridge 分别安装、分别更新。

[查看介绍、安装方法和使用说明 →](./plugins/grok-build-supervisor/README.zh-CN.md)

## Cursor Bridge

**让 Codex / Claude Code / Grok Build / Pi 通过 Cursor CCE 自动理解项目、找准代码、查清调用关系；需要时，可以让可选功能 `cursor_do` 执行明确的任务。**

> [!IMPORTANT]
> **Windows 一次性迁移：** 如果当前安装的是 Cursor Bridge 5.3.6 或更早版本，首次升级到 5.4.0 或任何后续版本前，请先保存工作，并按照[“更新已有安装”](#windows-update-migration)完成一次旧缓存进程清理。完成后，后续更新使用正常流程。

> [!NOTE]
> **实机验证环境：** Windows 11 + Cursor **3.17.19**（全新 Agents Window 启动）。需要 Node.js 18+、已安装并登录的 Cursor，以及 Cursor 能打开的本地项目。本次启动没有暴露旧版 IDE/workbench CDP 目标，因此不对该界面作当前组合的验收声明。macOS 尚未实机验证。

## CCE 是什么？

**Cursor Context Engine（CCE）通过 MCP，把 Cursor 已有的项目索引与 Agent 搜索能力交给 Codex / Claude Code / Grok Build / Pi 使用。**

你只需要问一次真实的项目问题。Cursor 自己决定要使用语义检索、精确搜索、源码读取、引用追踪还是 Agent 探索；Cursor Bridge 最后只把精简、可追溯到源码的 `path:line` 证据与相关性说明交回主 Agent，而不是把整个搜索过程塞进主上下文。

这样可以减少猜目录、重复 `grep` 和无效上下文消耗。

Cursor Bridge 不检查或管理 Cursor 订阅。已登录 Cursor 能使用哪些模型、额度与 BYOK 选项，仍取决于你自己的 Cursor 配置。

## 快速开始

### 1. 选择当前客户端，按需安装

下面按你正在使用的客户端分组。Cursor Bridge 与 Grok Build Supervisor 互相独立：可以只装一个，也可以两个都装。

#### Codex（推荐）

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add cursor-bridge@vanyangyang
# 可选：为完整的 Cursor + Grok Build 工作流再安装 Supervisor
codex plugin add grok-build-supervisor@vanyangyang
```

#### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
# 可选：为完整的 Cursor + Grok Build 工作流再安装 Supervisor
claude plugin install grok-build-supervisor@vanyangyang
```

#### Grok Build

```bash
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge
```

不先加市场也可以直接装：`grok plugin install Vanyangyang/cursor-bridge --trust`。

#### Pi

```bash
pi install npm:pi-cursor-bridge
# 可选：为完整的 Cursor + Grok Build 工作流再安装 Supervisor
pi install npm:pi-grok-build-supervisor
```

### 2. 重启或重载当前客户端

Codex 需要重启并新建任务；Claude Code 可重启或执行 `/reload-plugins`；Grok 可在 `/plugins` 中重载或新开会话；Pi 需要重启。Grok 插件默认关闭，需执行 `grok plugin enable cursor-bridge`；`--trust` 用来允许运行插件自带的 MCP 和 hooks。

### 3. 初始化已经安装的插件

如果安装了 Cursor Bridge，Pi 会自动绑定启动时所在的目录；其他宿主可用自然语言初始化或切换项目。需要让 Pi 临时使用另一个项目时，也可以说：

```text
初始化 CCE 工作区为 C:\absolute\path\to\project
```

初始化结果会持久保存。需要切换项目时，再用另一个绝对路径重复同一句话即可。

如果安装了 Grok Build Supervisor，先运行一次 `/grok_init`；然后在需要当前客户端协调 Grok Build 的项目中运行 `/grok_execute on`。

### 4. 开始处理真实任务

安装 Cursor Bridge 后，可以直接问真正的项目问题：

```text
这个状态由谁持有？从存档加载、运行时使用到保存写回的完整链路是什么？
```

开启 Grok Build Supervisor 后，直接发送正常的开发任务；当前客户端负责规划和验收，Grok Build 负责执行。

> [!TIP]
> **Windows 11 推荐：极简模式**
>
> 初始化完成后，说“将 CCE 切换到极简模式”。真实 Cursor、项目索引、Agent DOM 与任务队列会继续在后台运行，只隐藏顶层窗口；你可以把 Cursor 作为插件背后的能力无感使用，`cursor_context_engine` 和 `cursor_do` 仍然可用。
>
> **代价：**极简模式期间，手动打开 Cursor 只会复用受守卫的单实例，并继续保持隐藏。需要重新使用 Cursor 界面时，先说“将 CCE 切换到普通模式”。

## 兼容性

当前 Cursor 兼容目标（Windows 11）：

| Cursor | Cursor Bridge | 说明 |
|---|---|---|
| **3.17.19** | **5.5.0**（`master`，当前版本） | 已通过 Windows 11 全新 Agents Window 启动，实机验证工作区绑定、CCE、FIFO、独立 parallel Agent、精确 Agent ID，以及 normal/minimal 切换期间的 CCE；本次启动没有暴露旧版 IDE/workbench。 |

不再主动维护旧 Cursor 版本。Cursor Bridge 5.4.2 / Cursor 3.17.8、Cursor Bridge 5.4.1 / Cursor 3.16.29 与 Cursor Bridge 5.4.0 / Cursor 3.16.17 的历史组合及精确安装指令见[兼容与更新历史](./COMPATIBILITY.zh-CN.md)。Agents Window 不可用但 Cursor 暴露 IDE/workbench 时，CCE 会使用该界面。运行中的 FIFO 在当前编辑器能提供会话身份时会发布 Agent ID，`cursor_task_control` 的 cancel 只停止这一条；没有 ID 时不会猜测点击 Stop。

支持的宿主：**Codex**、**Claude Code**、**Grok Build**、**Pi**。Grok 安装后执行 `grok plugin enable cursor-bridge`，再在 `/plugins` 按 `r`，或新开一个会话。

## 用好 CCE 与 `cursor_do`

- **先理解项目：** `cursor_context_engine` 会追踪所有权、调用链、数据流、注册关系和跨模块联系，最后只返回精简的源码锚点、覆盖范围、缺口与置信度。
- **再用 `cursor_do` 执行有边界任务：** 它会把范围清楚的任务交给 Cursor Agent，并返回稳定的任务 ID，便于继续查看与恢复。`cursor_do` 仍是可选能力，但不再藏在边角：只要一次有边界的 Cursor 执行能节省时间，就可以直接使用；最终结果、真实工作区改动与验证证据仍由主 Agent 审核。

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

<a id="windows-update-migration"></a>

## 更新 Cursor Bridge

Cursor Bridge 5.4.0 及后续版本使用下面的正常更新命令。如果当前安装的是 5.3.6 或更早版本，请先完成[一次性 Windows 迁移](#one-time-windows-migration)，再回来执行这些命令。

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

Pi：

```bash
pi update npm:pi-cursor-bridge
```

更新后请新建 Codex 任务；重启 Claude Code 或执行 `/reload-plugins`；在 Grok 的 `/plugins` 中重载或新开会话；或者重启 Pi。已经打开的任务不会热加载新 MCP、Skill 或命令。

如果 Codex 提示 `marketplace 'vanyangyang' is not configured as a Git marketplace`，先运行一次 `codex plugin marketplace add Vanyangyang/cursor-bridge --ref master`，再重试上面的 Codex 命令。

<a id="one-time-windows-migration"></a>

### 从 Cursor Bridge 5.3.6 或更早版本进行一次性 Windows 迁移

> [!WARNING]
> **只有首次从 Cursor Bridge 5.3.6 或更早版本升级时才需要这次 Windows 清理。** 旧插件进程可能占用带版本号的缓存目录，阻止系统替换它。不要修改 ACL，也不要删除插件缓存。

> [!TIP]
> **推荐把这句话交给本地 Coding Agent：**“我已保存工作。先核对已安装的 Cursor Bridge 版本。只有版本为 5.3.6 或更早时，才检查命令行从宿主带版本号插件缓存加载 `cursor-lifecycle-supervisor.mjs` 或 `dist/cursor-bridge.mjs` 的进程。凡是位于 `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` 下的实例，都是新版持久运行时，不要停止。核验准确的旧缓存路径和归属后，只停止这些旧缓存进程，无需再次询问；禁止批量结束 Node 或 PowerShell、修改 ACL、删除缓存或处理无关进程。旧 adapter 停止后，当前任务中的旧 Cursor Bridge MCP 可能断开，这是预期现象。随后使用当前宿主的正常 marketplace 命令把 Cursor Bridge 更新到最新版、重载宿主，并报告安装后的版本、marketplace 来源和仍存在的旧缓存进程。”

完成这次一次性迁移后，后续更新不再需要特殊进程清理。

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
Codex / Claude Code / Grok Build / Pi
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
- `cursor_status` 只列 CDP 页标题，不再探测页面 DOM。CCE 会对 DOM 确实为空的 Agents 页 reload 一次；Windows normal 模式复用 Agents Window 时还会进行一次有节流、无抢焦点的原生合成器重绘，避免 DOM 正常却只显示 Electron 白色表面。
- 缓存 target 的窗口标题不再匹配项目时会被拒绝；但 `Cursor Agents` 这个 Agents Window 标题是合法的可复用 target。
- Cursor 使用旧 UI、新 UI 还是同时开启，仍由用户决定；Bridge 不会改写偏好。
- Windows 上 supervisor 不会随单个 Codex、Claude Code、Grok Build 或 Pi 会话关闭而退出 Cursor。

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
- `reap` 用于已绑定的并行孤儿。定向 `cancel` 需要精确的已发布 Agent ID。Agents Window 或 Workbench 上的 FIFO 若已发布 Agent ID，也走同一条定向停止。未发布时 Bridge 不会猜测点击 Stop；请先在 Cursor 确认已停止，再 `abandon`。
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

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/master/assets/star-history.svg?v=91940ce6cc4a)](https://github.com/Vanyangyang/cursor-bridge)
