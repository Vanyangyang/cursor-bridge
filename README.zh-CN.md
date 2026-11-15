<p align="center">
  <a href="https://github.com/Vanyangyang/cursor-bridge/commits/main"><img alt="Long-term maintenance commitment" src="https://img.shields.io/badge/LONG--TERM_MAINTENANCE-COMMITTED-8B5CF6?style=for-the-badge&amp;logo=git&amp;logoColor=white" /></a>
  <a href="https://cursor.com/changelog"><img alt="Tracking the latest Cursor releases" src="https://img.shields.io/badge/CURSOR_RELEASES-STAYING_IN_SYNC-00C7B7?style=for-the-badge&amp;logo=cursor&amp;logoColor=white" /></a>
</p>

<p align="center"><sub><strong>兼容说明：</strong>Cursor Bridge 始终紧跟最新 Cursor 版本，历史兼容配对与归档见 <a href="./COMPATIBILITY.zh-CN.md">兼容与更新历史</a>。</sub></p>

# Cursor Bridge

[English](./README.md) · [Changelog](./CHANGELOG.md) · [兼容与更新历史](./COMPATIBILITY.zh-CN.md) · [AI 安装](./docs/ai-install.zh-CN.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases) · [Issues](https://github.com/Vanyangyang/cursor-bridge/issues)

[![Release](https://img.shields.io/github/v/release/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge/releases) [![Stars](https://img.shields.io/github/stars/Vanyangyang/cursor-bridge?style=flat-square&logo=github)](https://github.com/Vanyangyang/cursor-bridge) [![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![MCP](https://img.shields.io/badge/MCP-server-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/github/license/Vanyangyang/cursor-bridge?style=flat-square)](./LICENSE)

> [!WARNING]
> **Windows 为主验平台：** 完整实机验收当前以 **Windows** 为准。macOS / Linux 在 CI（`macos-basic`）覆盖了 CLI/ACP 单测与 stdio MCP 冒烟检查，尚未经过全量实机端到端验收。

Cursor Bridge 让你的编程客户端（**Codex**、**Claude Code**、**Grok Build**、**Pi**、**AGY / Antigravity** 或其他支持 MCP 的客户端）接入 **Cursor Context Engine（CCE）**，并可选交付有边界的 `cursor_do` 任务，仅返回可核对的 `path:line` 源码锚点（`CCE_SEARCH_RESULT`），不污染主上下文、不接管订阅或计费。

自 **7.0.0** 起，**CCE CLI（`cli`）正式升级为主要维护路线与全新安装默认来源**（已保存的 `cce-source.json` 原样保留，桌面端可通过 `/cce ide` 切回）。依托常驻 Ask 模式 ACP 会话池，Windows 下单条查询最快 **19.8s**（对比 6.2.0 基线 42.9–45.3s **提速约 2.2 倍**），3 路并发总墙钟 **30.4s**（串行总和 82.6s）。CLI 下载与设置详见[从 6.x 迁移到 7.0.0](#migrate-to-7-0)。

> [!IMPORTANT]
> **Windows 一次性迁移：** 如果当前安装的是 Cursor Bridge 5.3.6 或更早版本，首次升级到 5.4.0 或任何后续版本前，请先保存工作，并按[更新 Cursor Bridge](#windows-update-migration) 完成一次旧缓存进程清理。

## 为什么全面转向 CLI 版 CCE？

将 **CCE CLI（`cli`）** 确立为主路线完全基于**时间效率**考量：我们希望把工程精力集中于全面提升 CCE 语义检索的速度与稳定性体验，同时**逐步淡化其他边缘功能**——包括重型桌面 IDE/CDP 窗口耦合（`/cce ide` 仅保留为按需回退）、`cursor_do` 任务委派（可通过 `CURSOR_BRIDGE_DELEGATION=off` 隐藏关闭）以及进入低维护模式的配套插件。

促成这一决定的直接原因，是当下许多 Coding Agent（**尤其是 AGY / Antigravity**）在陌生代码库上的原生工具使用效率偏低：`read_file` 盲读命中率与定位正确率低、顺着引用连环猜文件，极易把主上下文迅速塞满并陷入“压缩失忆 → 重复重读”循环。以下为我们项目中的真实实测审计数据：

| 真实项目实测场景 | 原生 `read_file` 盲读 / 7.0.0 前耗时与上下文代价 | 接入 7.0.0 CCE CLI（`cli`）后 |
|---|---|---|
| **AGY 447 步真实编码会话审计**（19 个文件、`+328 / -70` 行改动） | 开局未做语义定位即盲读 **20+ 个无关外围文件**（第 59 步尚未改代码即触发首次压缩）；**67 次批量读取中 60 次（90%）** 超内联上限落盘，随后 **93 次 `read_file`** 将 **273 万 / 350.6 万总字符（约 78% 冗余读取）** 灌入窗口，触发 **5 次上下文压缩**，同一批 24–59 KB 核心文件被反复重读 **6–11 遍** | **1 次 `cursor_context_engine`** 仅返回约 **1–2 KB** 的可核验 `path:line` 锚点（`CCE_SEARCH_RESULT`），后续仅对命中的精确行段按需窄读 |
| **AGY 1 父 + 4 子会话盲测审计**与 **360+ 步零 CCE 会话** | 6.2.0 阶段前 3 轮因触发宿主 180s MCP 超时回退本地盲读，4 个子会话执行 **172 次 `read_file`（约 163 万字符）**、父会话执行 **134 次 `read_file`（约 114 万字符）**；磁盘读取仅耗 **14–17s**，但膨胀至 **25.4 万–26.3 万输入 tokens** 的长上下文使单子任务模型步耗达 **8.6–14.2 分钟**、单步最长卡顿 **220–265s**（另一场 360+ 步零 CCE 会话同样盲读膨胀超 **26 万 tokens**） | 20s 级 CLI 响应彻底避开宿主 180s MCP 超时门槛，从源头阻断顺着 `import` 无头苍蝇式跨文件盲读 |
| **Windows CCE CLI 端到端实测**（`grok-4.6-fast`、`medium` 思考程度） | 6.2.0 `--print` 每次承受 **~21s** 派发前 shell/MCP 固定开销（单查 **42.9–45.3s**；3 路串行总和 **82.6s**） | 常驻 Ask 模式 ACP + 私有 `CURSOR_DATA_DIR` 隔离 + 预检缓存将派发前开销压至 **0.0–0.2s**：单查最快 **19.8s（提速约 2.2 倍）**，3 路并发总墙钟 **30.4s（吞吐提升约 2.7 倍）** |

在 **AGY** 及同类 Agent 上配合使用 CCE CLI，可以用一次约 20 秒的独立语义检索替代数十次低命中率 `read_file` 盲猜与百万字符级上下文重装，在定位准确率、单轮响应速度与上下文洁净度上获得显著的体验跃升。

<a id="migrate-to-7-0"></a>

## Cursor CLI 安装与 6.x → 7.0.0 迁移

升级会原样保留已存在的 `%APPDATA%\cursor-bridge\cce-source.json`；未保存过时默认走 `cli`（只想保留桌面端或使用 `cursor_do` 可执行一次 `/cce ide` 持久化）。

1. **安装官方 CLI**：在新终端执行 `irm 'https://cursor.com/install?win32=true' | iex`（Windows PowerShell）或 `curl https://cursor.com/install -fsS | bash`（macOS/Linux），重开终端/客户端使 `PATH` 生效后确认 `cursor-agent --version`（自定义路径可设 `CURSOR_BRIDGE_CLI_PATH`）。
2. **登录并核验模型**：执行 `cursor-agent login`、`cursor-agent status`、`cursor-agent models`（无交互可设 `CURSOR_API_KEY`；自带 Key `agent-local` 见 [`docs/cce-cli-provider.md`](./docs/cce-cli-provider.md)）。
3. **设置具名模型、自检与绑定工作区**（拒绝 `Auto`/`default`）：调用 `cursor_model(action="set", target="cce", model="grok-4.6-fast", effort="medium")` → 执行 `/cce doctor`（`cursor_cce(action="doctor")`）→ 执行 `cursor_init(path="C:\\absolute\\path\\to\\project")`。

## 快速开始

### 1. 选择当前 AI 客户端并安装 Cursor Bridge

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
grok plugin install cursor-bridge@vanyangyang --trust
grok plugin enable cursor-bridge
```

#### Pi

```bash
pi install npm:pi-cursor-bridge
```

<a id="other-mcp-hosts"></a>

#### 其他支持 MCP 的 AI 客户端

把下面这段话直接发给你正在使用的 AI 客户端：

```text
请完整阅读 https://github.com/Vanyangyang/cursor-bridge/blob/main/docs/ai-install.zh-CN.md ，按其中步骤把 Cursor Bridge 安装到当前 AI 客户端，并按文末完成标准逐项汇报。只使用这份说明里指定的通用 npm 包。不要发明 marketplace 插件，不要借用 Pi 包，也不要发布任何包。
```

该说明会把主流客户端导向各自 marketplace 命令，并引导其他 MCP 客户端将 `vanyangyang-cursor-bridge` 安装到 `%LOCALAPPDATA%\cursor-bridge\npm`，登记、重启、初始化工作区都由当前 AI 客户端自己做（这不是我优先维护的安装方式，未做实机验收）。

### 2. 重启或重载当前 AI 客户端

Codex 请重启并新建任务；Claude Code 请重启或执行 `/reload-plugins`；Grok 请在 `/plugins` 中重载或新开会话；Pi 请重启；通用 MCP 客户端请重启当前客户端。

### 3. 设置明确模型、检查 CLI 就绪状态并初始化工作区

```text
把我的 CCE 默认模型设为 grok-4.6-fast、思考程度 medium，用 /cce doctor 检查 CLI 状态，并初始化 CCE 工作区为 C:\absolute\path\to\project
```

- **Pi** 会自动绑定启动目录；切换仓库时传入新绝对路径重新初始化即可。
- **若 `cursor_init` 返回 `ready: false`**（`cli-unavailable`、`cli-auth-required`、`cli-model-required` 附带 `availableModelsSample`、`cli-model-unavailable`、`cli-provider-unavailable`）：工作区绑定已持久化保存（`bindingPersisted: true`）并附有 `nextStep`，按指引完成登录或模型配置后重试即可（或执行 `/cce ide` 切回桌面端）。

### 4. 试一个真实项目问题

```text
这个状态由谁持有？从存档加载、运行时使用到保存写回的完整链路是什么？
```

> [!TIP]
> **Windows 11 推荐：极简模式**（使用 `ide` 或 `cursor_do` 时）：说“将 CCE 切换到极简模式”，Cursor 会在后台运行而隐藏顶层窗口；此时手动打开 Cursor 会复用该隐藏实例，需要界面时说“将 CCE 切换到普通模式”（Cursor 3.23.12 已验证；若聊天为 `Auto`，先在普通模式下改好具名模型与 effort）。

## 兼容性

优先适配与实机验收的客户端为 **Codex**、**Claude Code**、**Grok Build** 与 **Pi**；其他 MCP 客户端按 [`docs/ai-install.zh-CN.md`](./docs/ai-install.zh-CN.md) 自助接入。上一次完整桌面端 IDE CDP 验收基线为 **Windows 11 + Cursor 3.23.12**（**Grok 4.7/high**，覆盖 **IDE 与 Agents Window** 的 `minimal` 和 `normal` 模式），详情见[兼容与更新历史](./COMPATIBILITY.zh-CN.md)及[补丁验收范围](./docs/cursor-6.0.8-model-picker-verification.md)。

## CCE 来源与 MCP 工具

| 指令 / 工具调用 | 作用 |
|---|---|
| `/cce cli` · `cursor_cce(action="set", source="cli")` | 使用本机 Cursor Agent CLI（默认，支持 3 路并发、ACP 复用与 `--print` 回退）。 |
| `/cce ide` · `cursor_cce(action="set", source="ide")` | 切换为通过 CDP 连接桌面端 Cursor IDE/Agents（使用 `cursor_do` 时必需）。 |
| `/cce doctor` · `cursor_cce(action="doctor")` | 只读自检：启动器、登录/模型目录、`cursor_model`、preload、ACP 与工作区状态。 |
| `/cce` · `cursor_cce(action="show")` | 查看当前生效来源、配置文件路径与可选自带 Key `cli_provider`（见[`docs/cce-cli-provider.md`](./docs/cce-cli-provider.md)）。 |

| 工具 | 作用 |
|---|---|
| `cursor_init` | 保存工作区绑定并校验 CLI/模型就绪（`cli`）或 CDP 连接（`ide`）。 |
| `cursor_context_engine` | 通过自然语言 `query` 执行只读语义检索（支持 `workspace_path` 与 `request_context`）。 |
| `cursor_do` | 将有边界子任务交给 Cursor Agent 执行（设 `CURSOR_BRIDGE_DELEGATION=off` 时隐藏禁用，结果用 `cursor_status` 收取）。 |
| `cursor_model` | 独立查看、设置或重置 `cce`、`cursor_do`、`both` 的持久模型与思考程度。 |
| `cursor_cce` | `show`、`set`（切换 `cli` / `ide` 或配置 `cli_provider`）及只读 `doctor` 自检。 |
| `cursor_status` | 默认返回精简状态；用 `detail="result"` 或 `"full"` 读取任务输出与完整详情。 |
| `cursor_runtime` | 在桌面端 `normal` 与 `minimal` 模式间切换。 |
| `cursor_task_control` | 执行 `reap`、`cancel` 或显式确认风险的 `abandon`。 |

调用 `cursor_context_engine` / `cursor_do` 时建议传入 `workspace_path`（遇 `WORKSPACE_CONFIRMATION_REQUIRED` / `WORKSPACE_INITIALIZATION_REQUIRED` / `WORKSPACE_MISMATCH` 先确认空闲再跑 `cursor_init`）。Cursor 本身不是系统级沙箱，ACP 启用 Ask 只读约束后仍建议在本地核验关键引用。

<a id="windows-update-migration"></a>

## 更新 Cursor Bridge

```bash
# Codex（如提示未配置 marketplace，先执行一次 `codex plugin marketplace add Vanyangyang/cursor-bridge --ref main`）
codex plugin marketplace upgrade vanyangyang && codex plugin add cursor-bridge@vanyangyang

# Claude Code
claude plugin marketplace update vanyangyang && claude plugin update cursor-bridge@vanyangyang

# Grok Build
grok plugin marketplace update cursor-bridge && grok plugin update cursor-bridge

# Pi
pi update npm:pi-cursor-bridge
```

其他 MCP 客户端：请让 AI 按 [`docs/ai-install.zh-CN.md`](./docs/ai-install.zh-CN.md) 与 [`docs/ai-install.manifest.json`](./docs/ai-install.manifest.json) 升级 `vanyangyang-cursor-bridge`。更新后请新建 Codex 任务、重载 Claude Code（`/reload-plugins`）或 Grok（`/plugins`）、重启 Pi 或重启当前客户端。

<a id="one-time-windows-migration"></a>

### 从 Cursor Bridge 5.3.6 或更早版本进行一次性 Windows 迁移

仅首次从 **5.3.6 或更早版本**升级时需清理旧缓存进程（5.4.0 及以后版本由独立持久运行时托管，正常执行上方命令即可）。

**推荐把这句话交给本地 Coding Agent：**“我已保存工作。先核对已安装的 Cursor Bridge 版本。只有版本为 5.3.6 或更早时，才检查命令行从 AI 客户端带版本号的插件缓存加载 `cursor-lifecycle-supervisor.mjs` 或 `dist/cursor-bridge.mjs` 的进程。凡是位于 `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\` 下的实例，都是新版持久运行时，不要停止。核验准确的旧缓存路径和归属后，只停止这些旧缓存进程，无需再次询问；禁止批量结束 Node 或 PowerShell、修改 ACL、删除缓存或处理无关进程。旧 adapter 停止后，当前任务中的旧 Cursor Bridge MCP 可能断开，这是预期现象。随后使用当前 AI 客户端的正常 marketplace 命令把 Cursor Bridge 更新到最新版、重载 AI 客户端，并报告安装后的版本、marketplace 来源和仍存在的旧缓存进程。”

<details>
<summary><strong>CCE 返回格式与 IDE 生命周期约定</strong></summary>

- `cursor_context_engine` 返回紧凑的 `CCE_SEARCH_RESULT`（`intent`、`coverage`、`evidence` 精确 `path:line` 锚点、`gaps`、`confidence`）；内置 `cce-routing` Skill 负责把陌生项目理解交给 CCE，已知文件读取与构建测试仍走原生工具。
- 多客户端共享 `%LOCALAPPDATA%\cursor-bridge\lifecycle\runtime\`（详见 [`docs/CURSOR_SESSION_CONTRACT.md`](./docs/CURSOR_SESSION_CONTRACT.md)）；`ide` 模式优先复用对应仓库的 Agents Window（绝不落回 `Home`），缺少 `--remote-debugging-port` 时返回 `close_cursor_and_retry`，绝不强杀 Cursor。

</details>

<details>
<summary><strong>环境变量与开发校验命令</strong></summary>

```bash
npm run build           # 重新构建全部 5 个免依赖 ESM 产物
npm test                # 在隔离环境变量中运行全量单测（scripts/test.mjs 自动剥离宿主污染）
npm run smoke:mcp       # 真实 stdio MCP 协议与准入闸门冒烟测试
npm run smoke:cli       # 伪 CLI harness 端到端验证 init -> doctor -> cursor_model -> ACP 检索
npm run verify:install  # 核验 5 个产物、版本对齐、lifecycle 物化与暂存 npm/Pi 包
npm run verify          # 一键串联构建 + 单测 + 双冒烟 + 安装校验
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_BRIDGE_CLI_PATH` | 自动发现 | 显式指定 `cursor-agent` / `agent` 启动器绝对路径。 |
| `CURSOR_BRIDGE_CLI_INSPECT_TTL_MS` | `300000` | 官方 CLI 预检缓存 TTL（毫秒，`0` 关闭）。 |
| `CURSOR_BRIDGE_CCE_CLI_MCP` | 隔离（未设置） | 设为 `native` 关闭私有 `CURSOR_DATA_DIR` MCP 隔离。 |
| `CURSOR_BRIDGE_CCE_CLI_ACP` | `on` | 设为 `off` 关闭常驻 ACP 复用，全部走 `--print`。 |
| `CURSOR_BRIDGE_CCE_CLI_ACP_IDLE_MS` / `_MAX_AGE_MS` / `_FAIL_TTL_MS` | `900000` / `3600000` / `300000` | 常驻 ACP 空闲回收、最大存活与失败缓存 TTL（毫秒）。 |
| `CURSOR_BRIDGE_CCE_CLI_CONCURRENCY` | `3` | CLI CCE 并发槽位数（1–8）。 |
| `CURSOR_BRIDGE_DELEGATION` | `on` | 设为 `off` 禁用并隐藏 `cursor_do`。 |
| `CURSOR_BRIDGE_CDP_PORT` / `_TIMEOUT` / `_NO_AUTOLAUNCH` / `_RUNTIME_MODE` | `9223` / `300000` / 未设置 / `normal` | IDE 调试端口、超时（毫秒）、禁用预热（`1`）与初始窗口模式。 |
| `CURSOR_EXE` | 自动探测 | 覆盖 Cursor IDE 可执行路径（路径不存在时严格 fail-closed）。 |

</details>

<details>
<summary><strong>配套插件：Grok Build Supervisor（低维护模式）</strong></summary>

本仓库仍保留独立的 **Grok Build Supervisor**（`0.4.3`）插件并进入低维护（maintenance-only）状态，日常主线维护聚焦 Cursor Bridge 与 CCE CLI。配套文档：[中文](./plugins/grok-build-supervisor/README.zh-CN.md) · [English](./plugins/grok-build-supervisor/README.md)。

</details>

## 友情链接与许可

- [LINUX DO](https://linux.do) · [MIT License](./LICENSE)

[![Cursor Bridge Star History](https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/main/assets/star-history.svg?v=78d133dcb77a)](https://github.com/Vanyangyang/cursor-bridge)
