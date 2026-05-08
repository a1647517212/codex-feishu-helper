# Codex Feishu Helper

Codex Feishu Helper 是一个本地桥接服务，用飞书群聊控制本机 Codex `app-server` 任务。它适合个人把飞书当作 Codex 任务控制台：在主控群里选择项目、创建任务、查看任务列表，在每个任务的独立飞书会话里持续追问和接收进度、结论。

当前默认设计是：

- 飞书事件默认走长连接，不要求公网 IP、域名或内网穿透。
- HTTP 服务默认只监听 `127.0.0.1`，用于健康检查、诊断和可选 HTTP 回调 fallback。
- 新任务默认创建独立飞书任务会话；如果没有建群权限，可回退为群内话题。
- Codex 默认模型是 `gpt-5.4`，思考等级是 `xhigh`，权限是 `danger-full-access`，审批策略是 `never`。
- 任务过程会推送结构化进度卡片，完成后推送结构化最终结论。

Codex Desktop 实时同步的长期优化方案见 [docs/CODEX_DESKTOP_SYNC_OPTIMIZATION.md](docs/CODEX_DESKTOP_SYNC_OPTIMIZATION.md)。

## 功能概览

- `/codex`：打开主控台。
- 项目列表：自动/配置导入本地项目后，从主控台选择项目。
- 新建任务：在项目下创建 Codex 任务，并创建独立飞书任务会话。
- 继续任务：在任务会话里直接发消息即可继续同一个 Codex 线程。
- 任务列表：查看运行中、已完成、失败、中断、归档任务。
- 任务设置：在飞书中查看和调整模型、思考等级。
- 诊断恢复：检查飞书权限、长连接、Codex app-server、数据库、消息 outbox。
- 本地守护：Windows 定时任务可每 5 分钟检查并拉起桥接服务。

## 环境要求

- Windows 10/11、macOS 或 Linux。当前脚本优先支持 Windows。
- Node.js 22.13 或更高版本。
- 已安装并登录 Codex CLI：`codex --version` 能正常输出。
- 一个飞书自建应用，已启用机器人和长连接事件订阅。

安装 Codex CLI 后先在本机完成登录：

```powershell
codex login
codex --version
```

## 快速启动

Windows 推荐使用初始化脚本：

```powershell
git clone https://github.com/a1647517212/codex-feishu-helper.git
cd codex-feishu-helper
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

脚本会完成：

- 检查 Node.js 和 Codex CLI。
- 安装 npm 依赖。
- 构建项目。
- 创建用户配置目录 `%USERPROFILE%\.feishu-codex`。
- 如果配置不存在，复制 `config.example.json` 为 `%USERPROFILE%\.feishu-codex\config.json`。

然后编辑配置：

```powershell
notepad $env:USERPROFILE\.feishu-codex\config.json
```

至少需要填写：

- `feishu.appId`
- `feishu.appSecret`
- `feishu.defaultChatId`
- `server.adminToken`

启动服务：

```powershell
npm run start
```

检查诊断：

```powershell
npm run doctor
```

如果希望后台保活：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-watchdog.ps1
```

## 飞书应用配置

完整配置步骤见 [docs/FEISHU_APP_SETUP.md](docs/FEISHU_APP_SETUP.md)。

最小流程：

1. 在飞书开放平台创建企业自建应用。
2. 启用机器人，并把机器人拉入主控群。
3. 在「事件订阅」里启用长连接。
4. 订阅消息事件 `im.message.receive_v1`。
5. 订阅卡片按钮事件 `card.action.trigger`，优先选择长连接。
6. 授权机器人读取群内所有消息，这样群里不需要 `@` 机器人。
7. 授权发送消息、回复消息、发送卡片、创建/更新群聊等权限。
8. 发布应用版本，并在管理后台完成授权。

常用权限清单：

| 场景 | 权限 |
| --- | --- |
| 接收群消息 | `im:message`, `im:message:readonly` 或控制台提示的等价权限 |
| 读取不用 @ 的群消息 | 机器人接收群聊全部消息能力 |
| 发送文本/卡片 | `im:message:send_as_bot` |
| 回复消息 | `im:message` 相关回复权限 |
| 创建任务会话 | `im:chat:create` |
| 修改任务会话标题/信息 | `im:chat:update` |
| 邀请成员/设置机器人 | `im:chat.members:write_only` |
| 查询群信息 | `im:chat:readonly` |
| 长连接事件 | 事件订阅长连接，不需要公网回调地址 |

不同租户控制台显示的权限名称可能略有差异，以飞书开放平台实际提示为准。

## 配置文件

默认配置路径：

```text
%USERPROFILE%\.feishu-codex\config.json
```

可以通过环境变量或参数指定：

```powershell
$env:FEISHU_CODEX_CONFIG="D:\path\config.json"
npm run start

node dist/src/main.js serve --config D:\path\config.json
```

配置模板见 [config.example.json](config.example.json)。

不要把真实 `appSecret`、`adminToken`、数据库、日志提交到仓库。`.gitignore` 已默认忽略 `.env`、本地日志、`dist`、`node_modules` 和 `.feishu-codex`。

## 常用命令

在飞书主控群里：

- `/codex`：主控台。
- `/doctor`：诊断。
- `/tasks`：最近任务。
- `/projects`：项目列表。
- `/claim <threadId>`：绑定已有 Codex 线程。

在任务会话里：

- 直接发消息：继续当前任务。
- `/status`：查看状态。
- `/queue`：查看队列。
- `/stop`：停止当前任务。
- `/retry`：重试失败任务。
- `/archive`：归档任务。

## 本地 HTTP 服务说明

默认不需要公网地址。HTTP 只用于：

- `GET /healthz`
- `GET /doctor`
- `POST /feishu/events`，仅 HTTP callback fallback 使用。
- `POST /feishu/card`，仅 HTTP card callback fallback 使用。

如果飞书租户无法把卡片按钮事件配置成长连接，可以临时改成命令模式：

```json
{
  "feishu": {
    "interactionMode": "message_command",
    "cardActionTransport": "long_connection"
  }
}
```

或者自行部署公网 relay，只暴露 `/feishu/card`。

## 开发

```powershell
npm install
npm run build
npm test
npm run check
```

生成 Codex app-server schema：

```powershell
npm run generate:codex-schema
```

## 安全边界

- 个人使用优先，默认不做复杂团队权限模型。
- 建议只在自己的私有主控群中使用。
- 不要把 `codex app-server` 暴露到公网。
- 默认 `danger-full-access` 和 `approvalPolicy=never` 意味着 Codex 可以直接操作本机文件和命令，请只在可信环境使用。
- 如果要给多人使用，请先配置 `allowedUserIds` 和 `allowedChatIds`。

## 开源文档

- [飞书应用配置](docs/FEISHU_APP_SETUP.md)
- [开源发布检查清单](docs/OPEN_SOURCE_RELEASE.md)
- [Codex Desktop 同步优化方案](docs/CODEX_DESKTOP_SYNC_OPTIMIZATION.md)
- [当前功能覆盖](docs/FULL_DESIGN_COVERAGE.md)
- [用户体验优化计划](docs/UX_OPTIMIZATION_PLAN.md)

## 许可证

GPL-3.0-only。详见 [LICENSE](LICENSE)。
