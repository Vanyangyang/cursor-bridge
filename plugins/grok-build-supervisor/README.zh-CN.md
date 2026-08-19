# Grok Build Supervisor

[English](./README.md) · [仓库总览](../../README.zh-CN.md)

**让 Codex 或 Claude Code 通过 MCP 规划、监督、纠偏并验收持久运行的 Grok Build 任务。**

Grok Build Supervisor 是 Cursor Bridge + Grok Build Supervisor 仓库中可供 Codex 与 Claude Code 独立安装的插件。它可以在 Windows Terminal 中创建或恢复真实的 Grok Build TUI，通过用户级 daemon 跨宿主任务和插件重载持续持有 ACP 连接，并为宿主 Agent 提供进度、权限、澄清、取消和最终证据的有边界控制平面。

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

首次打开会话前，先初始化一次用户级代理设置：

```text
/grok_init
```

Supervisor 会先检查当前本地代理候选，必要时才执行有界的 loopback 监听端口扫描。只有端点完成 HTTP CONNECT 验证后才会持久化端口，不存在写死的默认端口。如果发现多个有效代理，需要明确选择一个：

```text
/grok_init http://127.0.0.1:<port>
```

配置保存在持久 Supervisor 状态目录，而不是插件缓存中。本地代理端口变化后重新运行 `/grok_init`。初始化不会创建 TUI 或发送 prompt；Supervisor 持有活动任务时会拒绝重初始化。

用自然语言创建受监督的可见 TUI：

```text
在当前项目创建一个 Grok TUI。
```

随后宿主 Agent 可以通过 ACP 发送已授权任务，并持续等待，直到 Grok 完成、失败、请求输入或提出精确的权限选择。

默认使用可见的 Windows Terminal TUI。只有用户明确要求 headless、不可见或仅 ACP 时，才允许 `presentation: none`；插件要求独立的 headless 确认值，也不会把它当作失败回退。

### 单任务执行模式

显式开启当前宿主任务内的执行模式：

```text
/grok_execute on
```

开启后，该宿主任务中的普通实现请求遵循以下分工：

- 宿主 Agent 负责规划、拆分、监督、纠偏和验收。
- Grok 负责实现、会改变状态的命令、构建和测试。
- 宿主 Agent 在接受完成前独立核查真实工作区证据。

显式关闭：

```text
/grok_execute off
```

只有精确的 `on` 与 `off` 形式会改变任务内状态。开启模式本身不会创建 TUI 或发送任务；关闭模式也不会自动取消正在运行的 Grok prompt 或停止已拥有的 Leader。

## 控制平面

```text
宿主任务
      │ 经过认证的本地 Named Pipe
      ▼
持久 Supervisor daemon
      ├─ 插件拥有的 Grok Leader
      ├─ 长连接 ACP 会话
      ├─ 有界事件日志
      └─ 经过验证的 Windows Terminal TUI 进程
```

- 单个宿主前端退出或插件更新时，daemon 仍可继续运行。
- 多个宿主任务可以观察同一会话；写租约和 fencing token 保证只有一个活动写入者。
- ACP 持续记录进度、完成、权限及澄清事件；宿主 Agent 在自己的回合内使用有界等待持续监督。
- 普通轮询会把例行事件合并到一个高水位游标，并在任务运行时抑制 Grok 的累计正文；原始消息块只会转成节流后的活动元数据写入持久日志，只有完成事件比调用方游标更新时才交付最终回答，因此推进游标后不会重复占用上下文。
- 超过 4000 UTF-8 字节的完成结果会原子写入持久 Supervisor 状态目录；宿主只接收路径、字节数、SHA-256、截断标记和短摘要，不再接收长正文。已安装 context-mode 时可以用它处理该文件，但插件不会打包或强制依赖 context-mode；没有安装时仍可使用有界本地读取。
- 每个 MCP 前端都会在经过认证的 daemon 请求信封中携带真实宿主身份，因此 Grok 看到的监督合同会按发送端显示为 Codex、Claude Code 或中性宿主 Agent。
- TUI launcher 文件在使用前会按内容写入持久 Supervisor runtime 目录；刷新插件缓存不会再删除 live daemon 随后需要执行的脚本。
- 更新时若旧 daemon 仍忙碌，新前端会保留安全的观察/控制，但拒绝新的初始化、会话打开或宿主身份错误的 prompt。正常退出可见 TUI 后重试，daemon 就会滚动升级。
- Windows Terminal 只是展示层；Leader 所有权、ACP、进程指纹和活动会话注册表才是权威层。

## 安全边界

- 不使用 `--yolo`、`--always-approve`，也不静默选择权限。
- 不模拟键盘输入，不接管或终止无关的 Grok 进程。
- 不静默回退到 headless；普通会话始终使用可见 Windows Terminal TUI。
- 不接受远程代理、不持久化代理凭据、不写死端口，也不把单纯 TCP 监听当作代理成功；初始化必须验证 loopback HTTP CONNECT。
- 不接受模型参数自报的宿主身份；daemon 只信任 MCP 前端附带的有界身份。
- PID 存活本身不是所有权证据；回滚必须匹配持久进程指纹。
- Grok 的完成文本只是 Agent 声明；宿主 Agent 必须核查文件、diff、测试及其他要求的证据。
- 插件不会扩大删除、发布、外部消息、秘密读取或产品决策的授权范围。

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
