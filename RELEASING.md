# 发布新版本（维护者）

本仓库作为 **Claude Code 插件 + 自带 marketplace** 分发。用户经
`claude plugin marketplace add Vanyangyang/cursor-bridge` +
`claude plugin install cursor-bridge@vanyangyang` 安装，CC 后台 auto-update 会拉新版本。
（注意：marketplace 源格式用 `owner/repo`，**不是** `github:owner/repo`——后者被当前 CLI 拒绝。）

## 改了源码后的发布步骤

```bash
# 1) 重建零依赖单文件（插件实际运行的就是 dist/cursor-bridge.mjs）
npm install          # 装 sdk/ws + esbuild(devDep)
npm run build        # → dist/cursor-bridge.mjs

# 2) 同步三处版本号（保持一致）
#    - .claude-plugin/plugin.json        version
#    - .claude-plugin/marketplace.json   plugins[0].version
#    - package.json                      version

# 3) 结构自检
claude plugin validate .

# 4) 提交并打 tag（tag 校验 plugin.json 与 marketplace 条目一致）
git add -A && git commit -m "release: vX.Y.Z"
claude plugin tag .        # 生成 cursor-bridge--vX.Y.Z tag
git push && git push --tags
```

## 注意

- **`dist/cursor-bridge.mjs` 必须提交**：插件安装只是拉取仓库后直接 `node` 跑它，CC **不会**为插件自动 `npm install` 运行期 npm 依赖；所以依赖必须已打进单文件。
- `node_modules/` / `package-lock.json` 不提交（`.gitignore` 已排除），它们只是构建期用。
- 改了 `server.mjs` 或 `launch-cursor.mjs` 一定要重新 `npm run build`，否则 `dist/` 是旧的。
- 用户侧拿到更新：`/reload-plugins` 或重启 CC；也可 `claude plugin update cursor-bridge`。

## 本地验证（不污染正式配置可在测试目录做）

```bash
claude plugin marketplace add /abs/path/to/this/repo   # 本地路径也可当 marketplace
claude plugin install cursor-bridge@vanyangyang
# 验证后清理：
claude plugin uninstall cursor-bridge
claude plugin marketplace remove vanyangyang
```
