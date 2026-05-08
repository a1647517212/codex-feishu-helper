# 飞书应用配置指南

本文面向第一次使用 Codex Feishu Helper 的用户，目标是尽量减少飞书开放平台配置阻碍。

## 1. 创建自建应用

1. 打开飞书开放平台。
2. 创建「企业自建应用」。
3. 记录应用凭证：
   - `App ID`
   - `App Secret`
4. 在项目配置文件中填写：

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx"
  }
}
```

不要把真实 `App Secret` 提交到仓库。

## 2. 启用机器人

在应用能力中启用机器人，并把机器人添加到你的主控群。

建议主控群只放自己和机器人。默认个人使用场景下，项目不做复杂团队权限模型。

## 3. 开启长连接事件

在「事件订阅」中选择长连接。

长连接的好处：

- 本地机器不需要公网 IP。
- 不需要域名。
- 不需要内网穿透。
- 飞书事件通过机器人长连接进入本地 bridge。

只有当你的租户不支持某些卡片按钮事件走长连接时，才需要 HTTP callback fallback。

## 4. 订阅事件

至少订阅：

| 事件 | 用途 |
| --- | --- |
| `im.message.receive_v1` | 接收群消息和任务会话消息 |
| `card.action.trigger` | 接收卡片按钮点击 |

如果控制台找不到 `card.action.trigger`，可以先把配置改为命令模式：

```json
{
  "feishu": {
    "interactionMode": "message_command"
  }
}
```

## 5. 授权权限

默认配置 `taskContainerMode=dedicated_chat` 会为每个 Codex 任务创建一个独立飞书群聊。也就是说，机器人不只是回复主控群消息，还会调用飞书 OpenAPI 创建任务群、修改任务群标题、向任务群发送卡片。因此创建群聊权限是默认模式的必选项。

默认必选权限如下。飞书控制台的权限名称可能随租户和版本略有差异，以控制台提示为准。

| 能力 | 权限或能力 |
| --- | --- |
| 接收群消息 | `im.message.receive_v1` 事件及消息读取相关权限 |
| 群里不用 @ 也能读消息 | 机器人接收群聊全部消息能力 |
| 发送文本、卡片、任务结果 | `im:message:send_as_bot`、`im:message` |
| 回复消息、话题 fallback、更新状态卡片 | `im:message:send_as_bot`、`im:message` |
| 查询主控群和任务群信息 | `im:chat:readonly` 或 `im:chat:read` |
| 创建独立任务群聊 | `im:chat`、`im:chat:create` |
| 修改任务群名称和诊断切换话题模式 | `im:chat`、`im:chat:update` |
| 卡片按钮点击 | `card.action.trigger` 事件，优先配置为长连接 |
| 长连接接收事件 | 事件订阅长连接能力 |

可选权限：

| 能力 | 权限或能力 |
| --- | --- |
| 自动检查应用回调配置 | `admin:app.info:readonly` |
| 自动修复应用回调配置 | `application:application:self_manage` |
| 后续把更多用户或机器人拉入已有任务群 | `im:chat.members:write_only` |
| 图片/文件消息 | 如后续启用文件能力，需要媒体上传下载相关权限 |

如果只想使用「主控群 + 群内话题」而不创建独立任务会话，可以暂时不授予 `im:chat:create`，并在配置里改为：

```json
{
  "feishu": {
    "taskContainerMode": "topic",
    "taskChatFallbackToTopic": true
  }
}
```

话题模式不创建新群，因此不会在飞书左侧会话列表里出现一任务一条会话；任务只会作为主控群内的话题/回复存在。

## 5.1 权限和接口对照

当前 bridge 实际调用的飞书接口如下，便于按报错反查权限：

| 功能 | OpenAPI | 主要权限 |
| --- | --- | --- |
| 获取 tenant token | `POST /open-apis/auth/v3/tenant_access_token/internal` | 使用 `App ID` / `App Secret` |
| 发送文本/卡片 | `POST /open-apis/im/v1/messages?receive_id_type=chat_id` | `im:message:send_as_bot`、`im:message` |
| 回复消息/创建话题回复 | `POST /open-apis/im/v1/messages/{message_id}/reply` | `im:message:send_as_bot`、`im:message` |
| 更新文本/卡片消息 | `PUT/PATCH /open-apis/im/v1/messages/{message_id}` | `im:message:send_as_bot`、`im:message` |
| 创建独立任务群 | `POST /open-apis/im/v1/chats` | `im:chat`、`im:chat:create` |
| 修改任务群标题/群消息形式 | `PUT /open-apis/im/v1/chats/{chat_id}` | `im:chat`、`im:chat:update` |
| 查询群信息 | `GET /open-apis/im/v1/chats/{chat_id}` | `im:chat:readonly` 或 `im:chat:read` |
| 检查/修复卡片回调配置 | `GET/PATCH /open-apis/application/v6/applications/{app_id}` | `admin:app.info:readonly` 或 `application:application:self_manage` |

## 6. 发布并授权应用

权限调整后，需要：

1. 创建应用版本。
2. 发布版本。
3. 在企业管理后台完成应用授权。

只在开发后台勾选权限但没有发布/授权时，机器人仍会报权限不足。

## 7. 获取主控群 Chat ID

推荐方式：

1. 把机器人加入主控群。
2. 在群里发送 `/doctor` 或 `/codex`。
3. 查看 bridge 日志或诊断输出中的 `chatId`。
4. 写入配置：

```json
{
  "feishu": {
    "defaultChatId": "oc_xxx",
    "allowedChatIds": ["oc_xxx"]
  }
}
```

如果你已经知道群的 `oc_xxx`，也可以直接填写。

## 8. 验证

启动 bridge：

```powershell
npm run start
```

在主控群发送：

```text
/doctor
```

正常情况下应看到诊断卡片。然后发送：

```text
/codex
```

应看到主控台。

## 常见问题

### 群里不 @ 机器人没有反应

检查是否开启了「接收群聊全部消息」能力，并确认应用版本已发布授权。

### 按钮点击报错

优先检查 `card.action.trigger` 是否已订阅且使用长连接。如果租户只支持 HTTP 卡片回调：

- 临时使用 `interactionMode=message_command`。
- 或配置公网 relay，只暴露 `/feishu/card`。

### 能收到主控群消息，但任务会话创建失败

检查：

- `im:chat:create`
- `im:chat:update`
- `im:chat.members:write_only`

如果暂时不想授权建群，改用 `taskContainerMode=topic`。

### 修改权限后仍然报错

飞书权限需要发布应用版本并重新授权。只在开发后台勾选权限不会立即对机器人生效。
