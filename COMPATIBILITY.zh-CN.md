# Cursor Bridge 兼容与更新历史

[English](./COMPATIBILITY.md) · [README](./README.zh-CN.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases)

> [!IMPORTANT]
> Cursor Bridge 只维护 Cursor 最新版本。只有在新的受维护 Cursor Bridge 版本取代当前版本后，当前版本才会进入历史列表。历史版本不再获得修复、兼容适配或支持。如果已列出的历史版本都不能满足您的需求，请 Fork 本仓库并在自己的 Fork 中维护适配。

本页面的机器可读数据源是 [`compatibility.json`](./compatibility.json)。

## 当前维护基线

| Cursor | Cursor Bridge | 来源 | 状态 |
|---|---|---|---|
| **3.17.19** | **5.5.0** | `master` | 当前维护版本。已通过 Windows 11 全新 Agents Window 启动，实机验证工作区绑定、CCE、FIFO、独立 parallel Agent、精确 Agent ID，以及 normal/minimal 切换期间的 CCE。本次全新启动没有暴露旧版 IDE/workbench CDP 目标，因此不对该界面作当前组合的验收声明。 |

## 历史版本

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
