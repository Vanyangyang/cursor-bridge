# Cursor Bridge compatibility and update history

[简体中文](./COMPATIBILITY.zh-CN.md) · [README](./README.md) · [Releases](https://github.com/Vanyangyang/cursor-bridge/releases)

> [!IMPORTANT]
> Cursor Bridge maintains only the latest Cursor release. A version enters the historical list only after a newer maintained Cursor Bridge version replaces it. Historical versions receive no fixes, compatibility work, or support. If no listed historical version meets your needs, fork the repository and maintain the adaptation in your own fork.

The machine-readable source for this page is [`compatibility.json`](./compatibility.json).

## Current maintained baseline

| Cursor | Cursor Bridge | Source | Status |
|---|---|---|---|
| **3.18.25** | **5.8.0** | `main` | Current maintained version. ProductVersion and FileVersion were read from `D:\\tool\\cursor\\Cursor.exe`. Starting with no Cursor process and CDP `127.0.0.1:9223` refusing connections, `cursor_init` selected that user install, launched it through WMI, and reached an undegraded persistent `supervised` lifecycle using `plugin-cache-fallback`, one Cursor Agents window, and one CDP page target. Grok 4.6/high passed a source-anchored CCE query and a two-adapter persistent `cursor_do` create/continue run with the same `sessionId` and `agentId`, turns 1 and 2, and no workspace change. `minimal` remained connected and `normal` restored the same window. Cursor 3.18.25 shows only effort text such as `High Fast` in the model trigger, so 5.8.0 reports the verified selected model row as `effectiveModel`. |

## Historical versions

### Cursor Bridge 5.7.1 — Cursor 3.18.9

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.7.1`.

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

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.7.0`.

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

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.6.2`.

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

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.6.1`.

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

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.6.0`.

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

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.5.0`.

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

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.4.2`.

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

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.4.1`.

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

Status: **Archived; no maintenance.** Immutable Git ref: `cursor-bridge--v5.4.0`.

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

Save your work and fully exit plugin hosts before switching. Versions earlier than 5.4.0 are intentionally not backfilled. If this archived pairing does not meet your needs, fork the repository and maintain the adaptation in your own fork.
