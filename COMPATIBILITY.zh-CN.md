# Cursor Bridge 兼容与更新历史

[English](./COMPATIBILITY.md) · [README](./README.zh-CN.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases)

> [!IMPORTANT]
> Cursor Bridge 只维护 Cursor 最新版本。只有在新的受维护 Cursor Bridge 版本取代当前版本后，当前版本才会进入历史列表。历史版本不再获得修复、兼容适配或支持。如果已列出的历史版本都不能满足您的需求，请 Fork 本仓库并在自己的 Fork 中维护适配。

本页面的机器可读数据源是 [`compatibility.json`](./compatibility.json)。

## 最新发布与上次完整验收基线

**主要维护路线：** 自 **7.0.0** 起，**CCE CLI (`cli`)** 成为主要维护路线与全新安装默认来源（已显式保存的 `cce-source.json` 会原样保留；此前未保存过 `cce-source.json` 的 6.x 升级会默认切换至 `cli`，需安装并登录 Cursor CLI 且显式配置 `cursor_model`，完整迁移与设置见 [`README.zh-CN.md#migrate-to-7-0`](./README.zh-CN.md#migrate-to-7-0)）；Cursor IDE/Agents (`ide`) 仍保留为持久后备选项（可通过 `/cce ide` 或 `cursor_cce(action="set", source="ide")` 切换）。

Cursor Bridge **7.0.0** 全面强化了 CCE CLI 的速度、可靠可用性与安装健壮性：默认私有隔离 MCP 配置、按 CLI 身份失效的预检缓存、持久化单根 ACP 会话（严格两步配置与 `mode="ask"` 读回校验 + 安全 `print` 回退）、独立 CLI 并发通道（`CURSOR_BRIDGE_CCE_CLI_CONCURRENCY=3`）、多路径启动器发现、`cursor_cce(action="doctor")` 只读自检、`cursor_init` 可恢复的 CLI 预检状态，以及全量 `npm test` / `smoke:cli` / `verify:install` 安装与验证链路加固（`CURSOR_EXE` 失配时严格 fail-closed 不再误拉起宿主 Cursor）。完整发布说明见 `CHANGELOG.md` 与 `compatibility.json`（`latestRelease`）；下表继续保留上一次完整 IDE CDP 兼容基线（`current: 6.0.8 / Cursor 3.23.12`）与历史归档列表。

| Cursor | Cursor Bridge | 来源 | 状态 |
|---|---|---|---|
| **3.23.12** | **6.0.8** | `cursor-bridge--v6.0.8` | 修复模型菜单固定等待 450ms 提前报错；仅操作唯一可写输入区及关联菜单，确认点击位置稳定且可命中；按钮明确保持关闭时允许一次核验后的恢复。Grok 4.7/high 验证及继承的验收边界见[补丁验收范围](./docs/cursor-6.0.8-model-picker-verification.md)。 |
| 3.23.12 | 6.0.7 | `cursor-bridge--v6.0.7` | 已归档。项目身份、折叠 History、精确取消、IDE 隐藏模型核验、双界面及生命周期验收；见[原验收范围](./docs/cursor-3.23.12-verification.md)。 |
| 3.21.16 | 6.0.6 | `cursor-bridge--v6.0.6` | 已归档。工作区确认、精确复用已有工作区与错绑拒绝；更完整验收继承自 6.0.4。 |
| 3.21.16 | 6.0.5 | `cursor-bridge--v6.0.5` | 已归档。模型提供方别名匹配及 `reasoning_effort` 核验。 |
| 3.21.16 | 6.0.4 | `cursor-bridge--v6.0.4` | 已归档。独立 Model/Effort 控件、同仓库多工作树、预览卡 dialog、隐藏模式模型核验、双 UI、并行 Agent、持续会话、minimal/normal 以及最后关闭单窗口恢复。 |
| 3.20.21 | 6.0.3 | `cursor-bridge--v6.0.3` | 已归档。最后关闭窗口类型恢复及双 UI 验收。 |
| 3.20.17 | 6.0.2 | `cursor-bridge--v6.0.2` | 已归档。Auto 菜单适配及独立 MCP 验收。 |
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

切换前请保存工作并完整退出正在使用插件的 AI 客户端。不会倒填 5.4.0 以前的版本。如果这个历史组合仍不能满足您的需求，请 Fork 本仓库并在自己的 Fork 中维护适配。
