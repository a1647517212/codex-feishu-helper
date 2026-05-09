# Codex Feishu Helper

Codex Feishu Helper 是一个本地桥接服务，用飞书群聊控制本机 Codex `app-server` 任务。它适合个人把飞书当作 Codex 任务控制台：在主控群里选择项目、创建任务、查看任务列表，在每个任务的独立飞书会话里持续追问和接收进度、结论。

当前默认设计是：

- 飞书事件默认走长连接，不要求公网 IP、域名或内网穿透。
- HTTP 服务默认只监听 `127.0.0.1`，用于健康检查、诊断和可选 HTTP 回调 fallback。
- 新任务默认创建独立飞书任务会话；如果没有建群权限，可回退为群内话题。
- Codex 默认模型是 `gpt-5.4`，思考等级是 `xhigh`，权限是 `danger-full-access`，审批策略是 `never`。
- 任务过程会推送结构化进度卡片，完成后推送结构化最终结论。
- 只在 Codex App 里单独发起、没有绑定飞书的对话，结束后也会在主控群提醒，并可一键接管到飞书继续。

Codex Desktop 实时同步的长期优化方案见 [docs/CODEX_DESKTOP_SYNC_OPTIMIZATION.md](docs/CODEX_DESKTOP_SYNC_OPTIMIZATION.md)。

## 功能概览

- `/codex`：打开主控台。
- 项目列表：自动/配置导入本地项目后，从主控台选择项目。
- 新建任务：在项目下创建 Codex 任务，并创建独立飞书任务会话。
- 继续任务：在任务会话里直接发消息即可继续同一个 Codex 线程。
- 任务列表：查看运行中、已完成、失败、中断、归档任务。
- 任务设置：在飞书中查看和调整模型、思考等级。
- Codex App 单独对话提醒：后台扫描最近结束的未绑定本机 Codex 对话，完成/失败/中断后推送到主控群。
- 诊断恢复：检查飞书权限、长连接、Codex app-server、数据库、消息 outbox。
- 本地守护：Windows 定时任务可每 5 分钟检查并拉起桥接服务。

## 环境要求

- Windows 10/11、macOS 或 Linux。当前脚本优先支持 Windows。
- Node.js 22.13 或更高版本。
- 已安装并登录 Codex CLI：`codex --version` 能正常输出，且 `codex login` 已完成。
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

`server.adminToken` 是本机 HTTP 诊断接口的访问 token，只在本机 `/doctor`、`/console-card` 等管理接口使用。可以填一个本机自用随机字符串，例如：

```json
{
  "server": {
    "adminToken": "change-this-local-token"
  }
}
```

最小可运行配置示例：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "adminToken": "change-this-local-token"
  },
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "defaultChatId": "oc_xxx",
    "transport": "long_connection",
    "messageTransport": "long_connection",
    "cardActionTransport": "long_connection",
    "interactionMode": "hybrid",
    "taskContainerMode": "dedicated_chat",
    "allowedChatIds": ["oc_xxx"]
  }
}
```

启动服务：

```powershell
npm run start
```

检查诊断：

```powershell
npm run doctor
```

### Canonical WebSocket 模式

默认 `connectionMode=auto` 会优先尝试 Desktop proxy，失败后回退到独立 stdio app-server。若希望 bridge 拥有一个 canonical WebSocket app-server，并让 Codex Desktop 尽量接入同一个 runtime，可改成：

```json
{
  "codex": {
    "connectionMode": "canonical_websocket",
    "websocketListenUrl": "ws://127.0.0.1:47931",
    "desktopSocksProxyEnabled": true,
    "desktopSocksProxyHost": "127.0.0.1",
    "desktopSocksProxyPort": 1080
  }
}
```

然后用同一个 URL 启动 Codex Desktop：

```powershell
$env:CODEX_APP_SERVER_WS_URL="ws://127.0.0.1:47931"
Start-Process "C:\Program Files\WindowsApps\OpenAI.Codex_...\app\Codex.exe"
```

当前 Codex Desktop 版本会通过 `127.0.0.1:1080` SOCKS5 代理访问 `CODEX_APP_SERVER_WS_URL`，所以启用 Desktop 接入时需要 `desktopSocksProxyEnabled=true`，或确保本机已有 1080 代理能转发到该 WebSocket 端口。`/doctor` 会显示 `WebSocket` 和 `Desktop SOCKS` 状态。

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
7. 授权发送消息、回复消息、发送卡片、创建群聊、更新群聊等权限。默认一任务一独立会话模式必须有创建群聊权限。
8. 发布应用版本，并在管理后台完成授权。

默认模式是 `taskContainerMode=dedicated_chat`，也就是每个 Codex 任务创建一个独立飞书群聊。这个模式不是只在主控群里回复消息，所以「创建群聊」是必选权限。

默认必选权限清单：

| 场景 | 权限 |
| --- | --- |
| 接收群消息 | 事件 `im.message.receive_v1`，以及控制台提示的消息读取权限 |
| 读取不用 @ 的群消息 | 机器人接收群聊全部消息能力 |
| 发送文本/卡片、回复消息、更新卡片 | `im:message:send_as_bot`、`im:message` |
| 创建每个任务的独立飞书群聊 | `im:chat`、`im:chat:create` |
| 修改任务群标题、诊断/切换话题模式 | `im:chat`、`im:chat:update` |
| 读取主控群和任务群信息 | `im:chat:readonly` 或 `im:chat:read` |
| 卡片按钮点击 | 事件 `card.action.trigger`，优先选择长连接 |
| 长连接事件 | 事件订阅长连接，不需要公网回调地址 |

可选权限：

| 场景 | 权限 |
| --- | --- |
| 自动检查/修复应用回调配置 | `admin:app.info:readonly` 或 `application:application:self_manage` |
| 后续把更多用户或机器人拉入已有任务群 | `im:chat.members:write_only` |
| 图片/文件消息 | 媒体上传下载相关权限 |

不同租户控制台显示的权限名称可能略有差异，以飞书开放平台实际提示为准。

如果不想给机器人创建群权限，可以改成主控群内话题 fallback：

```json
{
  "feishu": {
    "taskContainerMode": "topic",
    "taskChatFallbackToTopic": true
  }
}
```

这个模式不创建独立任务群，但任务不会出现在飞书左侧会话列表里，只会作为主控群内话题/回复存在。

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

如果直接使用模板里的 `${FEISHU_CODEX_ADMIN_TOKEN}` 但没有设置环境变量，bridge 会在每次启动时生成临时 token。建议正式使用时在 `config.json` 里写固定 `server.adminToken`，这样诊断接口和后台守护更稳定。

默认会扫描 Codex App 最近 24 小时内结束、但还没有绑定飞书的本机对话，并向 `feishu.defaultChatId` 推送一次提醒。提醒卡片包含摘要和 `[在飞书继续]`、`[查看摘要]`、`[忽略]` 操作；同一个 turn 会用 outbox 去重，不会反复提醒。

相关配置：

```json
{
  "bridge": {
    "codexOnlyCompletionWatchEnabled": true,
    "codexOnlyCompletionPollMs": 60000,
    "codexOnlyCompletionLookbackMs": 86400000
  }
}
```

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
