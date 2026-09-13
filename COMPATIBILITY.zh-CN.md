# Cursor Bridge 兼容与更新历史

[English](./COMPATIBILITY.md) · [README](./README.zh-CN.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases)

> [!IMPORTANT]
> Cursor Bridge 只维护 Cursor 最新版本。只有在新的受维护 Cursor Bridge 版本取代当前版本后，当前版本才会进入历史列表。历史版本不再获得修复、兼容适配或支持。如果已列出的历史版本都不能满足您的需求，请 Fork 本仓库并在自己的 Fork 中维护适配。

本页面的机器可读数据源是 [`compatibility.json`](./compatibility.json)。

## 当前维护基线

| Cursor | Cursor Bridge | 来源 | 状态 |
|---|---|---|---|
| **3.20.17** | **6.0.2** | `main` | 当前维护版本。识别新版 Auto 菜单，并验证切回固定模型和 effort。6.0.2 构建的独立 MCP 已在真实 Cursor 上通过精确工作区绑定、CCE、只读 FIFO、Fable 5.1/high 校验和可重复结果收取。原生 6.0.1 init→CCE→do 已通过；原生 6.0.2 加载仍待验收。继承路径及未解决观察项见[验收范围](./docs/cursor-3.20.17-verification.md)。 |
| 3.19.19 | 6.0.1 | `cursor-bridge--v6.0.1` | 已归档。该标签之后曾完成本地独立 MCP 兼容性验收，当时未为兼容记录单独发版。 |
| 3.19.13 | 6.0.0 | `cursor-bridge--v6.0.0` | 已归档。默认精简状态与显式结果收取。 |
| 3.19.13 | 5.10.1 | `cursor-bridge--v5.10.1` | 已归档。工作区注册、FIFO 恢复与请求来源声明。 |
| 3.19.13 | 5.10.0 | `cursor-bridge--v5.10.0` | 归档。请求来源声明与精确工作区身份。 |
| 3.19.7 | 5.9.1 | `cursor-bridge--v5.9.1` | 归档。模型列表分类、精确 effort 与菜单关闭的适配器检查。 |
| 3.19.7 | 5.9.0 | `cursor-bridge--v5.9.0` | 归档。三轮真实只读持久会话、精确 Agent 身份、适配器重连、未读回复补收及幂等收集。 |

## 历史版本

### Cursor Bridge 5.8.2 — Cursor 3.19.7

状态：**已归档，不再维护。** 固定 Git ref：`cursor-bridge--v5.8.2`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.8.2
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.8.2 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.8.2
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.8.2
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.8.2 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.8.1 — Cursor 3.18.25

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.8.1`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.8.1
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.8.1 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.8.1
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.8.1
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.8.1 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.8.0 — Cursor 3.18.25

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.8.0`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.8.0
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.8.0 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.8.0
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.8.0
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.8.0 --trust
grok plugin enable cursor-bridge
```

### Cursor Bridge 5.7.1 — Cursor 3.18.9

状态：**已归档；不再维护。** 不可变 Git ref：`cursor-bridge--v5.7.1`。

#### Codex

```bash
codex plugin marketplace remove vanyangyang
codex plugin marketplace add Vanyangyang/cursor-bridge --ref cursor-bridge--v5.7.1
codex plugin add cursor-bridge@vanyangyang
```

#### Claude Code

```bash
git clone --depth 1 --branch cursor-bridge--v5.7.1 https://github.com/Vanyangyang/cursor-bridge.git cursor-bridge-5.7.1
claude plugin marketplace remove vanyangyang
claude plugin marketplace add ./cursor-bridge-5.7.1
claude plugin install cursor-bridge@vanyangyang
```

#### Grok Build

```bash
grok plugin install Vanyangyang/cursor-bridge@cursor-bridge--v5.7.1 --trust
grok plugin enable cursor-bridge
```

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
