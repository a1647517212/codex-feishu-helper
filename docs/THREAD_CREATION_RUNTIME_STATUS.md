# 飞书新建线程当前阻塞状态

- 日期: 2026-05-12
- 仓库: `C:\develop\codex-feishu`
- 当前分支: `zpj/飞书控制Codex桥接`
- 目标: 不新增 server、不走 hack，只基于官方 Codex App Server / Desktop IPC 方案，让飞书侧能创建真实新线程。thread goal 不应由普通飞书消息自动触发，只应由 Codex 官方 `/goal` 指令或其它显式 goal 操作触发。

## 2026-05-13 收口结论

- 这个问题的主线已经收口，不再是 blocker。
- 当前 bridge 已经满足:
  - 飞书可通过官方 direct `codex app-server` stdio 创建真实新线程
  - 新线程创建后可自动同步 thread title
  - 普通飞书消息不会自动写入 thread goal；只有 Codex 官方 `/goal` 指令或其它显式 goal 操作才进入 goal 模式
  - `desktop_ipc` 继续只承担 claim/continue，不再承诺飞书直接新建线程
- 2026-05-13 最后一轮 live 验证已读回真实结果:
  - `threadId = 019e1d06-789d-75d0-bd6b-fd3555d608c5`
  - `readName = verify feishu can create real thread and sync goal after direct app-server pivot`
  - 当时探针曾验证 `goal.objective = verify feishu can create real thread and sync goal after direct app-server pivot`，但产品逻辑现在不再把普通飞书消息自动写成 goal
- 因此后续不要再把这个问题重新定义成:
  - “必须等 Remote Control / app-server proxy 打通，飞书才能新建线程”
  - 或 “goal API 已经彻底消失”

## 2026-05-13 新增运行时纠偏

- 新的 live 失败已经说明，当前“飞书新建任务失败”不能再笼统表述成“thread/start 不可用”。
- 最新证据是:
  - 飞书 `new_task` 动作可以成功创建并绑定真实 thread
  - 失败发生在首轮 `turn/start`
  - 真实报错是 `401 Unauthorized`，目标 URL 为 `https://cch.epean.cn/v1/responses`
- 根因不是飞书侧没创建线程，而是 bridge 当前 `desktop_proxy` 实现本质上会 direct spawn 一个新的 `codex app-server` 子进程。
- 这个子进程是否能执行首轮，取决于它自己的 auth/runtime 可用性，不能只看 Desktop UI 是否已经打开。
- 因此实现上必须补一层前置 gate:
  - 先通过 `getAuthStatus` + `account/read` 判断当前 app-server 是否真的能执行首轮
  - 如果 provider 需要 OpenAI account auth，但当前 app-server 只有 API key / logged out 状态，就不要再创建线程后首轮失败
  - 应直接把需求保留为飞书草稿，并明确告知当前是 app-server auth 不可用

## 当前结论

- 旧结论需要纠正:
  - 当前 blocker 不能再表述为“没有 Remote Control socket，所以官方新线程路径不存在”。
  - 已经实测证明: 官方 `codex app-server` 直连 stdio 路径，在这台机器上可以创建真实新线程。
- 现在更准确的状态是:
  - 官方 `codex app-server` 直连 stdio 路径可创建真实 thread。
  - 官方 `codex app-server proxy` / Remote Control websocket 路径仍未就绪。
  - bridge 当前对“必须走 proxy 才能新建线程”的假设很可能已经过时。

## 上下文压缩保护

后续会话如果只靠上下文摘要，最容易重复两类低价值动作:

- 再从 `\\.\pipe\codex-ipc` 起步做一轮新线程能力探针
- 再从“proxy 不通 = 官方无法新建线程”这个旧前提继续扩散分析

这两类动作都不要再重跑，除非出现下面任一变化:

- Codex Desktop / CLI 版本变化
- `codex app-server` schema 明显变化
- 官方 login / enrollment / feature-store 状态变化

## 已经确认的边界

- 不要再把 stock `desktop_ipc` 当成当前产品可承诺的新线程方案反复探测。
- 不要再把“proxy 控制链路不通”直接等价成“官方 app-server 无法新建 thread”。
- 当前最该收敛的是:
  - bridge 应该如何保持官方 `codex app-server` 直连 stdio 路径稳定
  - goal API 只作为显式能力保留，不要把普通飞书消息自动转成 goal

## 已证实事项

- `codex features list` 显示 `remote_control` effective state 为 `true`。
- `C:\Users\EPEANZ\.codex\sqlite\codex-dev.db`
  - 表 `local_app_server_feature_enablement` 存在
  - 当前查询为空，可记为 `localFeatureState = unset`
- `C:\Users\EPEANZ\.codex\.codex-global-state.json`
  - `electron-persisted-atom-state.codexCloudAccess = "disabled"`
  - 顶层 `electron-remote-control-client-enrollments` 不存在
- `C:\Users\EPEANZ\.codex\state_5.sqlite`
  - `remote_control_enrollments` 行数 = `0`
- `codex app-server proxy`
  - 当前仍会报 remote control / ChatGPT authentication 相关错误
- 但同时，官方 `codex app-server` 直连 stdio 已经成功:
  - `codex debug app-server send-message-v2 "test"` 能创建真实 thread
  - 直接 spawn `codex app-server` 并发送 `initialize` + `thread/start` 也能创建真实 thread

## 这轮最关键的新证据

### 1. 官方直连 stdio 路径已能创建真实 thread

- `thread/start` 已被 live 证实可用
- `sandbox` 参数需要发字符串，如 `"danger-full-access"`，而不是旧对象形态
- 返回过真实 thread id，例如:
  - `019e1cae-bba5-7b02-b6e3-55980f950a01`

### 1.1 2026-05-12 23:13 最新 live probe 已固定

这一轮已经用官方 `codex app-server` 直连 stdio 再次实测，得到更精确的行为约束:

- `thread/start` 成功返回真实 thread
  - 例如 `019e1cc0-1b98-7811-9813-ba5c3aa64539`
- 新线程在首条用户消息之前还没有 fully materialized
  - 此时如果直接 `thread/read` 且 `includeTurns=true`
  - 会报:
    - `thread ... is not materialized yet; includeTurns is unavailable before first user message`
- 但在首条用户消息之前，下面这些动作已经可以成功:
  - `thread/name/set`
  - `thread/read` with `includeTurns=false`
- `turn/start` 发出首条用户消息后:
  - `thread/read` with `includeTurns=true` 开始可用
  - thread 状态会从 `idle` 变成 `active`

这条行为约束非常关键，后续不要再把“新线程刚创建后读不到 turns”误判成 thread 创建失败。

### 2. goal API 假设已经失准

- 对新建 thread 继续调用 `thread/goal/set` 时，live 返回:
  - `cannot update goal for thread ...: no goal exists`
- 这说明当前 bridge 里的 goal 写法已经不能直接假定正确

### 2.1 当前 goal 结论必须按这个口径固定

- 最新生成的官方 `ClientRequest.ts` 里没有 `thread/goal/set` / `thread/goal/clear`
- 但通知面里仍然存在:
  - `thread/goal/updated`
  - `thread/goal/cleared`
- live probe 进一步证实:
  - 用旧参数名 `goal` 直接发送 `thread/goal/set` 到 app-server，会返回
    - `cannot update goal for thread ...: no goal exists`
  - 根因不是接口彻底失效，而是参数假设过时
  - 当前实验 schema (`generate-ts --experimental`) 里:
    - `thread/goal/set` 真实参数是 `objective`
    - 不是旧代码里使用的 `goal`
  - 用正确参数调用后，live 已成功:
    - `thread/goal/get` 初始返回 `goal: null`
    - `thread/goal/set { threadId, objective, status: "active" }` 成功返回完整 goal
    - `thread/goal/get` 随后可读回同一条 goal
    - `thread/goal/clear` 成功返回 `{ "cleared": true }`
    - 清空后 `thread/goal/get` 再次回到 `goal: null`

这说明当前版本至少有两个事实:

- goal 在服务端内部仍是有状态概念，不是完全消失
- 非 experimental schema 不会暴露它，但 experimental 请求面下 goal 仍然可以被正确写入

因此后续不要再把“goal 写不进去”简单归因成接口下线，先检查:

1. schema 是否带了 `--experimental`
2. 参数名是否用的是 `objective`

所以后续不要再把“goal 通知还在”错误推导成“客户端就还能直接 set goal”。

### 3. 当前生成 schema 与旧文档不一致

- `C:\develop\codex-feishu\src\generated\codex\ClientRequest.ts` 当前包含:
  - `thread/start`
  - `thread/name/set`
  - `thread/metadata/update`
- 但当前文件里看不到:
  - `thread/goal/set`
  - `thread/goal/clear`

这说明:

- 仓库里关于 `thread/goal/*` 的旧认知可能已经过时
- 下一步必须以当前 live schema / live probe 为准，而不是继续信旧文档

## 当前代码层含义

- `src/codex/desktop-proxy.ts`
  - 当前已默认拉起 direct `codex app-server`
  - 显式 `setThreadGoal` API 仍可按当前 live 结论调用 `thread/goal/set { threadId, objective, status: "active" }`
  - `startThread({ prompt })` 不再隐式设置 goal，避免普通飞书消息默认进入 goal 模式
  - `readThread(includeTurns=false)` 已用于规避新线程未 materialized 时的误判
- `src/bridge/task-service.ts`
  - 飞书新任务主链路为 `thread/start -> title -> first turn`
  - 草稿会话后续真正启动新线程时，也不再自动同步 goal
- 因此主线已不再是“继续探针”，而是:
  - 补齐文档/诊断口径
  - 保持测试覆盖，防止后续回退到旧的 `proxy-only` 假设

## 本机 Remote Control runtime 现状

这部分不是主线结论，但仍然是一个并行事实:

- `codex app-server proxy` / Remote Control websocket 仍不健康
- live stderr 已看到:
  - remote control requires ChatGPT authentication
  - plugin sync requires ChatGPT authentication

这说明:

- “官方 app-server 可创建 thread”
- 和
- “Remote Control websocket 已完成认证/代理接入”

是两件不同的事，不能继续混为一谈。

## 高价值证据入口

- 运行态文档:
  - `C:\develop\codex-feishu\docs\THREAD_CREATION_RUNTIME_STATUS.md`
- 当前 app-server transport 代码:
  - `C:\develop\codex-feishu\src\codex\desktop-proxy.ts`
  - `C:\develop\codex-feishu\src\codex\client.ts`
- 当前 schema 参考:
  - `C:\develop\codex-feishu\src\generated\codex\ClientRequest.ts`
- 关键持久状态:
  - `C:\Users\EPEANZ\.codex\.codex-global-state.json`
  - `C:\Users\EPEANZ\.codex\config.toml`
  - `C:\Users\EPEANZ\.codex\state_5.sqlite`
  - `C:\Users\EPEANZ\.codex\sqlite\codex-dev.db`

## 下次续做时的最短入口

下次不要再从 IPC 盲探重新开始，直接按下面顺序收敛:

1. 重新生成当前官方 schema:
   - `codex app-server generate-ts --out <temp-dir>`
   - `codex app-server generate-json-schema --out <temp-dir>`
2. live 验证 `initialize` + `thread/start`
3. 找出当前正确的 goal 同步方法
4. 对照更新 `src/codex/desktop-proxy.ts`
5. 补测试并再做 end-to-end 验证

## 本轮已固定的禁止重复动作

后续不要再重复下面这些低价值动作:

1. 不要再把 `thread/read includeTurns=true` 在首条用户消息前报错，误判成 thread/start 失败
2. 不要再依据旧文档继续假定 `thread/goal/set` 一定存在于当前公开请求 schema
3. 不要再把通知面还存在 `thread/goal/*`，误判成客户端一定还能直接写 goal
4. 不要再把 `codex app-server proxy` 认证失败，等价成“官方 direct app-server 无法新建线程”

## 当前收口状态

截至本次更新，主线已经从“探针阶段”进入“收口阶段”:

1. bridge 传输层已切到官方 direct `codex app-server` stdio
2. goal 已按 experimental schema 的 `objective` 参数成功写入
3. 新线程 materialization 边界已写入实现与文档

后续高价值动作只剩:

1. 跑完整测试与构建验证，防止回归
2. 把仓库内仍然传播旧前提的 README / 设计文档 / 诊断文案全部改正
3. 保留一份固定证据，避免后续会话再次退回“proxy 不通 = 无法新建线程”的旧循环
