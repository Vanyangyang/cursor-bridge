<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/main"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center">如果 Cursor Bridge 对你有用，欢迎点个 GitHub Star。</p>

<p align="center"><sub><strong>兼容说明：</strong>我只跟着 Cursor 最新版维护。旧版 Cursor 我不会主动去适配。如果必须用历史 Cursor，先看 <a href="./COMPATIBILITY.zh-CN.md">兼容与更新历史</a>，有列出对应的 Bridge 归档版就切到那一版。归档版不再修。对不上的话，点右上角 <strong>Fork</strong>，在自己的仓库里改。</sub></p>

# Cursor Bridge + Grok Build Supervisor

[English](./README.md) · [Changelog](./CHANGELOG.md) · [AI 安装](./docs/ai-install.zh-CN.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

> [!WARNING]
> **目前仅支持 Windows：** Cursor Bridge 和 Grok Build Supervisor 当前都只支持 Windows；macOS 和 Linux 尚不支持，也未通过端到端验收。

我维护了两个 MCP 插件，分开装，互不影响。Codex、Claude Code、Grok Build、Pi 都能用。你的 AI 客户端如果能走 MCP，但不在这四个里面，把[AI 安装说明](./docs/ai-install.zh-CN.md)交给当前 AI，让它自己装 MCP 和 Skill。

| 插件 | 用途 | 文档 |
|---|---|---|
| Cursor Bridge | 让 Codex / Claude Code / Grok Build / Pi 通过 Cursor CCE 问项目、对到源码。可选的 `cursor_do` 可以把范围清楚的任务交给 Cursor Agent。 | [继续阅读](#cursor-bridge) |
| Grok Build Supervisor | Codex / Claude Code / Pi 继续做计划和验收，落地交给 Grok Build。Supervisor 看着执行和核对。 | [中文](./plugins/grok-build-supervisor/README.zh-CN.md) · [English](./plugins/grok-build-supervisor/README.md) |

## 继续用你手头的客户端，接上 Cursor 和 Grok Build

我自己日常还是 Codex，也更建议用它。Claude Code 和 Pi 一样能接。这里说的 AI 客户端，就是你正在对话的那套编程软件，不是 `cursor_do` 派出去的 Cursor Agent，也不是 MCP 协议里的 client。

两个插件不绑在一起。想用 Cursor 就装 Cursor Bridge。想调度 Grok Build 就装 Grok Build Supervisor。两个都要，就都装，同一段对话里一起用。

```text
Codex（推荐）/ Claude Code / Pi
        你原本使用的 AI 客户端
              │
            可选插件
          ┌───┴──────────────┐
          ▼                  ▼
    Cursor Bridge     Grok Build Supervisor
   CCE + cursor_do       受监督的 Grok Build
```

我一般先用 `cursor_context_engine` 拿一份能回到源码核对的项目上下文。觉得一次有边界的 Cursor 执行更省事，再用 `cursor_do`；diff 和测试还是当前 AI 客户端自己看。需要 Grok Build 动手时开 `/grok_execute on`，当前客户端继续做计划、看进度、回答问题、验收结果。

插件挂在你已经在用的客户端上。我没有再做一层协调器。

## Grok Build Supervisor（New）

Codex、Claude Code 或 Pi 继续做计划和验收，落地交给 Grok Build。Supervisor 跟着看执行和核对。

它和 Cursor Bridge 分开安装、分开更新。

[查看介绍、安装方法和使用说明 →](./plugins/grok-build-supervisor/README.zh-CN.md)

## Cursor Bridge

我想让 Codex / Claude Code / Grok Build / Pi 走 Cursor CCE 问项目时，用的就是这个插件。`cursor_do` 是可选的，用来把范围清楚的任务交给 Cursor Agent。

> [!IMPORTANT]
> **Windows 一次性迁移：** 如果当前安装的是 Cursor Bridge 5.3.6 或更早版本，首次升级到 5.4.0 或任何后续版本前，请先保存工作，并按照[“更新已有安装”](#windows-update-migration)完成一次旧缓存进程清理。完成后，后续更新使用正常流程。

> [!NOTE]
> 当前配对与证据边界见[兼容与更新历史](./COMPATIBILITY.zh-CN.md)和[最新发布](https://github.com/Vanyangyang/cursor-bridge/releases)。

CCE 与 `cursor_do` 支持可选的 `request_context`，例如 `{"sender":"model","source":"mixed"}`。`sender` 声明直接发送者（`user/model/unknown`），`source` 区分用户要求与模型补充（`user/model/mixed/unknown`）；混合内容在正文中分开标注。未提供时保持 unknown，不从所选模型推断，也不授予额外权限。任务状态保留本轮声明。
>
> **实机验证环境：** Windows 11 + Cursor **3.21.16**；版本由 Cursor 内置包元数据与当前用户卸载注册表共同确认。Cursor Bridge 6.0.5 的发布代码在刷新缓存后通过了原生精确工作区绑定和 Grok 4.7/high 的只读 FIFO `cursor_do`；CDP 在提交前确认内部模型为 `grok-4.7`、`reasoning_effort=high`。原生 host 当时仍报告升级版本前的 6.0.4 标签，因此精确的 6.0.5 标签加载仍待发布后由新任务确认。继承自 6.0.4 的 IDE 与 Agents Window 完整验收覆盖 CCE、两个同时运行的独立 Agent、持续会话重启恢复、未读结果补收、`minimal` CCE 后恢复 normal，以及两种关闭顺序均只恢复最后关闭的一种窗口。需要 Node.js 18+、已安装并登录的 Cursor，以及 Cursor 能打开的本地项目；macOS 尚未实机验证。

## CCE 是什么？

Cursor Context Engine（CCE）就是 Cursor 自己的项目索引和 Agent 搜索，通过 MCP 交给 Codex / Claude Code / Grok Build / Pi 用。

问一次真实的项目问题就行。语义检索、精确搜索、读源码、追引用、还是 Agent 探索，由 Cursor 自己选。Bridge 只把精简的 `path:line` 证据和相关性说明交回主 Agent，不会把整段搜索过程塞进主上下文。

我写 Bridge，就是不想看主 Agent 猜目录、同一棵树 `grep` 两遍。

Cursor Bridge 不检查、也不管理你的 Cursor 订阅。能用哪些模型、额度、BYOK，还是你登录的那个 Cursor 自己的配置。

## 快速开始

### 1. 选择当前 AI 客户端，按需安装

下面按你正在用的 AI 客户端分组。Cursor Bridge 和 Grok Build Supervisor 分开装：只装一个也行，两个都装也行。

#### Codex（推荐）

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref main
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

<a id="other-mcp-hosts"></a>

#### 其他支持 MCP 的 AI 客户端

把这句话交给你正在使用的 AI 客户端：

```text
请完整阅读 https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.zh-CN.md ，按其中步骤把 Cursor Bridge 安装到当前 AI 客户端，并按文末完成标准逐项汇报。只使用这份说明里指定的通用 npm 包。不要发明 marketplace 插件，不要借用 Pi 包，也不要发布任何包。
```

这份说明会让当前 AI 先认客户端。Codex / Claude Code / Grok / Pi 还是走各自的 marketplace 命令；其他客户端把 `vanyangyang-cursor-bridge` 装到 `%LOCALAPPDATA%\cursor-bridge\npm`。说明只告诉 MCP bundle 和 Skill 装在哪，登记、重启、初始化工作区都由当前 AI 客户端自己做。这不是我优先维护的安装方式，也没做过实机验收。Cursor Bridge 目前仍只支持 Windows。

### 2. 重启或重载当前 AI 客户端

Codex 需要重启并新建任务；Claude Code 可重启或执行 `/reload-plugins`；Grok 可在 `/plugins` 中重载或新开会话；Pi 需要重启；其他支持 MCP 的 AI 客户端则重启当前对话。Grok 插件默认关闭，需执行 `grok plugin enable cursor-bridge`；`--trust` 用来允许运行插件自带的 MCP 和 hooks。

### 3. 初始化已经安装的插件

如果安装了 Cursor Bridge，Pi 会自动绑定启动时所在的目录；其他 AI 客户端可用自然语言初始化或切换项目。需要让 Pi 临时使用另一个项目时，也可以说：

```text
初始化 CCE 工作区为 C:\absolute\path\to\project
```

初始化结果会持久保存。需要切换项目时，再用另一个绝对路径重复同一句话即可。

如果安装了 Grok Build Supervisor，先初始化一次（Codex 使用 `$grok-build-supervisor init`），再在需要 Grok 工作的项目中选择 **Enable Grok Execution**。选择 **Disable Grok Execution** 可恢复 AI 客户端正常执行，且不会关闭终端；两个开关都不需要额外参数。其他 AI 客户端和兼容命令见 [Grok 使用指南](./plugins/grok-build-supervisor/README.zh-CN.md#安装)。

### 4. 拿一个真问题试试

装了 Cursor Bridge，就直接问项目里的真问题：

```text
这个状态由谁持有？从存档加载、运行时使用到保存写回的完整链路是什么？
```

开启 Grok Build Supervisor 后，直接发送正常的开发任务；当前 AI 客户端负责规划和验收，Grok Build 负责执行。

> [!TIP]
> **Windows 11 推荐：极简模式**
>
> 初始化完成后，说“将 CCE 切换到极简模式”。真实 Cursor、项目索引、Agent DOM 和任务队列还在后台跑，只是顶层窗口藏起来。`cursor_context_engine` 和 `cursor_do` 还能用，只是看不见 Cursor 界面。
>
> **代价：**极简模式期间，手动打开 Cursor 只会复用受守卫的单实例，并继续保持隐藏。需要重新使用 Cursor 界面时，先说“将 CCE 切换到普通模式”。

## 兼容性

当前配对、证据边界和归档安装指令见[兼容与更新历史](./COMPATIBILITY.zh-CN.md)和[最新发布](https://github.com/Vanyangyang/cursor-bridge/releases)。Agents Window 不可用但 Cursor 暴露 IDE/workbench 时，CCE 会使用该界面。运行中的 FIFO 在当前编辑器能提供会话身份时会发布 Agent ID，`cursor_task_control` 的 cancel 只停止这一条；没有 ID 时不会猜测点击 Stop。

支持的 AI 客户端是 Codex、Claude Code、Grok Build、Pi，这几个我做过实机验收。其他能走 MCP 的客户端可以用 [AI 安装说明](./docs/ai-install.zh-CN.md)；没有 marketplace 更新，也不算已验收集合。Grok 装完后执行 `grok plugin enable cursor-bridge`，再在 `/plugins` 按 `r`，或新开一个会话。

## 怎么用 CCE 和 `cursor_do`

`cursor_context_engine` 会顺着所有权、调用链、数据流、注册关系和跨模块联系往下查，回来只有精简的源码锚点、覆盖范围、缺口和置信度。

`cursor_do` 把范围清楚的任务交给 Cursor Agent，并返回稳定的任务 ID，方便接着看、接着恢复。它是可选的。我觉得一次有边界的 Cursor 执行更省事时才会用。结果、工作区改动、验证证据还是主 Agent 审。

模型可以口头指定，比如“CCE 默认使用 GPT-5.6 Terra，思考程度 max”，或“`cursor_do` 默认使用 GPT-5.6 Sol，思考程度 high”。`cursor_model` 会把 CCE 和 `cursor_do` 的默认值分开存，跨任务、跨重启都还在，除非你改或重置。Bridge 每次发送前都会套上选择并回读；对不上就停，不会悄悄退回 Auto。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `cursor_init` | 使用一个绝对路径初始化 CCE，或切换工作区。 |
| `cursor_context_engine` | 使用一个自然语言 `query` 进行只读项目理解。 |
| `cursor_do` | 把明确、有边界的子任务交给 Cursor Agent 执行。异步提交只返回精简回执；同步 `background=false` 仍返回完整结果。 |
| `cursor_model` | 查看、设置或重置 CCE、`cursor_do` 或两者的持久模型与思考程度默认值。 |
| `cursor_status` | 查看连接、队列、运行时、持久模型默认值，以及任务配置值与实际生效值。任务视图默认精简；`cursor_status(task_id, detail="result")` 返回纯完整回复并记录收取，`detail="full"` 保留诊断任务详情和回复。 |
| `cursor_runtime` | 在可见 `normal` 与经过 Windows 11 实测的 UI 抑制 `minimal` 模式之间切换。 |
| `cursor_task_control` | 对指定任务执行 `reap`、`cancel` 或显式确认风险的 `abandon`，并返回动作/状态摘要；正文需另用 `cursor_status(task_id, detail="result")` 取得。 |

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

其他支持 MCP 的 AI 客户端：让当前 AI 重新阅读 [AI 安装说明](./docs/ai-install.zh-CN.md)，更新已安装的 npm 包，然后重启当前 AI 客户端。

更新后请新建 Codex 任务；重启 Claude Code 或执行 `/reload-plugins`；在 Grok 的 `/plugins` 中重载或新开会话；重启 Pi；或者重启当前 AI 客户端。已经打开的任务不会热加载新 MCP、Skill 或命令。

如果 Codex 提示 `marketplace 'vanyangyang' is not configured as a Git marketplace`，先运行一次 `codex plugin marketplace add Vanyangyang/cursor-bridge --ref main`，再重试上面的 Codex 命令。

<a id="one-time-windows-migration"></a>

### 从 Cursor Bridge 5.3.6 或更早版本进行一次性 Windows 迁移

> [!WARNING]
> **只有首次从 Cursor Bridge 5.3.6 或更早版本升级时才需要这次 Windows 清理。** 旧插件进程可能占用带版本号的缓存目录，阻止系统替换它。不要修改 ACL，也不要删除插件缓存。

> [!TIP]
> **推荐把这句话交给本地 Coding Agent：**“我已保存工作。先核对已安装的 Cursor Bridge 版本。只有版本为 5.3.6 或更早时，才检查命令行从 AI 客户端带版本号的插件缓存加载 `cursor-lifecycle-supervisor.mjs` 或 `dist/cursor-bridge.mjs` 的进程。凡是位于 `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` 下的实例，都是新版持久运行时，不要停止。核验准确的旧缓存路径和归属后，只停止这些旧缓存进程，无需再次询问；禁止批量结束 Node 或 PowerShell、修改 ACL、删除缓存或处理无关进程。旧 adapter 停止后，当前任务中的旧 Cursor Bridge MCP 可能断开，这是预期现象。随后使用当前 AI 客户端的正常 marketplace 命令把 Cursor Bridge 更新到最新版、重载 AI 客户端，并报告安装后的版本、marketplace 来源和仍存在的旧缓存进程。”

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

我复用 Cursor，是因为它自己就有索引和 Agent 搜索。Bridge 只是把这套能力接到另一个 coding Agent 上，我不想再造一套搜索栈。

“这个符号在哪”这类问题应该很快结束。调用链、数据流、注册关系、接口实现、所有权可以继续跨模块追，追到证据够用为止。

安装后的 `cce-routing` Skill 会为陌生项目语义问题提供有边界的 CCE 路由指引，同时让已知文件读取、测试、日志、构建、Git 和外部文档继续使用原生工具。Grok Build 在插件启用后会加载同一套 plugin skill。Claude Code 还有一个很窄、失败开放的竞争检索路由保护；最终是否调用工具，仍由当前 AI 客户端的模型决定。

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

- `cursor_init` 为当前 AI 客户端上下文校验并持久化一个工作区；在 Agents Window 缺少该本地工作区时，通过 Cursor 的工作区服务添加，并在核验完整路径后报告就绪。再次执行即可切换项目；状态查询不会添加项目。
- 项目索引由 Cursor 自己负责。Bridge 只确保连接，并选择经过校验、与项目匹配的 CDP target。
- 多个 MCP adapter 共用一个用户级 lifecycle supervisor，并在读取状态或执行生命周期操作前重新同步持久运行模式。
- 冷启动时，Bridge 只启动带 CDP 的 Cursor 进程，不传项目路径或 `--new-window`；待 target 列表稳定后，再在 Agents v2 内绑定仓库。不会仅因某个临时 target 最先出现，就把它当作标准目标。
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
- 异步 `cursor_do(background=true)` 只返回精简提交回执。保存其中的 `task_id`，正常轮询时使用默认精简的 `cursor_status(task_id)`；任务进入终态后，调用 `cursor_status(task_id, detail="result")` 取得原始完整回复并记录收取。它没有 JSON 包装，必须先检查 `isError`，再把内容当作回复。只有还需要诊断任务详情时才使用 `detail="full"`。任务仍保留时，重复任一显式读取仍会返回同一结果。`cursor_do(background=false)` 是同步执行，仍直接返回完整结果正文。
- `cursor_task_control` 只返回动作和精简任务状态，不返回结果正文。恢复动作到达终态后，用 `cursor_status(task_id, detail="result")` 取得普通回复；诊断时使用 `detail="full"`。
- `session_mode=isolated` 仍是默认值。只有后续轮次必须保留同一 Cursor 上下文时才使用 `session_mode=create`，然后用返回的稳定 `session_id` 配合 `session_mode=continue` 继续。
- 每个续发轮次都会获得新的 `task_id`，并且必须再次声明 `read_only=true` 或 `allowed_paths` 子集。持续会话只使用 `parallel_agent`、同一时间只允许一个轮次，而且绝不降级到 FIFO。
- `cursor_status(session_id)` 查看持久关联。`cursor_session_control(action=close)` 只结束 Bridge 连续性，不会停止 Cursor；已关闭的映射可用 `action=forget, confirm=true` 删除。
- adapter 中断后，`cursor_session_control(action=reconcile)` 会两次核对精确 Agent，绝不重发；只有无法恢复停止证据时，才能显式确认风险后使用 `abandon`。
- reconcile 确认完成后，在续发前使用 `cursor_session_control(action=collect_result)` 补收该轮完整回复。它始终返回完整回复，会还原原选中 Agent，不发送提示、不持久化正文。epoch 变化会使收集无效；成功后重复调用返回 `already_collected`。数值回复签名和读取记录覆盖重启恢复，包括完成后首次读取前中断；没有保存签名的旧版续发轮需要人工检查。
- 最多保留 50 条任务记录。未读回复受到保护：达到限制后以 `TASK_RETENTION_FULL` 拒绝新提交，不会丢弃未读结果。对 `cursor_status().unreadResultTaskIds` 中每个 ID 调用 `cursor_status(task_id, detail="result")`；精简 status 不记录收取，任一显式 result 或 full 读取都会让相应记录允许淘汰。
- `timeout_ms` 是发送后由 FIFO 和自动恢复共用的监视预算。到期不会取消 Cursor；显式 `reap` 可以给予新的监视预算。
- 若 AI 客户端未提供工作区身份，Bridge 恢复共享 `default` 绑定后会以 `WORKSPACE_CONFIRMATION_REQUIRED` 阻止提交，直到 `cursor_init` 为当前 adapter 确认目标项目。按身份隔离的绑定仍保持原有重启行为。
- ready 会话的原子注册表位于用户配置目录，因此可跨 MCP 重启和插件缓存替换；不会持久化提示、回复、凭据、插件路径、脚本路径或 CDP target ID。
- `submitting`、`running`、`collecting` 都是正常非终态。
- Bridge 会确认 Cursor 是否接受提示。提示仍留在输入框时只尝试一次精确 Send 控件，仍失败则返回 `submit_not_accepted`，不会静默制造孤儿。
- provider-error 托盘会被保留为失败证据；Bridge 不会自动点击 Retry。
- 发送后状态不确定时保留占用，不会静默释放或重投。
- parallel Agents v2 任务会一直保留 provisional composer 身份，直到有证据对应到 durable History 行，再只迁移一次；其他并发提交不能在收敛期间替换这条任务的 `agentId`。
- `reap` 用于已绑定的并行孤儿。定向 `cancel` 需要精确的已发布 Agent ID。Agents Window 或 Workbench 上的 FIFO 若已发布 Agent ID，也走同一条定向停止。未发布时 Bridge 不会猜测点击 Stop；请先在 Cursor 确认已停止，再 `abandon`。
- 任务记录仍只存在于当前进程。MCP 重启后，开始重叠的独立工作前应检查 Agent History 与工作区变化；持续会话只有在 `cursor_status(session_id)` 仍报告 `ready` 且精确 Agent 绑定存在时才能继续。

内部身份、状态、恢复、范围与升级约束见 [Cursor Delivery Session Contract](./docs/CURSOR_SESSION_CONTRACT.md)。

</details>

<details>
<summary><strong>从源码运行与高级覆盖</strong></summary>

如果只是给其他支持 MCP 的 AI 客户端安装，优先使用 [AI 安装说明](./docs/ai-install.zh-CN.md)。下面的命令用于本地开发。

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
| `CURSOR_BRIDGE_SESSION_FILE` | 用户配置目录 | 覆盖持续交付会话注册表；不得指向版本化插件缓存。 |
| `CURSOR_BRIDGE_MODEL_PREFERENCES_FILE` | 用户配置目录 | 覆盖 CCE / `cursor_do` 持久模型与思考程度文件。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 设为 `off` 可禁用并隐藏 `cursor_do`。 |
| `CURSOR_PROJECT_PATH` | 未设置 | 仅在没有持久初始化时使用的兼容回退。 |
| `CURSOR_EXE` | 自动探测 | 便携/自定义可执行文件、Windows 安装目录或 macOS `.app` 覆盖。 |

高级 lifecycle 覆盖用于兼容诊断；Windows 上不建议绕过单例 supervisor。

</details>

## 友情链接

- [LINUX DO](https://linux.do)

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/main/assets/star-history.svg?v=5ad31826af84)](https://github.com/Vanyangyang/cursor-bridge)
