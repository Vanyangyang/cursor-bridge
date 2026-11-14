<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/main"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center">如果 Cursor Bridge 对你有用，欢迎点个 GitHub Star。</p>

<p align="center"><sub><strong>兼容说明：</strong>Cursor Bridge 始终紧跟最新 Cursor 版本。如需适配历史 Cursor 版本，请查看 <a href="./COMPATIBILITY.zh-CN.md">兼容与更新历史</a> 切回对应归档版本；归档版本不再接收维护更新。</sub></p>

# Cursor Bridge

[English](./README.md) · [Changelog](./CHANGELOG.md) · [兼容与更新历史](./COMPATIBILITY.zh-CN.md) · [AI 安装](./docs/ai-install.zh-CN.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

> [!WARNING]
> **Windows 为主验平台：** Cursor Bridge 的完整实机验收当前以 **Windows** 为准。macOS / Linux 在 CI（`macos-basic`）中覆盖了 CLI/ACP 单元测试与 stdio MCP 冒烟检查，但尚未经过全量实机端到端验收。

Cursor Bridge 让你的编程客户端（**Codex**、**Claude Code**、**Grok Build**、**Pi** 或其他支持 MCP 的客户端）接入 **Cursor Context Engine（CCE）**，并可选地把有边界的子任务交给 `cursor_do` 执行，只返回可回到源码核对的 `path:line` 证据。

自 **Cursor Bridge 7.0.0** 起，**CCE CLI（`cli`）正式升级为主要维护路线与全新安装默认来源**。既有用户已显式保存在 `cce-source.json` 中的选择会原样保留；若本地尚无 `cce-source.json`（如从 6.0.x 升级或此前未执行过 `/cce`），升级后会默认切换至 `cli`。通过 CDP 连接桌面端 Cursor IDE/Agents（`ide`）仍保留为显式后备来源；完整迁移步骤见[从 6.x 迁移到 7.0.0](#migrate-to-7-0)。

> [!IMPORTANT]
> **Windows 一次性迁移：** 如果当前安装的是 Cursor Bridge 5.3.6 或更早版本，首次升级到 5.4.0 或任何后续版本前，请先保存工作，并按照[“更新已有安装”](#windows-update-migration)完成一次旧缓存进程清理。完成后，后续更新使用正常流程。

## 7.0.0 核心变化

- **CCE CLI 升级为主维护路线与默认来源（`cli`）：** 进行 CCE 检索不再需要先打开 Cursor 桌面端窗口；老版本升级若已有 `cce-source.json` 则原样保留，未保存过时默认使用 `cli`。
- **全链路 CLI 提速与隔离：**
  - **私有 MCP 配置隔离（`CURSOR_DATA_DIR` / `mcp-disabled.json`）：** 自动禁用 CCE CLI 子进程中的宿主/外部 MCP 服务等待与递归唤醒（设 `CURSOR_BRIDGE_CCE_CLI_MCP=native` 可关闭隔离）。
  - **官方 CLI 预检缓存（`CURSOR_BRIDGE_CLI_INSPECT_TTL_MS=300000`）：** 按启动器与身份指纹缓存并去重并发检查，身份/模型/来源变更或出错时自动失效。
  - **常驻单根 ACP 会话池（`cursor-cli-acp.mjs`）：** 复用持久化只读 Ask 模式 ACP 会话，每次发送前逐项回读验证精确模型/思考程度/`fast`/`mode="ask"`；冷启动或能力不兼容且未发出 `session/prompt` 前安全回退 `--print`。
  - **独立 CLI 并发通道（`CURSOR_BRIDGE_CCE_CLI_CONCURRENCY=3`）：** 默认支持 3 路 CLI CCE 并发检索，不再被 IDE FIFO UI 锁阻塞。
- **CLI 可靠诊断与可恢复初始化：**
  - `cursor_cce(action="doctor")` / `/cce doctor` 提供只读健康自检（启动器定位、登录/模型目录、`cursor_model` 校验、本地 provider 预加载脚本、ACP 状态与工作区校验）。
  - `cursor_init` 在 CLI 模式下会保存工作区绑定并在 CLI 未就绪时返回结构化可恢复状态（`cli-unavailable`、`cli-auth-required`、`cli-model-required` 附带 `availableModelsSample`、`cli-model-unavailable`、`cli-provider-unavailable`）与 `nextStep` 指引，不再直接抛晦涩报错。
- **验证与安装健壮性全面加固（`npm run verify`）：** 新增端到端 stdio CLI/ACP 冒烟测试（`npm run smoke:cli`）、全产物与发布包校验脚本（`npm run verify:install`），并修复测试环境显式指定缺失 `CURSOR_EXE` 时的误拉起问题（strict fail-closed，不再误拉宿主 `Cursor.exe`）。

<a id="migrate-to-7-0"></a>

## 从 6.x 迁移到 7.0.0（下载 Cursor CLI 与必选设置）

### 谁需要迁移？如何保留原有 IDE 路线？

- **全新安装或此前未保存过 `cce-source.json` 的 6.x 升级用户：** 从 7.0.0 起默认走 `cli`（Cursor Agent CLI），按下面 3 步安装并登录 Cursor CLI、设置具名模型即可；若暂时只想继续连接 Cursor 桌面端，只需执行一次 `/cce ide`（或调用 `cursor_cce(action="set", source="ide")`）把 `ide` 写入 `%APPDATA%\cursor-bridge\cce-source.json` 即可持久保留。
- **之前已通过 `/cce cli` 或 `/cce ide` 保存过 `%APPDATA%\cursor-bridge\cce-source.json` 的用户：** 升级 7.0.0 不会覆盖既有选择；若从早期 6.1/6.2 `cli` 升级，强烈建议用 `/cce doctor` 核对一次 CLI 启动器与模型状态。

### 第 1 步：下载并安装官方 Cursor CLI（`cursor-agent`）

在**新的终端窗口**中执行官方安装命令：

- **Windows PowerShell：**

```powershell
irm 'https://cursor.com/install?win32=true' | iex
```

- **macOS / Linux：**

```bash
curl https://cursor.com/install -fsS | bash
```

安装完成后**重开终端或重启 AI 客户端**使 `PATH` 生效，运行以下指令确认安装成功：

```powershell
cursor-agent --version
```

> 说明：Windows 官方 CLI 默认安装到 `%LOCALAPPDATA%\cursor-agent`。Cursor Bridge 会自动依次探测 `%LOCALAPPDATA%\cursor-agent`、`%USERPROFILE%\.local\bin`、`%APPDATA%\cursor-agent` 与 `PATH`；若放在自定义位置，可通过环境变量 `CURSOR_BRIDGE_CLI_PATH` 指定 `cursor-agent.ps1` / `.cmd` / `.exe` 的绝对路径。

### 第 2 步：登录 Cursor 账号并核验可用模型

```powershell
cursor-agent login
cursor-agent status
cursor-agent models
```

- 按浏览器/终端提示完成官方 Cursor 账号认证；若为无交互终端，可提前设置环境变量 `CURSOR_API_KEY`（无账号而用自带 API Key 跑实验性 `agent-local` 路线的说明见 [`docs/cce-cli-provider.md`](./docs/cce-cli-provider.md)）。
- 确认 `cursor-agent models` 能输出明确具名模型列表（如 `grok-4.6-medium-fast` 等）。

### 第 3 步：Cursor Bridge 必选设置（模型、Doctor 自检与工作区初始化）

1. **必须设置明确具名模型与思考程度（拒绝 `Auto` / `default`）：**
   让 AI 客户端调用一次 `cursor_model(action="set", target="cce", model="grok-4.6-fast", effort="medium")`（也可换成 `cursor-agent models` 中支持的其它具名模型与思考程度，持久化保存在 `%APPDATA%\cursor-bridge\model-preferences.json`，跨重启保留）。
2. **只读健康检查 `/cce doctor`：**
   运行 `/cce doctor` 或 `cursor_cce(action="doctor")`，确认启动器、登录/模型目录、`cursor_model` 精确匹配、preload 脚本与本地状态全部通过（`ready: true` / `status: "ready"`）。
3. **初始化当前项目工作区：**
   传入当前仓库绝对路径运行 `cursor_init(path="C:\\absolute\\path\\to\\project")`，保存工作区绑定并在后台预热 Ask 模式只读 ACP 会话。

> [!TIP]
> 仅需把 CCE 切回桌面端 Cursor IDE（`ide`），或者还要使用依赖桌面端 UI 的 `cursor_do` 委派能力时：可执行 `/cce ide`（`cursor_cce(action="set", source="ide")`）；CLI（`cli`）与 IDE（`ide`）共用同一份工作区绑定与 `cursor_model` 偏好，切换后立即保留并跨重启生效。

## CCE 是什么？

Cursor Context Engine（CCE）把 Cursor 的项目索引、语义检索、精确搜索、引用追踪和 Agent 探索通过 MCP 暴露出来。主 Agent 只需问一次真实项目问题，Bridge 只返回精简的 `path:line` 源码锚点（`CCE_SEARCH_RESULT`），区分已核验调用链、语义相关与证据缺口，不把海量过程噪音灌进主上下文。

CCE 与 `cursor_do` 支持可选的 `request_context`（如 `{"sender":"model","source":"mixed"}`）区分用户原始要求与模型补充。Cursor Bridge 不读取、不接管你的 Cursor 订阅或计费。

> [!NOTE]
> **历史 IDE/Agents 验收基线：** 上一次完整的 IDE CDP 实机验收为 **Windows 11 + Cursor 3.23.12**（**Grok 4.7/high**，覆盖 **IDE 与 Agents Window**，以及 `minimal` 和 `normal` 运行模式）。配对与证据边界见[兼容与更新历史](./COMPATIBILITY.zh-CN.md)和[补丁验收范围](./docs/cursor-6.0.8-model-picker-verification.md)。

## 快速开始

> [!IMPORTANT]
> **前置要求（默认 `cli` 路线）：** 如还未安装官方 Cursor CLI，请先在 PowerShell 运行 `irm 'https://cursor.com/install?win32=true' | iex` 并执行 `cursor-agent login`（详解见[从 6.x 迁移到 7.0.0](#migrate-to-7-0)）。如果暂不安装 CLI，可在装好插件后执行 `/cce ide` 持久化切回桌面端 IDE。

### 1. 选择当前 AI 客户端并安装 Cursor Bridge

按你当前正在对话的 AI 客户端选择对应命令：

#### Codex（推荐）

```bash
codex plugin marketplace add Vanyangyang/cursor-bridge --ref main
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge
```

（不先加市场也可以直接安装：`grok plugin install Vanyangyang/cursor-bridge --trust`。）

#### Pi

```bash
pi install npm:pi-cursor-bridge
```

<a id="other-mcp-hosts"></a>

#### 其他支持 MCP 的 AI 客户端

把这段话直接发给你正在使用的 AI 客户端：

```text
请完整阅读 https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.zh-CN.md ，按其中步骤把 Cursor Bridge 安装到当前 AI 客户端，并按文末完成标准逐项汇报。只使用这份说明里指定的通用 npm 包。不要发明 marketplace 插件，不要借用 Pi 包，也不要发布任何包。
```

说明会让当前 AI 自动识别客户端：Codex / Claude Code / Grok / Pi 仍走各自一等 marketplace 命令；其他支持 MCP 的客户端会将 `vanyangyang-cursor-bridge` 安装到 `%LOCALAPPDATA%\cursor-bridge\npm`，登记、重启、初始化工作区都由当前 AI 客户端自己做。这不是我优先维护的安装方式，也未做过实机验收。

### 2. 重启或重载当前 AI 客户端

Codex 请重启并新建任务；Claude Code 请重启或执行 `/reload-plugins`；Grok 请在 `/plugins` 中重载或新开会话；Pi 请重启；通用 MCP 客户端请重启当前客户端。已打开的任务不会热加载新安装的 MCP 工具与 Skill。

### 3. 设置明确模型、检查 CLI 就绪状态并初始化工作区

账号 CLI 模式要求明确指定模型名与思考程度（拒绝 `Auto` 或 `default`，绝不静默回退）：

```text
把我的 CCE 默认模型设为 grok-4.6-fast、思考程度 medium，用 /cce doctor 检查 CLI 状态，并初始化 CCE 工作区为 C:\absolute\path\to\project
```

- **Pi** 会自动绑定启动所在目录；需要切换仓库时直接传入新的绝对路径再次初始化即可。
- **若 `cursor_init` 返回 `ready: false`（`cli-unavailable`、`cli-auth-required`、`cli-model-required`、`cli-model-unavailable` 或 `cli-provider-unavailable`）：** 工作区绑定仍已持久化保存（`bindingPersisted: true`），响应中会附上 `errorCode`、可用模型示例（`availableModelsSample`）和可执行的 `nextStep`。按提示完成登录后或配置 `cursor_model`，再次 `cursor_init` 或 `/cce doctor` 即可；如需使用桌面端，执行 `/cce ide`。

### 4. 试一个真实项目问题

```text
这个状态由谁持有？从存档加载、运行时使用到保存写回的完整链路是什么？
```

> [!TIP]
> **Windows 11 推荐：极简模式（使用 IDE/Agents 或 `cursor_do` 时）**
>
> 在 `ide` 模式或使用 `cursor_do` 时，说“将 CCE 切换到极简模式”，真实 Cursor、项目索引、Agent DOM 和任务队列会在后台持续运行，顶层窗口保持隐藏。Cursor 3.23.12 的隐藏 CCE 已在双 UI 验证；隐藏模式核验当前模型与 effort（如需修改或聊天处于 `Auto`，请先切回普通模式）。
>
> **代价：** 极简模式期间，手动打开 Cursor 会复用受守卫的单实例并继续隐藏；需要桌面界面时说“将 CCE 切换到普通模式”。

## 兼容性

当前兼容配对、实机验收范围和历史归档见[兼容与更新历史](./COMPATIBILITY.zh-CN.md)和[最新发布](https://github.com/Vanyangyang/cursor-bridge/releases)。

官方优先适配与验收的客户端为 **Codex**、**Claude Code**、**Grok Build** 和 **Pi**；其他支持 MCP 的客户端可按 [`docs/ai-install.zh-CN.md`](./docs/ai-install.zh-CN.md) 自助接入。

## 切换与诊断 CCE 来源

全新安装默认选择 **`cli`**（Cursor Agent CLI）。升级保留已保存的 `cce-source.json`；两种来源各自严格 fails closed，任何失败都不做跨源静默回退。

| 指令 / 工具调用 | 作用 |
|---|---|
| `/cce cli` · `cursor_cce(action="set", source="cli")` | 使用本机 Cursor Agent CLI（全新安装默认）。 |
| `/cce ide` · `cursor_cce(action="set", source="ide")` | 切换为通过 CDP 连接桌面端 Cursor IDE/Agents。 |
| `/cce doctor` · `cursor_cce(action="doctor")` | 只读诊断：核验 CLI 启动器、登录/模型目录、`cursor_model`、preload、ACP 与工作区状态。 |
| `/cce` · `cursor_cce(action="show")` | 查看当前生效来源、配置文件路径与本地 `cli_provider` 摘要。 |

宿主支持插件命名空间（如 `/cursor-bridge:cce doctor`），内置 `cce` Skill 也支持自然语言指令：

- **账号 CLI（`cli` 默认）：** 调用已登录的 `cursor-agent` / `agent`（只读 Ask 模式）。单根工作区通过持久化 ACP 会话并经两步参数化配置回读校验运行；冷启动、能力不匹配、`CURSOR_BRIDGE_CCE_CLI_ACP=off` 与多根 `.code-workspace` 使用 `--print`。默认 3 路并发（`CURSOR_BRIDGE_CCE_CLI_CONCURRENCY`），不占用 IDE UI 锁。
- **自带 Key CLI（`agent-local`）：** 通过 `cursor_cce(action="set", source="cli", cli_provider={kind:"openai-responses", node_path, entrypoint, base_url, api_key_file})` 配置。使用官方 `agent-local` 构建与随包预加载脚本（调度前校验存在性），密钥仅从本地文件读取，严禁把 Key 写入对话或 MCP 参数。切换 `/cce ide` 与 `/cce cli` 会保留 `cli_provider`（传 `cli_provider=null` 清除）。详见 [`docs/cce-cli-provider.md`](./docs/cce-cli-provider.md)。
- **Cursor IDE / Agents（`ide`）：** 需要 Cursor 桌面端（Windows 11 可配合 `minimal` 模式）；需要执行代码修改委派工具 `cursor_do` 时也依赖桌面端（`CURSOR_BRIDGE_DELEGATION=on`）。

## MCP 工具一览

| 工具 | 作用 |
|---|---|
| `cursor_init` | 保存工作区绑定并校验 CLI/模型就绪（`cli`）或 CDP 连接（`ide`）；CLI 未就绪时返回可恢复诊断信息。 |
| `cursor_context_engine` | 通过自然语言 `query` 执行只读项目语义检索，支持 `workspace_path` 断言。 |
| `cursor_do` | 将明确边界的子任务交给 Cursor Agent 执行（设为 `CURSOR_BRIDGE_DELEGATION=off` 时隐藏禁用）；异步模式用 `cursor_status(task_id, detail="result")` 收取正文。 |
| `cursor_model` | 查看、设置或重置 `cce`、`cursor_do` 或 `both` 的持久模型与思考程度默认值。 |
| `cursor_cce` | `show`、`set`（切换 `cli` / `ide` 或配置 `cli_provider`）以及只读 `doctor` 自检。 |
| `cursor_status` | 默认返回精简状态，展示 CLI 元数据/并发或 CDP 连接、工作区绑定、模型配置与任务状态。 |
| `cursor_runtime` | 在桌面端可见 `normal` 与 Windows 11 隐藏 `minimal` 模式间切换。 |
| `cursor_task_control` | 精确执行 `reap`、`cancel` 或显式确认风险的 `abandon`。 |

当客户端明确知道当前项目目录时，调用 `cursor_context_engine` 与 `cursor_do` 应传入 `workspace_path`。收到 `WORKSPACE_CONFIRMATION_REQUIRED`、`WORKSPACE_INITIALIZATION_REQUIRED` 或 `WORKSPACE_MISMATCH` 时，核对 `cursor_status` 空闲后，先对目标路径执行 `cursor_init` 确认就绪，再重试一次。

> [!WARNING]
> Cursor 是 Agent，不是操作系统级沙箱；CCE 在 ACP 下启用 Ask 只读模式并强提示只读约束，关键引用和改动仍需在本地核验。

## 可靠性验证与构建流水线

修改源码后或验收安装健壮性时可执行：

```bash
npm run build           # 重新构建全部 5 个免依赖 ESM 产物
npm test                # 在隔离环境变量中运行全量单元测试（scripts/test.mjs 自动剥离宿主污染）
npm run smoke:mcp       # 真实 stdio MCP 协议与准入闸门冒烟测试
npm run smoke:cli       # 使用隔离伪 CLI harness 端到端验证 init -> doctor -> cursor_model -> ACP 检索
npm run verify:install  # 核验 5 个产物、全清单版本对齐、lifecycle supervisor 物化与暂存包冒烟
npm run verify          # 一键串联执行完整构建 + 全量测试 + 双冒烟 + 安装校验
```

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

其他支持 MCP 的 AI 客户端：让当前 AI 重新阅读 [AI 安装说明](./docs/ai-install.zh-CN.md)，按 [`docs/ai-install.manifest.json`](./docs/ai-install.manifest.json) 中的版本升级 `vanyangyang-cursor-bridge`，然后重启客户端。

更新后请新建 Codex 任务；重启 Claude Code 或执行 `/reload-plugins`；在 Grok `/plugins` 中重载或新开会话；重启 Pi；或重启当前 AI 客户端。

> [!NOTE]
> **从 6.x 升级到 7.0.0 时：** 若本地此前从未写入 `%APPDATA%\cursor-bridge\cce-source.json`，升级后将自动启用默认 `cli` 路线。请按[从 6.x 迁移到 7.0.0](#migrate-to-7-0) 下载并登录 Cursor CLI、配置具名 `cursor_model` 后执行 `/cce doctor`；若想保留桌面端 `ide`，执行一次 `/cce ide` 即可持久化。

如果 Codex 提示 `marketplace 'vanyangyang' is not configured as a Git marketplace`，先运行一次 `codex plugin marketplace add Vanyangyang/cursor-bridge --ref main`，再重试 Codex 命令。

<a id="one-time-windows-migration"></a>

### 从 Cursor Bridge 5.3.6 或更早版本进行一次性 Windows 迁移

> [!WARNING]
> **只有首次从 Cursor Bridge 5.3.6 或更早版本升级时才需要这次 Windows 清理。** 旧插件进程可能占用带版本号的缓存目录，阻止系统替换它。不要修改 ACL，也不要删除插件缓存。

> [!TIP]
> **推荐把这句话交给本地 Coding Agent：**“我已保存工作。先核对已安装的 Cursor Bridge 版本。只有版本为 5.3.6 或更早时，才检查命令行从 AI 客户端带版本号的插件缓存加载 `cursor-lifecycle-supervisor.mjs` 或 `dist/cursor-bridge.mjs` 的进程。凡是位于 `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` 下的实例，都是新版持久运行时，不要停止。核验准确的旧缓存路径和归属后，只停止这些旧缓存进程，无需再次询问；禁止批量结束 Node 或 PowerShell、修改 ACL、删除缓存或处理无关进程。旧 adapter 停止后，当前任务中的旧 Cursor Bridge MCP 可能断开，这是预期现象。随后使用当前 AI 客户端的正常 marketplace 命令把 Cursor Bridge 更新到最新版、重载 AI 客户端，并报告安装后的版本、marketplace 来源和仍存在的旧缓存进程。”

完成这次一次性迁移后，后续更新不再需要特殊进程清理。

<details>
<summary><strong>CCE 如何搜索，以及返回什么证据</strong></summary>

`query` 传入一个聚焦的自然语言项目问题；`workspace_path` 用于在准入阶段断言目标项目。

```text
CCE_SEARCH_RESULT
intent: <标准化意图>
coverage: <focused|extended> | <为什么当前深度已经足够>
evidence:
- path/to/file.ts:42-67 | symbolOrAnchor | 已核验的相关性或关系 | reference
gaps: none
confidence: high
```

内置 `cce-routing` Skill 引导将陌生项目理解交由 CCE 处理，同时让已知文件读取、构建、测试、日志与 Git 操作继续使用原生工具。

</details>

<details>
<summary><strong>工作区、Cursor UI 与 IDE 生命周期（`ide` / `cursor_do`）</strong></summary>

- 多个 MCP adapter 共用一个物化到 `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` 的用户级 lifecycle supervisor，与版本化插件缓存解耦。
- `ide` 模式或 `cursor_do` 下优先复用对应仓库的 Agents Window，其次 workbench，绝不落回 `Home`。
- 若检测到 Cursor 已运行但未开启 `--remote-debugging-port`，`cursor_init` 保留绑定并返回 `close_cursor_and_retry`，绝不强杀进程。
- 完整会话状态机与恢复契约见 [`docs/CURSOR_SESSION_CONTRACT.md`](./docs/CURSOR_SESSION_CONTRACT.md)。

</details>

<details>
<summary><strong>环境变量与高级覆盖</strong></summary>

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_CLI_PATH` | 自动发现 | 显式指定 `cursor-agent` / `agent` 启动器绝对路径。 |
| `CURSOR_BRIDGE_CLI_INSPECT_TTL_MS` | `300000` | 官方 CLI 预检缓存 TTL（毫秒，`0` 关闭缓存）。 |
| `CURSOR_BRIDGE_CCE_CLI_MCP` | 未设置（`isolated`） | 设为 `native` 可停用私有 `CURSOR_DATA_DIR` MCP 隔离。 |
| `CURSOR_BRIDGE_CCE_CLI_ACP` | `on` | 设为 `off` 关闭常驻 ACP 复用，全部走一次性 `--print`。 |
| `CURSOR_BRIDGE_CCE_CLI_ACP_IDLE_MS` | `900000` | 常驻 ACP 空闲回收超时（毫秒）。 |
| `CURSOR_BRIDGE_CCE_CLI_ACP_MAX_AGE_MS` | `3600000` | 常驻 ACP 最大存活寿命（毫秒）。 |
| `CURSOR_BRIDGE_CCE_CLI_ACP_FAIL_TTL_MS` | `300000` | 单个 CLI 身份的 ACP 能力失败缓存 TTL（毫秒）。 |
| `CURSOR_BRIDGE_CCE_CLI_CONCURRENCY` | `3` | 独立 CLI CCE 通道并发槽位数（`1`–`8`）。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 设为 `off` 时禁用并隐藏 `cursor_do`。 |
| `CURSOR_BRIDGE_CDP_PORT` | `9223` | Cursor IDE 远程调试端口（`ide` / `cursor_do`）。 |
| `CURSOR_BRIDGE_TIMEOUT` | `300000` | 单次检索超时（毫秒）。 |
| `CURSOR_BRIDGE_NO_AUTOLAUNCH` | 未设置 | 设为 `1` 关闭 IDE 启动预热。 |
| `CURSOR_BRIDGE_RUNTIME_MODE` | `normal` | 初始 IDE 窗口模式（`normal` / `minimal`）。 |
| `CURSOR_EXE` | 自动探测 | 覆盖 Cursor IDE 可执行路径（显式指向不存在路径时严格 fail-closed）。 |

</details>

<details>
<summary><strong>配套插件：Grok Build Supervisor（低维护模式）</strong></summary>

本仓库仍保留独立的 **Grok Build Supervisor**（`0.4.3`）插件并进入低维护（maintenance-only）状态；现有发布包（`grok-build-supervisor`、`pi-grok-build-supervisor`、`vanyangyang-grok-build-supervisor`）与兼容行为维持不变，日常主线维护聚焦 Cursor Bridge 与 CCE CLI。

既有使用者仍可查阅配套文档：[中文](./plugins/grok-build-supervisor/README.zh-CN.md) · [English](./plugins/grok-build-supervisor/README.md)。

</details>

## 友情链接

- [LINUX DO](https://linux.do)

## License

[MIT](./LICENSE)

## Star History

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/main/assets/star-history.svg?v=78d133dcb77a)](https://github.com/Vanyangyang/cursor-bridge)
