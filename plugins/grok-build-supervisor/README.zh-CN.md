# Grok Build Supervisor

[English](./README.md) · [仓库总览](../../README.zh-CN.md)

**让 Codex 或 Claude Code 通过 MCP 规划、监督、纠偏并验收持久运行的 Grok Build 任务。**

Grok Build Supervisor 是一个可以单独安装到 Codex 或 Claude Code 的插件。它会在 Windows Terminal 中打开或恢复真正的 Grok Build 窗口，并在后台保持连接；即使当前任务结束或插件重新加载，也能继续接上这个会话。Codex 或 Claude Code 可以给 Grok 派活、查看状态、处理问题和权限、取消任务，并核查最终结果。

> [!NOTE]
> 已在 Windows 11、Windows Terminal、PowerShell 和 Grok Build 1.0.6 上完成实机验证。目前不声明其他操作系统已经通过端到端支持验收。

## 安装

前置条件：

- 支持插件的 Codex 或 Claude Code
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

安装或更新后需要新建 Codex 任务，或重启 Claude Code / 执行 `/reload-plugins`；Skill 和 slash command 不会热加载到已经打开的任务。

安装 Grok Build Supervisor 不会安装或启动 Cursor Bridge。

## 使用

第一次使用插件时，先初始化一次本地代理：

```text
/grok_init
```

插件会先尝试电脑上已有的本地代理设置；都不能用时，才检查一小段本地监听端口。只有确认代理真的能转发 HTTPS 连接后才会保存，不能只因为端口开着就算成功，也没有写死的默认端口。如果找到多个能用的代理，需要你明确选一个：

```text
/grok_init http://127.0.0.1:<port>
```

这个选择保存在插件缓存之外，所以更新插件不会把它清掉。本地代理端口变化后重新运行 `/grok_init`。初始化不会打开 Grok，也不会发送任务；Grok 正忙时，插件也不会中途更换代理。

开启 Grok 执行模式：

```text
/grok_execute on
```

然后像平常一样交代任务。Codex 或 Claude Code 会自行判断是复用当前 Grok 会话，还是为这个项目打开正确的会话；随后发送你已经同意的任务，并持续查看状态，直到 Grok 完成、失败、提出问题或需要权限选择。你不需要管理 TUI、会话 ID 或进程。

开启模式本身不会立即打开 Grok 或发送任务，它只是决定后续普通任务怎么执行。第一项确实需要 Grok 的任务到来时，插件会自动复用或打开会话。

> [!TIP]
> Grok 默认会显示在 Windows Terminal 窗口中。如果某次任务不想看到它，直接说“这次不要显示 Grok 终端”即可。没有你的明确要求，插件不会自己隐藏窗口；可见窗口启动失败时，也不会偷偷改成后台运行。

模式开启后：

- Codex 或 Claude Code 负责规划、拆分、看进度、纠偏和验收。
- Grok 负责实现、会改变状态的命令、构建和测试。
- Codex 或 Claude Code 在接受完成前，会独立检查真实文件和测试证据。

不再需要 Grok 执行模式时，关闭即可：

```text
/grok_execute off
```

只有精确的 `on` 与 `off` 形式会改变模式。关闭不会取消已经在运行的任务，插件仍会把当前任务安全监督到结束。

## 它如何保持连接

```text
Codex 或 Claude Code
        ↓
后台监督程序
        ↓
Grok Build + Windows Terminal 窗口
```

连接细节由插件自己处理。用户不需要管理底层 Leader、ACP 连接、进程号或事件游标。

- 关闭一个 Codex / Claude Code 任务或更新插件，不会立刻断开后台连接。
- 多个宿主可以查看同一个 Grok 会话，但同一时间只有一个能发送指令，避免两个 Agent 互相覆盖。
- Grok 工作时，查看进度只会拿到简短状态，不会反复拿回已经累计的整段回答。
- 短答案只返回一次。长报告会保存成文件，插件只返回文件位置、大小、校验值、是否截断和短摘要。已经安装 context-mode 时可以用它提取重点，但不是必需品。
- 插件会告诉 Grok 任务究竟来自 Codex、Claude Code 还是其他宿主，不会一律冒充 Codex。
- 正在运行的会话所需脚本会复制到持久目录，所以刷新插件缓存不会把脚本从它脚下删掉。
- 新版插件会等旧的后台监督程序空闲后再替换它，升级过程中不会主动打断现有任务。
- 复用或停止进程前，插件会同时核对会话、项目目录、进程身份、Grok 的活动记录和自己的启动记录；只有进程号相同远远不够。

## 安全规则

- 插件不会开启“全部自动批准”一类危险模式，也不会替你选择权限。
- 它不会模拟键盘输入，不会接管无关的 Grok 进程，也不会停止无法证明归它管理的进程。
- 除非你明确要求不显示窗口，否则它不会把终端偷偷藏起来。
- 它只接受真正能工作的本地代理，不保存代理密码，也不假定某个固定端口。
- Grok 不能自己声称任务来自哪个宿主；发送者身份由本地 MCP 连接提供。
- “Grok 说完成了”不等于已经验收。Codex 或 Claude Code 仍需核查文件、diff、测试和你要求的其他证据。
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
