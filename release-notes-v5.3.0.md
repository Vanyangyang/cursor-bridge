# Cursor Bridge v5.3.0

Compatible with **Cursor 3.16.17** and officially installable in **Grok Build**.

## Added

- Grok Build plugin support: `grok plugin install Vanyangyang/cursor-bridge --trust`, then `grok plugin enable cursor-bridge`. Reload with `/plugins` + `r` or a new session. Grok loads the same `cce-routing` and `cursor-delegate` skills.

## Fixed

- Cursor 3.16.17 Agents Window can bind the current repository from `.ui-sidebar-section-head` after the older `section.glass-sidebar-workspace-section-root` wrapper disappeared.
- If the Agents Window cannot bind that repository, CCE falls back to the workbench instead of failing closed.

## Compatibility

- Every current Cursor version still has two editors: workbench and Agents Window.
- Detection uses on-screen elements, not the Cursor version number.
- The workbench and the previous Agents Window sidebar remain supported.
- 3.16.17 Agents Window was live-tested on Windows 11.

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
