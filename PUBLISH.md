# 发布到 npm（维护者）

包名 **`cursor-mcp-bridge`**（已存在，归 npm 账号 `flyingmoonc` / `2226062736@qq.com`）。
现行 CDP 版作为 **2.0.0**（旧 console 版是 1.x）发布，`npx -y cursor-mcp-bridge` 用户侧命令不变。

## 步骤

```bash
# 1) 登录 npm（账号需对 cursor-mcp-bridge 有发布权限）
npm login            # 在 Claude Code 里可用 ! npm login 交互登录

# 2) 确认登录身份
npm whoami           # 应为 flyingmoonc

# 3) 干跑：检查将打包进 tarball 的文件（应只有 server.mjs / launch-cursor.mjs / README.md / LICENSE / package.json）
npm publish --dry-run

# 4) 正式发布
npm publish
```

## 注意

- `package.json` 的 `files` 白名单只打包运行所需文件；`probe-*.mjs` / `test-*.mjs` / autopilot 等开发脚本留在仓库源码、不进 npm tarball。
- 每次发布前 **bump `version`**（npm 不允许重复版本号）：补丁 `npm version patch`、小版本 `minor`、大改 `major`。
- 发布后验证：`npx -y cursor-mcp-bridge@latest`（无 MCP 客户端时它会等待 stdio，Ctrl-C 退出即可，能启动即说明包可用）。

## 可选：直接从 GitHub 跑（免发布）

无需 npm registry 也能一键跑（较慢，每次拉取 clone+install）：

```json
{ "command": "npx", "args": ["-y", "github:Vanyangyang/cursor-bridge"] }
```
