# Codex Desktop 实时同步优化方案

## 背景

飞书 bridge 在任务会话中继续 Codex 对话时，Codex App 有时不会实时刷新；重启 Codex App 后又能看到已完成内容。用户提出过“定时刷新 Codex App UI”的想法，但这种方式只是重新读取落盘历史，不能保证进行中状态、子 agent、审批和流式输出一致。

本方案记录源码和社区调查后的推荐优化路径，便于后续按优先级落地。

## 已确认根因

当前 bridge 的连接模式是：

1. `connectionMode=auto` 时先尝试 `codex app-server proxy`。
2. 如果无法连接 Desktop control socket，则回退到 `codex app-server` standalone stdio。

本机日志显示：

```text
failed to connect to socket at %USERPROFILE%\.codex\app-server-control\app-server-control.sock
os error 10050
codex app-server connected mode=standalone
```

同时本机 `app-server-control.sock` 不存在。因此当前实际状态是：

- Codex Desktop 自己启动一个 stdio app-server。
- Feishu bridge 又启动一个 standalone app-server。
- 两边只共享部分落盘历史，不共享同一个实时内存态。

这会导致 Desktop UI 不能稳定实时显示 bridge 发起的 turn。

## 源码和社区调查结论

OpenAI Codex app-server 支持以下 transport：

- `stdio://`
- `unix://`
- `ws://IP:PORT`
- `off`

`codex --remote ws://host:port` 可以让 TUI 连接远程 app-server。Codex Desktop 打包代码中也存在 `CODEX_APP_SERVER_WS_URL` 和 `CODEX_APP_SERVER_FORCE_CLI` 入口，说明 Desktop 内部存在 WebSocket app-server 连接路径。

社区 issue 里也有相同方向的讨论：

- `openai/codex#11166`：希望把 app-server 暴露为更稳定的网络/socket transport，供第三方 UI 和桥接器使用。
- `openai/codex#15320`：多个客户端连接同一 app-server/thread 时，外部客户端发起的 turn 仍可能存在 UI 实时刷新边界。
- `openai/codex#15355`：希望给正在运行的交互会话提供稳定 ingress，避免键盘/PTY 注入。

结论：定时刷新 UI 不应作为主方案。正确方向是统一 runtime，并在 Feishu 侧做事件流和完成后补偿同步。

## 推荐架构

```mermaid
flowchart LR
  Feishu["飞书群 / 任务会话"] --> Bridge["codex-feishu-helper"]
  Bridge --> Canonical["canonical codex app-server\nws://127.0.0.1:<port>"]
  Desktop["Codex Desktop\n可选接入"] --> Canonical
  TUI["codex --remote\n可选实时查看"] --> Canonical
  Canonical --> Store["Codex sessions / state"]
```

## 优化阶段

### P0：bridge 拥有 canonical app-server

新增连接模式：

```json
{
  "codex": {
    "connectionMode": "websocket",
    "websocketUrl": "ws://127.0.0.1:47891",
    "websocketListenUrl": "ws://127.0.0.1:47891"
  }
}
```

行为：

- bridge 启动 `codex app-server --listen ws://127.0.0.1:<port>`。
- bridge 通过 WebSocket JSON-RPC 连接它。
- 保留 `standalone` stdio 作为 fallback。
- doctor 展示当前连接类型、URL、健康检查结果。

### P1：验证 Desktop 接入 canonical runtime

验证方式：

```powershell
$env:CODEX_APP_SERVER_WS_URL="ws://127.0.0.1:47891"
codex app
```

或者通过 Windows 启动脚本给 Codex Desktop 注入环境变量。

验收标准：

- Desktop 打开后连接同一个 app-server。
- Feishu 发起新 turn 时 Desktop 能收到 `turn/started`、`item/*`、`turn/completed`。
- Desktop 不再需要重启才能看到 bridge 写入的内容。

风险：

- `CODEX_APP_SERVER_WS_URL` 不是稳定公开 API。
- Desktop 仍可能过滤外部客户端发起的某些事件。
- 后续 Codex Desktop 更新可能改变隐藏入口。

### P2：Feishu 事件流和补偿同步

实时阶段：

- 消费 `turn/started`。
- 消费 `turn/plan/updated`。
- 消费 `item/started`。
- 消费 `item/agentMessage/delta`。
- 消费 `item/reasoning/summaryTextDelta`。
- 消费 `item/completed`。
- 消费 `turn/completed`。

完成阶段：

- 调用 `thread/read` 或 `thread/turns/list` 拉取完整 turn/items。
- 对比本地 projection。
- 修正漏事件、截断、子 agent 信息缺失。
- 只在卡片超限时补发“完整最终结论”或续卡片。

## 不推荐方案

### 定时刷新 Codex App UI

问题：

- 不能保证同一个 app-server runtime。
- 无法还原正在运行中的内存态。
- 子 agent、审批、工具调用和流式输出仍可能丢失。
- 依赖 Desktop UI 行为，版本更新后容易失效。

### 键盘/PTY 注入

问题：

- 容易和人工输入冲突。
- 不能可靠判断输入是否提交。
- 难以审计和恢复。
- 不适合后台 bridge 长期运行。

## 后续实现清单

- [ ] `CodexClient` 抽象 stdio 与 WebSocket transport。
- [ ] 配置新增 `websocketUrl`、`websocketListenUrl`、`websocketTokenFile`。
- [ ] 启动 canonical app-server 并检查 `/readyz`。
- [ ] doctor 展示 app-server transport 和健康状态。
- [ ] 增加 WebSocket transport mock 测试。
- [ ] 增加完成后 `thread/read` 补偿同步。
- [ ] 验证 `CODEX_APP_SERVER_WS_URL` 启动 Desktop 的可行性。
- [ ] 文档化 Desktop/TUI 接入方式。
