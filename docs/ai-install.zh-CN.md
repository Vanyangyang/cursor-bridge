# Cursor Bridge AI 安装剧本

你正在把 Cursor Bridge 安装到**当前正在运行你的这个客户端**。先完整阅读本文和 [`ai-install.manifest.json`](./ai-install.manifest.json)，再按顺序执行。最后按[完成标准](#完成标准)逐项汇报。不要发明 marketplace 插件或额外安装器。只使用清单里的专用通用 npm 包。

[English](./ai-install.md) · [README](../README.zh-CN.md)

## 前置条件

- Cursor Bridge **只支持 Windows**。当前机器不是 Windows 时，停止并判定安装失败。
- `PATH` 上需要 Node.js 18+。
- 必须已经安装并登录 Cursor。
- 本剧本只给 **不是** Codex、Claude Code、Grok Build、Pi 的宿主使用。
- 只有用户明确要求时，才安装 Grok Build Supervisor。

## 1. 识别宿主

根据用户说明、可用 CLI 和已知配置目录判断当前客户端。

| 宿主 | 动作 |
|---|---|
| Codex、Claude Code、Grok Build 或 Pi | **停止本剧本。** 使用仓库根 README 里的一等安装命令。不要另克隆一份旁路仓库，也不要改写插件文件。 |
| 无法确定 | 只问一次当前是哪个客户端。没有答复时，按通用 MCP 宿主继续。 |
| 其他能跑 MCP 的客户端 | 继续。 |

通用安装不是一等宿主，也没有做过实机验收。

## 2. 安装专用 npm 包

使用专用的通用包装器，不要用 Pi 包装器：

- Cursor Bridge：`vanyangyang-cursor-bridge`
- Grok Build Supervisor：`vanyangyang-grok-build-supervisor`

这条路径不要安装 `pi-cursor-bridge` 或 `pi-grok-build-supervisor`。不要安装 npm 上已被占用的无关包名 `cursor-bridge-mcp`。不要发布 `cursor-bridge-workspace`，也不要恢复 `cursor-mcp-bridge`。

安装后需要有这些文件：

- `node_modules/vanyangyang-cursor-bridge/dist/cursor-bridge.mjs`
- `node_modules/vanyangyang-cursor-bridge/skills/cce-routing/SKILL.md`
- `node_modules/vanyangyang-cursor-bridge/skills/cursor-delegate/SKILL.md`

规则：

1. 仅当用户正在开发 Cursor Bridge 本身时，才复用当前工作区（`source: repo-workspace`）。
2. 否则把 [`ai-install.manifest.json`](./ai-install.manifest.json) 里钉死的包安装到 `%LOCALAPPDATA%\cursor-bridge\npm`。
3. 不要把本仓库加进用户项目当 submodule。
4. 使用清单里的精确版本。不要安装 `@latest`，也不要猜包名。

```powershell
$prefix = "$env:LOCALAPPDATA\cursor-bridge\npm"
npm install --prefix $prefix vanyangyang-cursor-bridge@0.1.0
```

如果用户要求安装 Grok Build Supervisor：

```powershell
npm install --prefix "$env:LOCALAPPDATA\cursor-bridge\npm" vanyangyang-grok-build-supervisor@0.1.0
```

记录 `source: npm:vanyangyang-cursor-bridge@0.1.0` 以及 bundle 的绝对路径：

`%LOCALAPPDATA%\cursor-bridge\npm\node_modules\vanyangyang-cursor-bridge\dist\cursor-bridge.mjs`

如果 `npm install` 返回 `E404` 或其他仓库错误，说明包可能还没发布。再 clone `%LOCALAPPDATA%\cursor-bridge\checkout` 作为后备，把 npm 错误记进 `blockers`，并设置 `source: git-checkout`。不要对私有根包使用 `npx`。

## 3. 注册 MCP 服务

把一个 stdio 服务合并进当前宿主的 MCP 设置。不要删除无关服务。`command` 使用 `"node"`，bundle 必须是 npm prefix 或 git 后备里的绝对路径。

npm 安装后的常见形状：

```json
{
  "mcpServers": {
    "cursor-bridge": {
      "command": "node",
      "args": ["C:\\Users\\<user>\\AppData\\Local\\cursor-bridge\\npm\\node_modules\\vanyangyang-cursor-bridge\\dist\\cursor-bridge.mjs"]
    }
  }
}
```

如果该宿主使用 VS Code / Copilot 的 `servers` 而不是 `mcpServers`，写成：

```json
{
  "servers": {
    "cursor-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\<user>\\AppData\\Local\\cursor-bridge\\npm\\node_modules\\vanyangyang-cursor-bridge\\dist\\cursor-bridge.mjs"]
    }
  }
}
```

从当前宿主自己的文档或已有配置里找出真实配置文件。不要发明新的配置格式。使用相对 bundle 路径视为安装失败。

如果用户要求安装 Grok Build Supervisor，再增加一个名为 `grok-build-supervisor` 的服务，指向同一 npm prefix 下的 `node_modules/vanyangyang-grok-build-supervisor/dist/grok-build-supervisor.mjs`，或 git 后备里的 `plugins/grok-build-supervisor/dist/grok-build-supervisor.mjs`。

## 4. 安装 Skill

把每个 Cursor Bridge Skill 目录**原样复制**。不要改写、摘要或打平 `SKILL.md`、`agents/`、`references/`。

必需的 Skill 目录，来自 npm 包或 git 检出：

- `skills/cce-routing`
- `skills/cursor-delegate`

只选一个 Skill 根目录：

1. 当前宿主文档写明的 Skill 目录。
2. 宿主或项目里已经在用的 Skill 根：`.agents/skills`、`.cursor/skills`、`.claude/skills`、`.codex/skills`、`.gemini/skills`、`.opencode/skills`、`.windsurf/skills`、`.roo/skills`，或用户主目录下对应的用户级目录。
3. 如果宿主会加载 `.agents/skills` 或 `~/.agents/skills`，则创建 `%USERPROFILE%\.agents\skills`。
4. 如果没有任何 Skill 约定，记录 `skills_unsupported`，只安装 MCP。

优先使用**用户级** Skill 根，避免把用户项目的 git 状态弄脏。只有宿主不加载用户级 Skill 时，才使用项目级目录。

复制后必须存在：

- `<skillsRoot>/cce-routing/SKILL.md`
- `<skillsRoot>/cursor-delegate/SKILL.md`
- `<skillsRoot>/cursor-delegate/references/delegation-contract.md`

这条路径不要复制 `hooks/`。Claude Code 的 hooks 属于 marketplace 插件。不要把 probes、测试或 session contract 文档装进宿主。

如果要安装 Grok Build Supervisor，用同样方式复制它的三个 Skill 目录。只有当前宿主已经会加载 command / prompt 目录时，才复制命令文件：npm 包装器用 `prompts/`，git 检出用 `plugins/grok-build-supervisor/commands/`。

## 5. 重载、初始化并核验

1. 重载或重启当前客户端的 MCP 与 Skill。已经打开的任务不会热加载新注册。
2. 确认 [`ai-install.manifest.json`](./ai-install.manifest.json) 里 `requiredTools` 列出的工具可见。
3. 对用户当前项目调用 `cursor_init`，参数必须是一个 Windows 绝对路径。
4. 调用 `cursor_status`，记下已绑定的工作区。

如果 `cursor_init` 返回 `close_cursor_and_retry`，请用户先保存工作、正常退出一次 Cursor，再重试。这是未完成安装，不是成功。

## 完成标准

每一项都要填写。只有全部必需要项为真时，才能写 `PASS`。

```text
## Cursor Bridge install report
- host: <客户端名称>
- path: first-class marketplace | generic-ai-install
- source: npm:vanyangyang-cursor-bridge@0.1.0 | git-checkout | repo-workspace
- checkout: <npm prefix、git 检出或仓库的绝对路径>
- mcpConfig: <配置文件绝对路径>
- mcpBundle: <dist/cursor-bridge.mjs 的绝对路径>
- mcpTools: <可见工具名，逗号分隔>
- skillsRoot: <绝对路径> | skills_unsupported
- skills: cce-routing=<ok|missing|unsupported> cursor-delegate=<ok|missing|unsupported>
- init: ready | failed | close_cursor_and_retry | skipped-first-class
- workspace: <绝对路径或 none>
- grok: skipped | installed | failed
- windowsOnly: acknowledged
- blockers: none | <简短列表>
- result: PASS | FAIL
```

### 通用路径判定 PASS 的必要条件

- 当前机器是 Windows。
- 宿主不是一等 marketplace 宿主，或用户明确要求绕过它。
- `source` 是 `npm:vanyangyang-cursor-bridge@<清单版本>`，或已记录 npm 失败并使用 `git-checkout` / `repo-workspace`。
- 该来源里存在 Cursor Bridge bundle。
- MCP 配置使用 `node` 加上 `dist/cursor-bridge.mjs` 的绝对路径。
- 重载后可以见到 `cursor_init`、`cursor_context_engine`、`cursor_status`、`cursor_model`。
- Skill 已原样复制，或已经用原因汇报 `skills_unsupported`。
- `cursor_init` 对目标工作区返回 `ready`；若结果是 `close_cursor_and_retry`，`result` 必须是 `FAIL`。
- 没有执行 npm publish、没有修改 ACL、没有批量结束 Node 或 PowerShell，也没有使用 Pi 包或发明额外产品名。

### 出现以下情况立即 FAIL

- 机器不是 Windows，却继续安装。
- 一等宿主走了本通用路径，且用户没有明确要求绕过 marketplace。
- MCP 使用了相对 bundle 路径，或对私有根包执行了 `npx`。
- 这条路径安装了 `pi-cursor-bridge`、`pi-grok-build-supervisor`，或无关的 `cursor-bridge-mcp`。
- Skill 文件被改写，而不是复制。
- 在非 Claude 宿主上安装了 Claude Code hooks。
- 报告声称这个通用宿主已经过实机验收。
- `result` 写成 `PASS`，但 `init` 不是 `ready`。

一等 marketplace 安装应汇报 `path: first-class marketplace`，通用字段使用 `skipped-first-class`，然后按根 README 核验：新建任务或重载插件，并且工作区初始化成功。
