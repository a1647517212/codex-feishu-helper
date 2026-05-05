# P0 Implementation Notes

## Language Choice

The bridge is implemented in TypeScript on Node.js 22.

Reasons:

- Codex `app-server` uses JSON-RPC over JSONL/WebSocket, which maps naturally to Node streams and TypeScript types.
- Feishu server APIs and card payloads are JSON-first.
- Node 22 provides built-in `node:sqlite`, so the bridge can use durable SQLite state without an extra native dependency.
- Windows deployment stays simple: install Node, run `npm install`, then run the bridge.

## Implemented P0 Components

- `CodexClient`: starts `codex app-server`, performs `initialize` and `initialized`, wraps thread and turn APIs, captures notifications and server approval requests.
- `FeishuClient`: sends Feishu text messages, replies, cards, and card updates through Feishu OpenAPI.
- `FeishuEventParser`: parses URL verification, message events, and card action callbacks.
- `Repository`: owns SQLite tables for projects, session bindings, events, approvals, idempotent actions, message queue, outbox, trusted subjects, device state, and ownership.
- `TaskService`: maps Feishu topic replies to Codex thread operations, queues busy messages, records semantic events, and handles approval buttons.
- `OutboxWorker`: retries Feishu notifications with dedupe keys.
- `ProjectionBuilder`: builds Feishu task status cards from semantic events and database state.
- `DiagnosticsService`: reports Codex availability, app-server status, database path, counts, and last error.
- `BridgeHttpServer`: exposes `/feishu/events`, `/feishu/card`, `/healthz`, `/readyz`, `/doctor`, and `/console-card`.

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
Invoke-RestMethod http://127.0.0.1:8787/feishu/events -Method Post -ContentType "application/json" -Body '{"type":"url_verification","challenge":"ok-smoke"}'
```

Observed smoke result:

```json
{"health":true,"doctor":true,"appServer":"connected","verify":"ok-smoke"}
```

## Second-Pass Acceptance Review

Reviewed against `FEISHU_CODEX_CONTROL_DESIGN.md` P0 and section 44 acceptance items. The implementation now includes these extra hardening points:

- `thread/list` uses cursor pagination with bounded page size and the app-server `updated_at` sort key.
- Persisted session bindings are reconciled with `thread/read` during bootstrap, so a restarted bridge can correct stale running or idle status.
- Busy topic replies are retained in `message_queue`; users can open a queue card and cancel individual queued messages.
- The next queued message is delivered automatically after the current turn completes.
- Malformed Codex notifications are recorded as `protocol.validation_failed` semantic events instead of disappearing into logs only.
- Completed-turn notification outbox entries use turn-level dedupe keys.
- Project path checks block path traversal and absolute or nested secret files such as `.env`.
- HTTP smoke coverage is part of `npm run check`, including `/healthz`, authenticated `/doctor`, and Feishu URL verification.

Latest verification:

```powershell
npm run check
git diff --check
```

Result:

```text
14 tests passed
no whitespace errors
```

## First Real Feishu Setup

1. Create or reuse a Feishu enterprise self-built app.
2. Grant message receive/send and card callback permissions.
3. Configure callback URL:
   - Event callback: `https://<public-url>/feishu/events`
   - Card callback: `https://<public-url>/feishu/card`
4. Fill `~/.feishu-codex/config.json` from `config.example.json`.
5. Set `allowedUserIds` and `allowedChatIds`.
6. Start the bridge with `npm run start`.
7. In the allowed chat, send `/codex` or `/tasks`.

## Current Boundaries

- HTTP callback mode is implemented first. Feishu long-connection can be added behind the same `TaskService` later.
- Desktop owner IPC routing is intentionally not implemented in P0.
- The bridge does not mirror the Codex App GUI. It controls persisted Codex sessions through `app-server`.
- High-risk approvals do not expose a task-wide trust button.
- Full local diff/detail pages are reserved for P2.
