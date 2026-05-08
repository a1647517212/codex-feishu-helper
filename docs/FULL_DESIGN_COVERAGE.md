# Full Design Coverage Matrix

Source: `FEISHU_CODEX_CONTROL_DESIGN.md`

Legend:

- Done: implemented with code and at least one verification path.
- Partial: core shape exists, but behavior is incomplete, simplified, or not end-to-end verified.
- Not started: no meaningful implementation yet.
- Deferred: explicitly outside current implementation scope.

## Executive Status

The project currently implements the main personal-use bridge: Feishu long-connection message transport by default, long-connection card callbacks, button-first hybrid interaction with message-command fallback, optional HTTP callback fallback, one dedicated Feishu task chat per Codex task by default, optional `reply_in_thread=true` topic fallback, Codex app-server stdio transport, SQLite persistence, session binding, semantic events, projections, queueing, approvals, outbox retry, notification preferences, diagnostics with recovery, incoming-message dedupe, unclassified task assignment, task search, local task detail pages, and non-Git workspace checkpoints for “本次影响”.

It still does not implement every advanced item described by the design. The biggest remaining gaps are Desktop-origin live mirror/import, Desktop owner routing/deep links, richer first-run pairing, and project directory discovery. For personal use, team permission workflows are intentionally out of scope. Git-centric UX is not part of the current product surface; file impact and limited restore are derived from local workspace snapshots instead. One important platform nuance remains for fallback topic mode: in a normal message-form group, `reply_in_thread=true` creates an official message thread/topic and returns a `thread_id`, but the group feed still looks like a normal group reply flow. The default dedicated-chat mode avoids that UX limitation by creating a separate Feishu conversation per task.

Approximate coverage by layer:

| Layer | Coverage |
| --- | --- |
| P0 bridge kernel | High |
| P0 real Feishu workflow | High |
| P1 experience enhancements | Medium to high |
| P2 advanced product capabilities | Low |
| Whole design document | High for personal-use scope |

## Section Coverage

| Design section | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| 1 Background and goal | Partial | Bridge controls Codex app-server threads from Feishu messages/cards. Real long-connection `/codex` in group was verified without `@`. | Full goal says mature notifications and richer task lifecycle; advanced pieces remain incomplete. |
| 2 Core conclusion | Done | One Codex thread maps to one Feishu task container in `session_bindings`; default container is a dedicated Feishu task chat, with topic metadata persisted only for fallback mode. | Full topic-feed UX only matters when explicitly using topic fallback. |
| 3 Design boundary | Partial | Uses app-server and accepts eventual sync. | Desktop GUI mirror, owner routing, and true active-turn semantics are not implemented. |
| 4 Terminology and wording | Partial | Cards use Chinese task/control wording. | Wording is not fully audited against every suggested/forbidden phrase. |
| 5 Product information architecture | Partial | Console card, project list card, task status card, approval card, and one-task-one-chat flow exist. | Full hierarchy and lifecycle UI are simplified. |
| 6.1 New task from Feishu | Done | New free-text message in the main control group creates a dedicated Feishu task chat, starts a Codex thread/turn, binds the new chat, and updates the chat name with status. | If chat creation is not authorized, fallback topic mode requires Feishu topic/thread UX acceptance. |
| 6.2 Claim existing Codex App task | Done | `/tasks`, `/claim <threadId>`, `[在飞书继续]`, summary, ignore, and project assignment flows list/read/bind existing app-server threads into dedicated Feishu task chats. | Real Codex Desktop session fidelity is limited to app-server visibility. |
| 6.3 Continue in task chat | Done | `findBindingByChatId`, `findBindingByFeishuThreadId`, `findBindingByTopic`, `steerTurn`, `resumeThread`, `startTurn`, and busy queue route replies to the canonical bound task container. | Full active-turn semantics are still limited by available app-server behavior. |
| 6.4 Completion notification | Done | `turn/completed` inserts events, enqueues status/result cards, applies notification preferences, and sends structured `处理摘要` / `最终结论`. Extraction uses `thread/read`, completed items, and streamed delta fallback. | Long final text is only sent separately when card content is actually truncated. |
| 6.5 Approval handling | Partial | Server approval request is persisted, carded, and resolved idempotently. | Expired approval UX and rich details are still basic. |
| 7 Card and copy design | Partial | Console, new task, claim list, task status, approval, queue, diagnostics, history, unclassified, project-assignment, search, detail, impact, progress, and result cards exist. | Restore/undo cards and deeper visual polish can still improve. |
| 8 Button behavior | Partial | Button actions are idempotent through `action_requests`; visible buttons have handlers; every exposed action now has a message-command fallback; cards render Card JSON 2.0 callback buttons for long-connection `card.action.trigger`. | Button danger levels are simple; some actions are helper replies rather than full flows. Real card click still depends on app-side `card.action.trigger` long-connection subscription. |
| 9 Project abstraction and mapping | Partial | Configured projects are stored; cwd and explicit path-prefix matching work across Windows slash styles; `/unclassified`, create-project, pick-project, assign-project, summary, and ignore flows exist. | Auto directory discovery and richer project settings UI are missing. |
| 10 Data model | Partial | Tables exist for projects, bindings, events, approvals, actions, incoming messages, queue, outbox, prefs, devices, trusted subjects, ownership, and workspace checkpoints. | Pairing/key bootstrap fields are still basic. |
| 11 State machine | Partial | Core statuses are modeled and updated. | Full status/button matrix and expired/archived semantics are simplified. |
| 12 Backend architecture | Done | App composition includes config, DB, repo, Codex client, Feishu client, task service, outbox, diagnostics, HTTP server. | Production packaging/service install is not included. |
| 13 Codex app-server integration | Partial | Stdio JSONL client, initialize, thread/turn methods, notifications, server requests, completed item and streamed delta extraction for final Feishu reports. Auto mode first tries `codex app-server proxy` for Desktop-shared live state and falls back to standalone app-server. | Full official runtime schema validation and all event types are not wired. Desktop live refresh depends on the local Codex control socket being available. |
| 14 Feishu integration | Done for P0 | Long connection is default for messages and `card.action.trigger` callbacks; message commands cover fallback controls; HTTP callback is optional fallback; message parsing, card action parsing, send/reply/update APIs exist; `im/v1/chats` creates dedicated task chats; chat title update marks running/completed/failed; `reply_in_thread=true` remains fallback. | Dedicated-chat mode requires `im:chat:create`, `im:chat:update`, and member-write permissions; card buttons require app-side `card.action.trigger` long-connection subscription and publish. |
| 15 Notification strategy | Done for personal use | Completion/failure/approval/status outbox, retry, history, and global/project/session notification preferences are implemented. Approvals and status refresh bypass muting where appropriate. | @ user policy is not needed for current personal-use scope. |
| 16 Change and log display | Partial | Event/log cards, task status cards, sanitized summaries, progress cards, sub-agent model/reasoning display, local task detail pages, and non-Git “本次影响” cards exist. | Advanced paging can improve. |
| 17 Security and permissions | Partial | Allowed users/chats, path escape block, secret file block, no high-risk task-wide approval. | Pairing, trusted-device workflow, and per-role permissions are not active. |
| 18 Error handling | Partial | HTTP errors, app-server diagnostic status, protocol validation event, idempotent actions. | Expired approval and unavailable app-server recovery cards are basic. |
| 19 MVP phase 1 | Done | Main loop works in code/tests; direct group messages without `@` create dedicated task chats and start Codex turns. | Live dedicated-chat creation depends on Feishu app chat scopes. |
| 19 MVP phase 2 | Done for personal use | Queue view/cancel, task status/log helpers, final result reporting, notification preferences, local detail pages, task search, and checkpoint impact/restore exist. | Restore is intentionally limited to fully captured small text files. |
| 19 MVP phase 3 | Deferred | Team workflows are intentionally out of scope for personal use. | None for current personal-use scope. |
| 20 Development task split | Partial | Infrastructure, Codex, Feishu, flows, security are partially implemented. | Remaining split tasks map to gaps above. |
| 21 API pseudocode | Partial | Claim, continue, and new-task flows map to `TaskService`. | Dedicated-chat creation is implemented; richer API boundaries are simplified. |
| 22 Config example | Done | `config.example.json`, `.env.example`, `loadConfig`. | Installer/setup wizard not included. |
| 23.1 New task acceptance | Done | Feishu text can start Codex, create a dedicated task chat, persist chat binding, update status title/cards, send final result, and dedupe retried incoming messages. | Real file-level verification depends on the task being executed by Codex. |
| 23.2 Claim acceptance | Done | Claim existing thread, create a dedicated Feishu task chat, continue same Codex thread, summarize, ignore, and button/command fallback are covered by tests. | Desktop GUI-only state remains outside current app-server boundary. |
| 23.3 Project mapping acceptance | Done for current scope | Config path prefix, Windows path normalization, cwd rule matching, `/unclassified`, assign, and create-project flows exist. | Auto directory discovery remains future work. |
| 23.4 Notification acceptance | Done for personal use | Completion/failure/approval outbox exists; progress is card-updated instead of spammed; notification levels `all/important/errors/muted` are enforced. | @ creator policy is intentionally omitted. |
| 23.5 Idempotency acceptance | Done | Action request idempotency, approval idempotency, outbox dedupe, and incoming Feishu message dedupe. | User-facing old-button text can be improved. |
| 24 Risks and open questions | Partial | Major risks documented as current boundaries; live Feishu long-connection message flow was verified earlier; card callbacks can be diagnosed/fixed for websocket; default chat diagnostics expose required task-chat scopes. | Dedicated-chat live creation and completion result display need current-app verification after permission grant. |
| 25 Recommended tech route | Done | TypeScript + Node 22 + SQLite + app-server. | Windows service packaging still absent. |
| 26 Development order | Partial | P0 core completed first. | Later-order items remain open. |
| 27 References | Partial | Design-driven implementation; generated schema present. | Reference licenses and upstream detail review not bundled in repo docs. |
| 28 Open-source absorption upgrade | Partial | App-server, queue, outbox, semantic events, task detail page, and workspace checkpoints absorbed in a non-Git personal-use form. | QR pairing and full live mirror are not absorbed. |
| 29 Absorption comparison | Partial | Several P0 ideas implemented. | Non-P0 reference ideas mostly not implemented. |
| 30 Backend layering | Done | Components map cleanly to protocol, task service, projection, storage, HTTP. | Control/run plane separation is code-level, not separately deployed. |
| 31.1 Official schema generation | Partial | Generated Codex types exist under `src/generated/codex`. | Generated types are not fully used as runtime validators. |
| 31.2 AppServerClient wrapper | Done | `CodexClient` wraps app-server methods and pagination. | More methods can be added as needed. |
| 31.3 Control plane/run plane separation | Partial | Task service and Codex client are separated. | No separate process or API boundary. |
| 32 Semantic event layer | Done | `task_events` seq store and semantic event insertion. | Event taxonomy is not exhaustive. |
| 33 Projection and cards | Done | `ProjectionBuilder` builds task cards from DB state. | Card versioning is not fully modeled. |
| 34.1 Basic Codex App interop | Partial | Uses app-server persisted threads. | Does not mirror GUI state directly. |
| 34.2 Import existing tasks | Partial | `thread/list/read` claim works. | Rollout/session file import is missing. |
| 34.3 Desktop-origin live mirror | Not started | No live mirror implementation. | Needs event ingestion from Desktop/source files. |
| 34.4 Desktop owner routing | Deferred | Marked as P2 boundary. | Needs Desktop IPC routing design. |
| 34.5 Refresh/deep link | Partial | Bridge now supports Desktop app-server proxy as a best-effort live-refresh path and syncs thread names through `thread/name/set`. | If proxy socket is unavailable, Desktop may still lag until its own refresh/restart; true deep links still need app integration support. |
| 35 Queue and busy handling | Done | Queue table, enqueue, view, cancel, deliver next after completion. | Optional confirm-before-delivery is not implemented. |
| 36 Approval system upgrade | Partial | Pending approvals persist and route responses. | Expiry handling and richer resolved-card update remain basic. |
| 37.1 Project directory discovery | Not started | No directory scanner. | Needs project registry/discovery UI. |
| 37.2 Path safety | Done | `SecurityPolicy.resolveInsideProject`. | More file APIs are needed before broader validation. |
| 37.3 Local execution summary | Done for current scope | Personal local-task flow is implemented with concise summaries, progress cards, event logs, final report cards, local detail pages, and impact cards. | A richer file browser remains future work. |
| 37.4 Workspace checkpoint | Done for safe personal-use scope | Non-Git `workspace_checkpoints` table, snapshot manifest capture, turn-start/turn-end hooks, “本次影响”, restore confirmation, and limited restore for fully captured small text files exist. | Large/binary/truncated files are intentionally skipped during restore. |
| 38.1 Outbox | Done | Durable outbox with retry and dedupe. | Dead-letter UI is basic via history only. |
| 38.2 Notification preference | Done | Global/project/session preferences are stored, shown in cards, updated from buttons, and enforced by outbox delivery. | Per-user preference overrides are not needed for current personal-use scope. |
| 38.3 Notification history | Done | Recent outbox card/action implemented. | Filtering and detail view can improve. |
| 39.1 Bridge identity | Partial | Device table exists; machine ID in config. | No keypair/bootstrap workflow. |
| 39.2 Feishu pairing | Not started | No pairing code. | Needs QR/code flow and trusted subject writes. |
| 39.3 Health card | Done | `/doctor`, diagnostics snapshot, diagnostic card, `[恢复连接]` action, Codex restart/ensure, dead-outbox reset, and binding reconcile. | Long-connection reconnect is still owned by the Feishu SDK/bridge process lifecycle. |
| 40 Local detail page | Done | Optional HTTP server exposes tokenized `/task/<bindingId>` JSON/HTML pages when HTTP mode is enabled; default long-connection mode does not start HTTP. | Remote/mobile access still requires a private network solution such as Tailscale if needed. |
| 41 Buttons and copy | Done for current scope | Exposed buttons have handlers; task cards include detail/impact/restore/settings; command fallbacks exist for local-only operation. | More advanced menus can still improve mobile density. |
| 42.1 P0 required | Mostly done | Engineering P0 items implemented, including long connection, websocket card callback diagnostics, dedicated Feishu task chats, topic fallback, diagnostics/recovery, queue, outbox, approvals, notification preferences, project matching, unclassified flows, incoming dedupe, and final report extraction. | Runtime schema validation remains partial. |
| 42.2 P1 enhancements | Partial | Queue view/cancel, history, notification preferences, search, local detail, progress cards, checkpoint impact, and limited restore exist. | Project discovery, live mirror, and first-run pairing remain future work. |
| 42.3 P2 advanced | Mostly not started | P2 boundaries documented. | Desktop owner, deep link, multi-machine, teams. |
| 43 Updated development order | Partial | Current branch follows P0-first order. | Next phases need planned execution. |
| 44.1 Protocol compatibility | Partial | Unknown fields tolerated; missing `turn.id` records validation event. | Recovery from every bad delta through read is not exhaustive. |
| 44.2 Event recovery | Done | SQLite recovery, reconcile, monotonic seq tests, completed item extraction, and streamed delta fallback for final reports. | More exotic Codex event types can still be added. |
| 44.3 Queue | Done | Three-message queue, view/cancel, auto-deliver next. | Confirm-before-delivery option absent. |
| 44.4 Approval | Partial | Idempotent approval, no high-risk task-wide button. | Old resolved button UX returns generic idempotent result. |
| 44.5 Notification | Done for personal use | Retry, dedupe, notification preferences, and real group card response are covered. | Per-user @/mention policy is intentionally omitted. |
| 44.6 Project safety | Done | Path escape and secret files blocked. | Full file browser not implemented. |
| 44.7 Codex App interop | Partial | Existing idle app-server sessions can be discovered, resumed, continued, and archived on completion. | Rollout import and Desktop GUI visibility not implemented. |
| 45 New references | Partial | Architecture reflects selected references. | No separate reference appendix in repo. |

## Exposed Button Coverage

| Button/action | Status |
| --- | --- |
| `new_task` | Done; free text in a new root message is the message-command fallback |
| `claim_sessions` | Done; `/tasks` |
| `project_list` | Done; `/projects` |
| `doctor` | Done; `/doctor` |
| `claim_thread` | Done; `/claim <codexThreadId>` |
| `task_status` | Done; `/status` in a bound task chat |
| `task_logs` | Done, event list; `/logs` |
| `task_detail` | Done; `/detail` in a bound task chat |
| `task_impact` | Done; `/impact` in a bound task chat |
| `task_restore_confirm` | Done; confirm screen before restoring checkpoint changes |
| `task_restore_apply` | Done; limited restore for fully captured small text files |
| `task_search` | Done; `/search <keyword>` |
| `task_continue` | Done; reply directly in a bound task chat |
| `task_append_hint` | Done; reply directly in a running bound task chat |
| `task_run_tests` | Done, synthetic instruction; `/run-tests` |
| `queue_view` | Done; `/queue` |
| `queue_cancel` | Done; `/queue cancel <queueId>` |
| `task_stop` | Done; `/stop` in a bound task chat |
| `task_retry` | Done, synthetic instruction; `/retry` |
| `task_analyze_failure` | Done, synthetic instruction; `/analyze-failure` |
| `task_archive` | Done; `/archive` |
| `new_related_task` | Partial, sends new-task draft; free text creates a new task |
| `approval_list` | Done; `/approval list` |
| `approval_detail` | Done; `/approval detail <approvalId>` |
| `approval_once` | Done; `/approval once <approvalId>` |
| `approval_for_task` | Done only for low-risk approvals; `/approval task <approvalId>` |
| `approval_deny` | Done; `/approval deny <approvalId>` |
| `send_test_notification` | Done; `/notify test` |
| `notification_history` | Done; `/notify history` |
| `diagnostic_recover` | Done; restarts/ensures Codex app-server, resets dead outbox, reconciles bindings, then sends diagnosis |

## Verification Snapshot

Latest local verification:

```powershell
npm run check
```

Result:

```text
build passed
tests passed
```

Latest real Feishu verification:

```text
long connection ready
/doctor ok: appServerStatus=connected, codexAvailable=true, feishuConfigured=true
HTTP callback endpoint under long_connection: 409 disabled
group /codex without @ -> one Codex 控制台 interactive card reply
direct group free text -> dedicated task chat creation + persisted chat binding + Codex turn start
incoming_messages row recorded for the latest message with deliveries=1
```

Operational caveat: do not run `lark-cli event +subscribe` alongside the bridge for the same app during normal operation, because Feishu can split long-connection events between consumers.

## Next Implementation Priorities

1. Verify live dedicated-chat creation and card callbacks again after every Feishu app publish/scope change.
2. Runtime schema validation using generated app-server schema/types.
3. Project discovery UI beyond current config/unclassified assignment flows.
4. Feishu pairing/trusted device first-run UX.
5. Rollout/session import and Desktop-origin live mirror.
6. Desktop-owner and multi-machine advanced flows.
7. True P2 Desktop owner routing and deep link support.
