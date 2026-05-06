# Full Design Coverage Matrix

Source: `C:\Users\EPEANZ\Documents\Playground\FEISHU_CODEX_CONTROL_DESIGN.md`

Legend:

- Done: implemented with code and at least one verification path.
- Partial: core shape exists, but behavior is incomplete, simplified, or not end-to-end verified.
- Not started: no meaningful implementation yet.
- Deferred: explicitly outside current implementation scope.

## Executive Status

The project currently implements the main P0 bridge kernel: Feishu long-connection message transport by default, message-command interaction for local-only deployments, optional HTTP callback fallback, Codex app-server stdio transport, SQLite persistence, session binding, semantic events, projections, queueing, approvals, outbox retry, diagnostics, incoming-message dedupe, and basic safety controls.

It does not yet implement the full product described by the design. The biggest remaining gaps are real Feishu topic creation semantics, full project discovery and unclassified-task management, notification preferences, local detail pages, checkpointing, Desktop owner routing, live mirror/import, deep links, multi-machine support, team permissions, and commit/push/PR workflows.

Approximate coverage by layer:

| Layer | Coverage |
| --- | --- |
| P0 bridge kernel | High |
| P0 real Feishu workflow | Medium |
| P1 experience enhancements | Low to medium |
| P2 advanced product capabilities | Low |
| Whole design document | Medium |

## Section Coverage

| Design section | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| 1 Background and goal | Partial | Bridge controls Codex app-server threads from Feishu messages/cards. Real long-connection `/codex` in group was verified without `@`. | Full goal says mature notifications and richer task lifecycle; advanced pieces remain incomplete. |
| 2 Core conclusion | Partial | One Codex thread maps to one Feishu root/topic binding in `session_bindings`. | Explicit Feishu topic API creation is not implemented. |
| 3 Design boundary | Partial | Uses app-server and accepts eventual sync. | Desktop GUI mirror, owner routing, and true active-turn semantics are not implemented. |
| 4 Terminology and wording | Partial | Cards use Chinese task/control wording. | Wording is not fully audited against every suggested/forbidden phrase. |
| 5 Product information architecture | Partial | Console card, project list card, task status card, approval card exist. | Full hierarchy and topic lifecycle are simplified. |
| 6.1 New task from Feishu | Partial | New free-text message starts a Codex thread and turn. | New-task button sends a draft card, but does not create a true Feishu topic via topic API. |
| 6.2 Claim existing Codex App task | Partial | `/tasks`, `/claim <threadId>`, and optional `[在飞书继续]` list/read/bind existing app-server threads. | Grouping by project and real Codex Desktop session fidelity are limited to app-server visibility. |
| 6.3 Continue in task topic | Done | `findBindingByTopic`, `resumeThread`, `startTurn`, busy queue. | More nuanced `turn/steer` during active turns is not exposed separately. |
| 6.4 Completion notification | Done | `turn/completed` inserts events and enqueues outbox card. | Notification preferences are not applied yet. |
| 6.5 Approval handling | Partial | Server approval request is persisted, carded, and resolved idempotently. | Expired approval UX and rich details are still basic. |
| 7 Card and copy design | Partial | Console, new task, claim list, task status, approval, queue, diagnostics, history cards exist. | Failure card, unclassified card, checkpoint card, and full visual polish are not complete. |
| 8 Button behavior | Partial | Button actions are idempotent through `action_requests`; visible buttons have handlers; every exposed action now has a message-command fallback; v2 card action parsing is covered for HTTP fallback. | Button danger levels are simple; some actions are helper replies rather than full flows. Real card click still depends on `card.action.trigger` callback setup and public reachability. |
| 9 Project abstraction and mapping | Partial | Configured projects are stored; cwd prefix maps to project. | Auto discovery, Git root matching details, unclassified assignment, and create-project-from-Feishu are missing. |
| 10 Data model | Partial | Tables exist for projects, bindings, events, approvals, actions, incoming messages, queue, outbox, prefs, devices, trusted subjects, ownership. | Some tables are schema-only and not yet used by workflows. |
| 11 State machine | Partial | Core statuses are modeled and updated. | Full status/button matrix and expired/archived semantics are simplified. |
| 12 Backend architecture | Done | App composition includes config, DB, repo, Codex client, Feishu client, task service, outbox, diagnostics, HTTP server. | Production packaging/service install is not included. |
| 13 Codex app-server integration | Partial | Stdio JSONL client, initialize, thread/turn methods, notifications, server requests. | Full official runtime schema validation and all event types are not wired. |
| 14 Feishu integration | Partial | Long connection is default for messages; message commands cover local-only controls; HTTP callback is optional fallback for cards; message parsing, card action parsing, send/reply/update APIs exist. | Explicit Feishu topic creation remains missing; card button runtime requires app-side `card.action.trigger` subscription and public HTTPS reachability. |
| 15 Notification strategy | Partial | Completion/failure/approval/status outbox and retry exist. | @ user policy and notification preference execution are missing. |
| 16 Change and log display | Partial | Git status summary, event/log cards, task status cards. | Full diff view, large output paging, command logs, and file details are missing. |
| 17 Security and permissions | Partial | Allowed users/chats, path escape block, secret file block, no high-risk task-wide approval. | Pairing, trusted-device workflow, and per-role permissions are not active. |
| 18 Error handling | Partial | HTTP errors, app-server diagnostic status, protocol validation event, idempotent actions. | Expired approval and unavailable app-server recovery cards are basic. |
| 19 MVP phase 1 | Partial | Main loop works in code/tests and real Feishu long-connection `/codex` group flow was verified. | Real Feishu topic creation and deeper Codex task execution flows remain incomplete. |
| 19 MVP phase 2 | Partial | Queue view/cancel, task diff/status/log helpers exist. | Notification preferences, richer diff, and completion impact are incomplete. |
| 19 MVP phase 3 | Not started | No team workflow implementation beyond schema placeholders. | Team permissions, multi-user operations, advanced controls. |
| 20 Development task split | Partial | Infrastructure, Codex, Feishu, flows, security are partially implemented. | Remaining split tasks map to gaps above. |
| 21 API pseudocode | Partial | Claim, continue, and new-task flows map to `TaskService`. | Topic creation and richer API boundaries are simplified. |
| 22 Config example | Done | `config.example.json`, `.env.example`, `loadConfig`. | Installer/setup wizard not included. |
| 23.1 New task acceptance | Partial | Feishu text can start Codex and update card; incoming message dedupe prevents duplicate turns on retry. | True topic creation and real file/Git verification are not automated end-to-end. |
| 23.2 Claim acceptance | Partial | Claim existing thread and continue same thread are covered by tests. | Project-grouped list and true topic creation remain. |
| 23.3 Project mapping acceptance | Partial | Config path prefix mapping exists. | Git root matching, unclassified list, assign/create project buttons missing. |
| 23.4 Notification acceptance | Partial | Completion/failure/approval outbox exists; progress is not spammed. | @ creator and preference logic missing. |
| 23.5 Idempotency acceptance | Done | Action request idempotency, approval idempotency, outbox dedupe, and incoming Feishu message dedupe. | User-facing old-button text can be improved. |
| 24 Risks and open questions | Partial | Major risks documented as current boundaries; live Feishu long-connection message flow was verified; card-callback risk is bypassed by message-command mode. | Desktop validation and advanced Feishu topic/card-click flows still need more live coverage. |
| 25 Recommended tech route | Done | TypeScript + Node 22 + SQLite + app-server. | Windows service packaging still absent. |
| 26 Development order | Partial | P0 core completed first. | Later-order items remain open. |
| 27 References | Partial | Design-driven implementation; generated schema present. | Reference licenses and upstream detail review not bundled in repo docs. |
| 28 Open-source absorption upgrade | Partial | App-server, queue, outbox, semantic events absorbed. | QR pairing, full live mirror, details pages not absorbed. |
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
| 34.5 Refresh/deep link | Not started | No refresh/deep-link implementation. | Needs app integration support. |
| 35 Queue and busy handling | Done | Queue table, enqueue, view, cancel, deliver next after completion. | Optional confirm-before-delivery is not implemented. |
| 36 Approval system upgrade | Partial | Pending approvals persist and route responses. | Expiry handling and richer resolved-card update remain basic. |
| 37.1 Project directory discovery | Not started | No directory scanner. | Needs project registry/discovery UI. |
| 37.2 Path safety | Done | `SecurityPolicy.resolveInsideProject`. | More file APIs are needed before broader validation. |
| 37.3 Git operation upgrade | Partial | Status and branch summary, simple diff summary. | Full diff, commit, push, PR missing. |
| 37.4 Workspace checkpoint | Not started | No checkpoint implementation. | Needs snapshot/restore policy. |
| 38.1 Outbox | Done | Durable outbox with retry and dedupe. | Dead-letter UI is basic via history only. |
| 38.2 Notification preference | Partial | Table exists. | No workflow reads preferences. |
| 38.3 Notification history | Done | Recent outbox card/action implemented. | Filtering and detail view can improve. |
| 39.1 Bridge identity | Partial | Device table exists; machine ID in config. | No keypair/bootstrap workflow. |
| 39.2 Feishu pairing | Not started | No pairing code. | Needs QR/code flow and trusted subject writes. |
| 39.3 Health card | Done | `/doctor`, diagnostics snapshot, diagnostic card. | Auto recovery suggestions can improve. |
| 40 Local detail page | Not started | No local detail page. | Needed for large output/diff. |
| 41 Buttons and copy | Partial | Exposed buttons have handlers and cards show equivalent text commands for local-only operation. | Checkpoint and some project buttons missing. |
| 42.1 P0 required | Partial | Most engineering P0 items implemented, including long connection, diagnostics, queue, outbox, approvals, and incoming dedupe. | Runtime schema validation, preferences, true topic creation still incomplete. |
| 42.2 P1 enhancements | Partial | Queue view/cancel and basic diff/history exist. | Most P1 items remain incomplete. |
| 42.3 P2 advanced | Mostly not started | P2 boundaries documented. | Desktop owner, deep link, multi-machine, PR workflows, teams. |
| 43 Updated development order | Partial | Current branch follows P0-first order. | Next phases need planned execution. |
| 44.1 Protocol compatibility | Partial | Unknown fields tolerated; missing `turn.id` records validation event. | Recovery from every bad delta through read is not exhaustive. |
| 44.2 Event recovery | Done | SQLite recovery, reconcile, monotonic seq tests. | Completed status detection from `thread/read` can be richer. |
| 44.3 Queue | Done | Three-message queue, view/cancel, auto-deliver next. | Confirm-before-delivery option absent. |
| 44.4 Approval | Partial | Idempotent approval, no high-risk task-wide button. | Old resolved button UX returns generic idempotent result. |
| 44.5 Notification | Partial | Retry and dedupe implemented; real group card response verified. | Silent task preference not enforced. |
| 44.6 Project safety | Done | Path escape and secret files blocked; Git diff helper does not read outside cwd. | Full file browser not implemented. |
| 44.7 Codex App interop | Partial | Existing idle app-server sessions can be discovered and resumed. | Rollout import and Desktop GUI visibility not implemented. |
| 45 New references | Partial | Architecture reflects selected references. | No separate reference appendix in repo. |

## Exposed Button Coverage

| Button/action | Status |
| --- | --- |
| `new_task` | Done; free text in a new root message is the message-command fallback |
| `claim_sessions` | Done; `/tasks` |
| `project_list` | Done; `/projects` |
| `doctor` | Done; `/doctor` |
| `claim_thread` | Done; `/claim <codexThreadId>` |
| `task_status` | Done; `/status` in a bound topic |
| `task_diff` | Done, basic Git status summary; `/diff` |
| `task_logs` | Done, event list; `/logs` |
| `task_continue` | Done; reply directly in a bound topic |
| `task_append_hint` | Done; reply directly in a running bound topic |
| `task_run_tests` | Done, synthetic instruction; `/run-tests` |
| `queue_view` | Done; `/queue` |
| `queue_cancel` | Done; `/queue cancel <queueId>` |
| `task_stop` | Done; `/stop` in a bound topic |
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

## Verification Snapshot

Latest local verification:

```powershell
npm run check
git diff --check
```

Result:

```text
32 tests passed
no whitespace errors
```

Latest real Feishu verification:

```text
long connection ready
/doctor ok: appServerStatus=connected, codexAvailable=true, feishuConfigured=true
HTTP callback endpoint under long_connection: 409 disabled
group /codex without @ -> one Codex 控制台 interactive card reply
incoming_messages row recorded for the latest message with deliveries=1
```

Operational caveat: do not run `lark-cli event +subscribe` alongside the bridge for the same app during normal operation, because Feishu can split long-connection events between consumers.

## Next Implementation Priorities

1. Real Feishu topic creation and topic ID tracking.
2. Runtime schema validation using generated app-server schema/types.
3. Notification preference enforcement, including silent tasks.
4. Project discovery, unclassified task list, and project assignment buttons.
5. Full diff/log/detail page for large content.
6. Feishu pairing/trusted device workflow.
7. Rollout/session import and Desktop-origin live mirror.
8. Workspace checkpoint.
9. Commit/push/PR flows.
10. True P2 Desktop owner routing and deep link support.
