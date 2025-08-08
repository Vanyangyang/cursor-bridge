# 发布 cursor-mcp-bridge 到 npm 的步骤

## 📋 发布前检查清单

- [x] package.json 已配置正确
- [x] bin 文件已创建并设置权限
- [x] README.md 和 LICENSE 文件已创建
- [x] .npmignore 已配置
- [x] 本地测试通过

## 🚀 发布步骤

### 1. 登录 npm

```bash
cd mcp-server
npm login
```

输入您的 npm 账号信息：
- Username
- Password
- Email
- OTP (如果启用了双重认证)

### 2. 检查包名是否可用

```bash
npm view cursor-mcp-bridge
```

如果返回 404 错误，说明包名可用。

### 3. 发布包

```bash
npm publish
```

这会自动执行：
1. 运行 `prepublishOnly` 脚本（编译 TypeScript）
2. 打包并上传到 npm registry

### 4. 验证发布

发布成功后，您可以通过以下方式验证：

```bash
# 查看包信息
npm info cursor-mcp-bridge

# 测试 npx 命令
npx cursor-mcp-bridge --version
```

## 📝 发布后更新

如果需要更新包：

1. 修改代码
2. 更新版本号：
   ```bash
   npm version patch  # 1.0.0 -> 1.0.1
   # 或
   npm version minor  # 1.0.0 -> 1.1.0
   # 或
   npm version major  # 1.0.0 -> 2.0.0
   ```
3. 发布新版本：
   ```bash
   npm publish
   ```

## ⚠️ 注意事项

1. 确保您已经在 https://www.npmjs.com 注册账号
2. 如果是首次发布，可能需要验证邮箱
3. 包名必须是唯一的，如果 `cursor-mcp-bridge` 已被占用，需要修改包名
4. 发布后的包无法删除（只能在 24 小时内 unpublish）

## 🔒 安全建议

1. 启用 npm 双重认证（2FA）
2. 使用 `npm audit` 检查依赖安全性
3. 定期更新依赖包

## 🎉 发布成功后

恭喜！您的包已经可以通过以下方式使用：

```bash
# 直接运行
npx cursor-mcp-bridge

# 或安装后使用
npm install -g cursor-mcp-bridge
cursor-mcp-bridge
```

用户可以在 Claude Code 的 MCP 配置中添加：

**Windows:**
```json
{
  "mcpServers": {
    "cursor-project-advisor": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "cursor-mcp-bridge"]
    }
  }
}
```

**Mac/Linux:**
```json
{
  "mcpServers": {
    "cursor-project-advisor": {
      "command": "npx",
      "args": ["-y", "cursor-mcp-bridge"]
    }
  }
}
```