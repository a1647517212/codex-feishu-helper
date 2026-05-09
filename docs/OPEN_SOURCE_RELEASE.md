# 开源发布检查清单

本项目准备开源时，按下面清单检查。

当前状态：2026-05-08 已按本清单复核并推送到 GitHub `main`。后续每次发布前仍需重新执行验证命令。

## 敏感信息

- [x] 仓库中没有真实 `App Secret`。
- [x] 仓库中没有真实 `adminToken`。
- [x] 仓库中没有真实 `tenant_access_token`。
- [x] 仓库中没有个人数据库和日志。
- [x] `.env`、`.env.*`、`.feishu-codex/`、`dist/`、`node_modules/` 已被忽略。

推荐扫描：

```powershell
rg -n -e "cli_[A-Za-z0-9]+" -e "App Secret" -e "appSecret" -e "app_secret" -e "tenant_access_token" -e "Bearer " -e "password" -e "secret" -S .
```

扫描结果中允许出现：

- 示例占位符。
- 测试假 token。
- 源码里的字段名。

## 文档

- [x] README 是中文主入口。
- [x] README 有最小启动步骤。
- [x] README 说明默认不需要公网 IP。
- [x] README 说明默认权限风险：`danger-full-access` 和 `approvalPolicy=never`。
- [x] README 明确默认一任务一独立群模式需要 `im:chat`、`im:chat:create`、`im:chat:update`。
- [x] README 说明 Codex App 单独对话完成提醒和对应配置项。
- [x] 飞书权限和授权步骤已写入 `docs/FEISHU_APP_SETUP.md`。
- [x] `docs/FEISHU_APP_SETUP.md` 区分默认必选权限、可选权限、话题 fallback。
- [x] Codex Desktop 同步优化方案已写入 `docs/CODEX_DESKTOP_SYNC_OPTIMIZATION.md`。
- [x] 许可证使用 GPL-3.0-only，根目录 `LICENSE` 已同步。

## 安装体验

- [x] `scripts/setup-windows.ps1` 可检查依赖并初始化配置。
- [x] `config.example.json` 不包含真实密钥。
- [x] `package-lock.json` 已使用 npm 官方源重新生成，不含 `registry.npmmirror.com` / `registry.npm.taobao.org`。
- [x] `npm audit --json` 为 0 漏洞。
- [x] `npm run build` 通过。
- [x] `npm test` 通过。
- [x] `npm run check` 通过。

## GitHub 发布

目标仓库：

```text
https://github.com/a1647517212/codex-feishu-helper
```

建议推送前执行：

```powershell
git status --short
npm run check
```

然后：

```powershell
git remote add github https://github.com/a1647517212/codex-feishu-helper.git
git push github HEAD:main
```

GitHub 仓库当前使用默认分支 `main`。

## 首次开源后的建议

- 补一张架构图。
- 补一段飞书开放平台截图式配置说明。
- 后续把 canonical WebSocket app-server 方案落地，减少 Codex Desktop 同步困扰。
