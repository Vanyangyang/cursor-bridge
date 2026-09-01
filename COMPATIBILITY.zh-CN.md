# Cursor Bridge 兼容与更新历史

[English](./COMPATIBILITY.md) · [README](./README.zh-CN.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases)

> [!IMPORTANT]
> Cursor Bridge 只维护 Cursor 最新版本。只有在新的受维护 Cursor Bridge 版本取代当前版本后，当前版本才会进入历史列表。历史版本不再获得修复、兼容适配或支持。如果已列出的历史版本都不能满足您的需求，请 Fork 本仓库并在自己的 Fork 中维护适配。

本页面的机器可读数据源是 [`compatibility.json`](./compatibility.json)。

## 5.8.0 发布候选

| Cursor | Cursor Bridge | 来源 | 状态 |
|---|---|---|---|
| **3.18.25** | **5.8.0** | `feature/cursor-do-session-continuity` | 发布候选。版本证据来自 `D:\\tool\\cursor\\Cursor.exe` 的 ProductVersion 与 FileVersion。测试从 Cursor 进程不存在、CDP `127.0.0.1:9223` 拒绝连接开始；`cursor_init` 选中该用户安装，通过 WMI 启动，并以 `plugin-cache-fallback` 进入未降级、持久的 `supervised` 生命周期，全程一个 Cursor Agents 窗口和一个 CDP page target。Grok 4.6/high 通过了带源码锚点的 CCE 查询，以及跨两个 Adapter 的持久 `cursor_do` create/continue；两轮保持同一 `sessionId` 与 `agentId`，turn 为 1、2，工作区未变化。`minimal` 保持连接，`normal` 恢复同一窗口。Cursor 3.18.25 的模型触发器只显示 `High Fast` 等思考程度文本，因此 5.8.0 改为以已验证的选中模型行报告 `effectiveModel`。 |

## 当前维护基线

| Cursor | Cursor Bridge | 来源 | 状态 |
|---|---|---|---|
| **3.18.9** | **5.7.1** | `master` | 当前维护版本。Windows 完整重启且 Cursor 关闭后，Bridge 识别 Codex AppContainer 的 `%LOCALAPPDATA%` 重定向，选择 `plugin-cache-fallback`，并启动一个持久 `supervised` Supervisor 和一个 Cursor Agents 窗口；全程只有一个 CDP page target，且没有降级。完整测试为 183/183。5.7.0 的 CCE、FIFO、独立 `parallel_agent`、稳定 Agent ID，以及 `minimal` / 恢复后的 `normal` 证据继续适用；本次纯生命周期补丁没有重新运行模型路径或模型/思考程度选择器。 |

## 历史版本

### Cursor Bridge 5.7.0 — Cursor 3.18.9

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.7.0`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.7.0
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.7.0 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.7.0
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.7.0
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.7.0 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.6.2 — Cursor 3.17.21

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.6.2`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.6.2
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.6.2 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.6.2
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.6.2
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.6.2 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.6.1 — Cursor 3.17.21

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.6.1`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.6.1
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.6.1 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.6.1
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.6.1
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.6.1 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.6.0 — Cursor 3.17.21

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.6.0`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.6.0
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.6.0 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.6.0
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.6.0
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.6.0 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.5.0 — Cursor 3.17.19

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.5.0`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.5.0
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.5.0 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.5.0
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.5.0
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.5.0 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.4.2 — Cursor 3.17.8

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.4.2`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.4.2
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.4.2 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.4.2
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.4.2
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.4.2 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.4.1 — Cursor 3.16.29

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.4.1`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.4.1
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.4.1 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.4.1
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.4.1
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.4.1 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.4.0 — Cursor 3.16.17

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.4.0`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.4.0
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.4.0 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.4.0
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.4.0
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.4.0 --trust
grok plugin enable cursor-bridge
```

切换前请保存工作并完整退出插件宿主。不会倒填 5.4.0 以前的版本。如果这个历史组合仍不能满足您的需求，请 Fork 本仓库并在自己的 Fork 中维护适配。
