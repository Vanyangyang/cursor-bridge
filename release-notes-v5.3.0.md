# Cursor Bridge v5.3.0

Live-tested on **Cursor 3.16.17** and **3.7.42**. Officially installable in **Grok Build**.

## Added

- Grok Build plugin support: `grok plugin install Vanyangyang/cursor-bridge --trust`, then `grok plugin enable cursor-bridge`. Reload with `/plugins` + `r` or a new session. Grok loads the same `cce-routing` and `cursor-delegate` skills.

## Fixed

- Cursor 3.16.17 Agents Window works with the current project again.
- If Agents Window is unavailable, CCE uses the workbench.

## Compatibility

Supported Cursor versions (Windows 11):

| Cursor | Status |
|---|---|
| **3.16.17** | Live-tested. Workbench and Agents Window. |
| **3.7.42** | Live-tested. Workbench and Agents Window. |

Other Cursor versions have not been tested.

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
