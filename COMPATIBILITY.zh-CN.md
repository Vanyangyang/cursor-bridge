# Cursor Bridge 兼容与更新历史

[English](./COMPATIBILITY.md) · [README](./README.zh-CN.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases)

> [!IMPORTANT]
> Cursor Bridge 只维护 Cursor 最新版本。只有在新的受维护 Cursor Bridge 版本取代当前版本后，当前版本才会进入历史列表。历史版本不再获得修复、兼容适配或支持。如果已列出的历史版本都不能满足您的需求，请 Fork 本仓库并在自己的 Fork 中维护适配。

本页面的机器可读数据源是 [`compatibility.json`](./compatibility.json)。

## 当前维护基线

| Cursor | Cursor Bridge | 来源 | 状态 |
|---|---|---|---|
| **3.16.29** | **5.4.1** | `master` | 当前维护版本。Windows 11 IDE/workbench 已实机验证；Agents Window 实机验收仍未完成。 |

## 历史版本

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
