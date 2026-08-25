# Cursor Bridge for Pi

Use Cursor's project index and Agent search from Pi, with compact `path:line` evidence and optional bounded Cursor task execution.

```powershell
pi install npm:pi-cursor-bridge
```

Restart Pi after installation. Initialize the current project by asking Pi to initialize Cursor Bridge for the absolute project path, then use it normally. The package includes the `cce-routing` and `cursor-delegate` Skills and registers the native Cursor Bridge MCP tools directly in Pi.

This Pi package embeds Cursor Bridge 5.4.2. Cursor must be installed and signed in. Current end-to-end compatibility claims remain scoped to the environments documented in the main repository.

Source and full documentation: https://github.com/Vanyangyang/cursor-bridge
