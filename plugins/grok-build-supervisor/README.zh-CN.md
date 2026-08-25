# Grok Build Supervisor

[English](./README.md) · [仓库总览](../../README.zh-CN.md)

**让 Codex、Claude Code 或 Pi 负责规划和把关，自动调度 Grok Build 执行任务、跟进过程并核验结果。**

Grok Build Supervisor 可以单独安装到 Codex、Claude Code 或 Pi。它会在 Windows Terminal 中打开或恢复真正的 Grok Build 窗口，并在后台保持连接；即使当前任务结束或插件重新加载，也能继续接上这个会话。负责监督的宿主可以给 Grok 派活、查看状态、处理问题和权限、取消任务，并核查最终结果。

> [!NOTE]
> 已在 Windows 11、Windows Terminal、PowerShell 和 Grok Build 1.0.10 上完成实机验证；npm 包的安装与 MCP 注册也已在 Pi 0.84.3 上验证。目前不声明其他操作系统已经通过端到端支持验收。

## 安装

前置条件：

- 支持插件的 Codex 或 Claude Code，或 Pi（已在 0.84.3 上验证）
- Node.js 20 或更高版本
- 已安装并登录的 Grok Build
- 带 PowerShell 配置的 Windows Terminal

Codex：

```powershell
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add grok-build-supervisor@vanyangyang
```

Claude Code：

```powershell
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install grok-build-supervisor@vanyangyang
```

Pi：

```powershell
pi install npm:pi-grok-build-supervisor
```

安装或更新后需要新建 Codex 任务，重启 Claude Code / 执行 `/reload-plugins`，或重启 Pi；Skill、提示模板和 slash command 不会热加载到已经打开的任务。Pi 包独立计版本，目前内置 Grok Build Supervisor 0.3.7。

安装 Grok Build Supervisor 不会安装或启动 Cursor Bridge。

## 更新

> [!WARNING]
> **从 Grok Build Supervisor 0.1.0 或更早版本首次升级到 0.2.0 或任何后续版本时，需要做一次 Windows 清理。** 旧插件进程可能仍占用带版本号的缓存目录，导致 Windows 无法替换它。这不是 ACL 权限问题，也不需要手工删除插件缓存。

> [!TIP]
> **推荐把这句话交给本地 Coding Agent：**“我已保存工作。请把已安装的 Grok Build Supervisor 升级到 marketplace 当前最新版。先核对当前版本；如果是 0.1.0 或更早版本，检查从旧插件缓存运行的 `server.mjs`、`supervisor-daemon.mjs`、`tui-host.mjs` 或 `Start-GrokTui.ps1`。核验归属和旧缓存路径后直接停止，无需再次询问；保留新版持久运行时和无关进程。禁止批量结束 Node 或 PowerShell、修改 ACL 或删除缓存。完成正常更新后，报告版本、marketplace 来源和仍存在的旧缓存进程。”

完成这次迁移后，daemon 和 TUI 都从用户级持久目录运行，0.2.0 及后续版本可直接使用正常更新命令：

```powershell
# Codex
codex plugin marketplace upgrade vanyangyang
codex plugin add grok-build-supervisor@vanyangyang

# Claude Code
claude plugin marketplace update vanyangyang
claude plugin update grok-build-supervisor@vanyangyang
```

如果 Codex 提示 `marketplace 'vanyangyang' is not configured as a Git marketplace`，先运行一次 `codex plugin marketplace add Vanyangyang/cursor-bridge --ref master`，再执行上面的更新命令。更新后仍需新建任务或重新加载插件，当前任务不会变成新版本。

## 使用

第一次使用插件时，先初始化一次本地代理：

```text
/grok_init
```

插件会先尝试电脑上已有的本地代理设置；都不能用时，才检查一小段本地监听端口。只有确认代理真的能转发 HTTPS 连接后才会保存，不能只因为端口开着就算成功，也没有写死的默认端口。如果找到多个能用的代理，需要你明确选一个：

```text
/grok_init http://127.0.0.1:<port>
```

代理选择保存在插件缓存之外，所以更新插件不会把它清掉。本地代理端口变化后重新运行 `/grok_init`。初始化不会打开 Grok、不会选择项目，也不会发送任务；Grok 正忙时，插件也不会中途更换代理。

进入要处理的项目后，开启 Grok 执行模式：

```text
/grok_execute on
```

此时 Codex、Claude Code 或 Pi 会把执行模式绑定到当前项目目录，并立即复用或启动该项目的可见 Grok 终端。开启模式不会发送开发任务。终端就绪后，像平常一样交代任务即可；宿主会发送你另行同意的任务，并持续查看状态，直到 Grok 完成、失败、提出问题或需要权限选择。你不需要管理 TUI、会话 ID 或进程。

如果项目里带有本地自动化配置，Grok 第一次打开时可能会在终端里询问你是否信任这个目录。Supervisor 会准确识别这个界面，保留当前终端和会话，并提醒你直接在 Grok 里确认；这时不要再次运行 `/grok_execute on`。插件不会替你按 `y`，也不会偷偷加上 `--trust`。你在 Grok 中作出选择后，启动流程会自动继续。

工作区绑定只对当前 Codex、Claude Code 或 Pi 任务有效。关闭模式会清除这个绑定，但不会关闭终端，也不会取消已经在执行的工作。

> [!TIP]
> `/grok_execute on` 默认会立即在 Windows Terminal 中显示 Grok。如果这次开启需要隐藏终端，请在运行 `on` 前先说“这次不要显示 Grok 终端”。没有你的明确要求，插件不会自己隐藏窗口；可见窗口启动失败时，也不会偷偷改成后台运行。

模式开启后：

- Codex、Claude Code 或 Pi 负责规划、拆分、看进度、纠偏和验收。
- Grok 负责实现、会改变状态的命令、构建和测试。
- Codex、Claude Code 或 Pi 在接受完成前，会独立检查真实文件和测试证据。

不再需要 Grok 执行模式时，关闭即可：

```text
/grok_execute off
```

只有精确的 `on` 与 `off` 形式会改变模式。关闭不会取消已经在运行的任务，插件仍会把当前任务安全监督到结束。

## 它如何保持连接

```text
Codex / Claude Code / Pi
        ↓
后台监督程序
        ↓
Grok Build + Windows Terminal 窗口
```

连接细节由插件自己处理。用户不需要管理底层 Leader、ACP 连接、进程号或事件游标。

- 关闭一个 Codex / Claude Code / Pi 任务或更新插件，不会立刻断开后台连接。
- 多个宿主可以查看同一个 Grok 会话，但同一时间只有一个能发送指令，避免两个 Agent 互相覆盖。
- Grok 工作时，查看进度只会拿到“正在定位、正在修改、正在验证”等简短阶段，以及有上限的文件和工具数量。Supervisor 自己的静默心跳不会冒充 Grok 有新进展，原始工具日志和已经累计的整段回答也不会被反复取回。
- 短答案只返回一次。长报告会保存成文件，插件只返回文件位置、大小、校验值、是否截断和短摘要。已经安装 [context-mode（推荐）](https://github.com/mksglu/context-mode) 时，可以用它提取重点；不安装也能正常使用。
- 插件会告诉 Grok 任务究竟来自 Codex、Claude Code、Pi 还是其他宿主，不会一律冒充 Codex。
- 正在运行的会话所需脚本会复制到持久目录，所以刷新插件缓存不会把脚本从它脚下删掉。
- 新版插件会等旧的后台监督程序空闲后再替换它，升级过程中不会主动打断现有任务。
- 复用或停止进程前，插件会同时核对会话、项目目录、进程身份、Grok 的活动记录和自己的启动记录；只有进程号相同远远不够。

## 安全规则

- 插件不会开启“全部自动批准”一类危险模式，也不会替你选择权限。
- 插件不会替你信任工作区；是否信任目录仍由你在 Grok 的原生界面中决定。
- 它不会模拟键盘输入，不会接管无关的 Grok 进程，也不会停止无法证明归它管理的进程。
- 除非你明确要求不显示窗口，否则它不会把终端偷偷藏起来。
- 它只接受真正能工作的本地代理，不保存代理密码，也不假定某个固定端口。
- Grok 不能自己声称任务来自哪个宿主；发送者身份由本地 MCP 连接提供。
- “Grok 说完成了”不等于已经验收。Codex、Claude Code 或 Pi 仍需核查文件、diff、测试和你要求的其他证据。
- 安装插件不会自动获得删除数据、发布代码、发送外部消息、读取秘密或决定产品方向的权限。

## 兼容性提示

部分 Grok 版本会输出：

```text
warning: --subagents has no effect in leader mode (agent config is set at leader startup)
```

插件既没有传递 `--subagents`，也没有传递 `--no-subagents`。提示来自 Grok 对 Leader 模式默认值的处理。插件不会过滤它，因为全屏 TUI 依赖原生终端句柄，拦截 stderr 可能导致渲染停滞；Leader 启动时的 Agent 配置仍是权威来源。

## 开发

在本插件目录执行：

```powershell
npm install
npm test
npm run smoke:mcp
```

虽然两个插件来自同一个仓库 marketplace，Grok Build Supervisor 仍然拥有独立的版本、测试和安装生命周期。
