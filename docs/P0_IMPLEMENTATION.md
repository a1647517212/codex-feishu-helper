# P0 Implementation Notes

## Language Choice

The bridge is implemented in TypeScript on Node.js 22.

Reasons:

- Codex `app-server` uses JSON-RPC over JSONL/WebSocket, which maps naturally to Node streams and TypeScript types.
- Feishu server APIs and card payloads are JSON-first.
- Node 22 provides built-in `node:sqlite`, so the bridge can use durable SQLite state without an extra native dependency.
- Windows deployment stays simple: install Node, run `npm install`, then run the bridge.

## Implemented P0 Components

- `CodexClient`: connects to Codex app-server, preferring `codex app-server proxy` in auto mode and falling back to standalone `codex app-server`; performs `initialize` and `initialized`, wraps thread and turn APIs, captures notifications and server approval requests.
- `FeishuClient`: sends Feishu text messages, replies, cards, and card updates through Feishu OpenAPI.
- `FeishuEventParser`: parses URL verification, message events, and card action callbacks.
- `FeishuLongConnectionServer`: receives Feishu message events and, when enabled, card action callbacks through the official long-connection SDK path.
- `Repository`: owns SQLite tables for projects, session bindings, events, approvals, idempotent actions, incoming message dedupe, message queue, outbox, trusted subjects, device state, and ownership.
- `TaskService`: maps Feishu task-chat messages to Codex thread operations, queues busy messages, records semantic events, and handles approval buttons.
- `OutboxWorker`: retries Feishu notifications with dedupe keys.
- `ProjectionBuilder`: builds Feishu task status cards from semantic events and database state.
- `DiagnosticsService`: reports Codex availability, app-server status, database path, counts, and last error.
- `BridgeHttpServer`: exposes `/healthz`, `/readyz`, `/doctor`, `/console-card`, plus `/feishu/events` and `/feishu/card` when the corresponding message or card callback transport is explicitly set to HTTP fallback.

## Local Verification

Verified on Windows with Node `v22.14.0` and Codex Desktop CLI `0.124.0`.

Commands:

```powershell
npm run check
npm run doctor
npm run build
node dist/src/main.js serve
```

Smoke endpoints:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/doctor -Headers @{ Authorization = "Bearer <token>" }
Invoke-WebRequest http://127.0.0.1:8787/feishu/events -Method Post -ContentType "application/json" -Body '{"type":"url_verification","challenge":"blocked"}'
```

Observed smoke result:

```json
{"health":true,"doctor":true,"appServer":"connected","httpFallbackDisabled":409}
```

## Second-Pass Acceptance Review

Reviewed against `FEISHU_CODEX_CONTROL_DESIGN.md` P0 and section 44 acceptance items. The implementation now includes these extra hardening points:

- `thread/list` uses cursor pagination with bounded page size and the app-server `updated_at` sort key.
- Persisted session bindings are reconciled with `thread/read` during bootstrap, so a restarted bridge can correct stale running or idle status.
- Busy task-chat replies are retained in `message_queue`; users can open a queue card and cancel individual queued messages.
- The next queued message is delivered automatically after the current turn completes.
- Malformed Codex notifications are recorded as `protocol.validation_failed` semantic events instead of disappearing into logs only.
- Completed-turn notification outbox entries use turn-level dedupe keys.
- Incoming Feishu messages are deduped by `message_id`, so long-connection retries do not duplicate control cards or create duplicate Codex turns.
- Project path checks block path traversal and absolute or nested secret files such as `.env`.
- HTTP smoke coverage is part of `npm run check`, including `/healthz`, authenticated `/doctor`, and Feishu URL verification.
- Long-connection and HTTP callback parsers both cover the v2 card action shape where `action` and `context` are nested under `event`.
- Message events and card callbacks can now use different transports, so tenants that only fail on card callbacks do not need to move normal message handling off long connection.
- Local-only deployments can bypass card callbacks entirely through message-command mode. Cards render explicit commands for claim, status, logs, queue, approval, retry, stop, and archive operations; the command path reuses the same `TaskService` action dispatcher as card buttons.
- New task flow defaults to one dedicated Feishu task chat per Codex thread. The main group stays as the control console; topic mode remains a fallback.
- Completed turns now send a clean Feishu result message with `处理摘要` and `最终结论`. The extraction path uses `thread/read`, completed items, and streamed agent/plan/reasoning deltas as fallbacks.

Latest verification:

```powershell
npm run check
```

Result:

```text
check passed
```

## First Real Feishu Setup

1. Create or reuse a Feishu enterprise self-built app.
2. Enable the bot and add it to the target group.
3. Configure Events subscription mode to long connection for message events.
4. Subscribe to `im.message.receive_v1`.
5. Grant message receive/send/reply permissions. Enable the permission that lets the bot receive all group messages if it should work without `@`.
6. Grant `im:chat:create`, `im:chat:update`, and `im:chat.members:write_only` so the bridge can create and rename one dedicated task chat per task.
7. If you also want interactive buttons, subscribe to the newer callback `card.action.trigger`. Prefer long connection for this callback and use `interactionMode=hybrid`; only configure a public HTTPS card callback URL when the tenant requires HTTP callback fallback.
8. For HTTP callback fallback, configure only the URLs you actually use:
   - Event callback: `https://<public-url>/feishu/events`
   - Card callback: `https://<public-url>/feishu/card`
9. Fill `~/.feishu-codex/config.json` from `config.example.json`.
10. Set `allowedUserIds` and `allowedChatIds`.
11. Start the bridge with `npm run start`.
12. In the allowed chat, send `/codex` or `/tasks`.

## Real Feishu Verification Snapshot

Verified with the bot in group `codex-ep` using long connection:

- `/doctor` returned `appServerStatus=connected`, `codexAvailable=true`, `feishuConfigured=true`.
- Posting `/codex` without `@` produced a `Codex 控制台` interactive card reply in the group.
- `POST /feishu/events` returned `409` in long-connection mode, confirming HTTP callback fallback is disabled by default.
- After waiting for long-connection retry windows, the latest `/codex` delivery produced one card and one `incoming_messages` row.
- A temporary `lark-cli event +subscribe` process was confirmed to split events away from the bridge; only one long-connection consumer should run for this app in normal operation.
- New threads now default to `gpt-5.4`, `xhigh`, `danger-full-access`, and `approvalPolicy=never`.
- New tasks default to dedicated Feishu task chats; topic mode is fallback-only.
- Task completion messages and claim summaries no longer echo raw PowerShell or shell command text back into Feishu.
- Sub-agent spawn/wait records are projected into Feishu status/progress/detail/result cards, including requested model and reasoning effort when Codex exposes them.
- Task title changes are also sent to `thread/name/set`, so Codex persisted thread titles stay aligned with Feishu task titles.

## Current Boundaries

- Long connection is still the default for messages and newer card callbacks; message-command mode remains the local-only fallback.
- Card button callbacks require the Feishu app to subscribe to the newer `card.action.trigger` callback. Prefer long connection for this callback. If the bridge never records `lastFeishuCardActionAt`, the failing path is before `TaskService`; verify the Feishu callback subscription first, then fall back to message commands or add a public callback/relay only if the tenant requires HTTP callbacks.
- Desktop owner IPC routing is intentionally not implemented in P0.
- Desktop live refresh is best-effort. In `codex.connectionMode=auto`, the bridge first tries `codex app-server proxy` so it can share the running Desktop app-server and receive the same live notifications. If the Desktop control socket is unavailable, it falls back to a standalone app-server; Feishu remains live, while the Desktop UI may only show persisted updates after its own refresh/restart.
- High-risk approvals do not expose a task-wide trust button.
- Full local detail pages for large content are reserved for P2.
