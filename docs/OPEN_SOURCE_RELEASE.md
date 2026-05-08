# 开源发布检查清单

本项目准备开源时，按下面清单检查。

## 敏感信息

- [ ] 仓库中没有真实 `App Secret`。
- [ ] 仓库中没有真实 `adminToken`。
- [ ] 仓库中没有 `tenant_access_token`。
- [ ] 仓库中没有个人数据库和日志。
- [ ] `.env`、`.env.*`、`.feishu-codex/`、`dist/`、`node_modules/` 已被忽略。

推荐扫描：

```powershell
rg -n -e "cli_[A-Za-z0-9]+" -e "App Secret" -e "appSecret" -e "app_secret" -e "tenant_access_token" -e "Bearer " -e "password" -e "secret" -S .
```

扫描结果中允许出现：

- 示例占位符。
- 测试假 token。
- 源码里的字段名。

## 文档

- [ ] README 是中文主入口。
- [ ] README 有最小启动步骤。
- [ ] README 说明默认不需要公网 IP。
- [ ] README 说明默认权限风险：`danger-full-access` 和 `approvalPolicy=never`。
- [ ] 飞书权限和授权步骤已写入 `docs/FEISHU_APP_SETUP.md`。
- [ ] Codex Desktop 同步优化方案已写入 `docs/CODEX_DESKTOP_SYNC_OPTIMIZATION.md`。
- [ ] 许可证使用 GPL-3.0-only，根目录 `LICENSE` 已同步。

## 安装体验

- [ ] `scripts/setup-windows.ps1` 可检查依赖并初始化配置。
- [ ] `config.example.json` 不包含真实密钥。
- [ ] `npm run build` 通过。
- [ ] `npm test` 通过。
- [ ] `npm run check` 通过。

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
git push github HEAD:master
```

如果 GitHub 仓库默认分支是 `main`，可改为：

```powershell
git push github HEAD:main
```

## 首次开源后的建议

- 补一张架构图。
- 补一段飞书开放平台截图式配置说明。
- 后续把 canonical WebSocket app-server 方案落地，减少 Codex Desktop 同步困扰。
