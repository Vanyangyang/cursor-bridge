# Cursor Bridge v5.3.0

Compatible with **Cursor 3.16.17** and earlier supported 3.x releases. Officially installable in **Grok Build**.

## Added

- Grok Build plugin support: `grok plugin install Vanyangyang/cursor-bridge --trust`, then `grok plugin enable cursor-bridge`. Reload with `/plugins` + `r` or a new session. Grok loads the same `cce-routing` and `cursor-delegate` skills.

## Fixed

- Cursor 3.16.17 Agents Window works with the current project again.
- If Agents Window is unavailable, CCE uses the workbench.

## Compatibility

Supported Cursor versions (Windows 11):

| Cursor | Status |
|---|---|
| **3.16.17** | Current. Workbench and Agents Window. Live-tested. |
| **3.7.42 – 3.16.16** | Still compatible. Workbench and Agents Window keep working. |
| **3.7.42** | Previous live-test baseline. Still supported. |

## Install

```bash
# Grok Build
grok plugin marketplace add Vanyangyang/cursor-bridge
grok plugin install Vanyangyang/cursor-bridge --trust
grok plugin enable cursor-bridge

# Claude Code
claude plugin marketplace add Vanyangyang/cursor-bridge
claude plugin install cursor-bridge@vanyangyang

# Codex
codex plugin marketplace add Vanyangyang/cursor-bridge --ref master
codex plugin add cursor-bridge@vanyangyang
```
