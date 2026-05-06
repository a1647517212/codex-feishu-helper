# codex-feishu

`codex-feishu` is a local bridge that lets Feishu messages and cards control local Codex `app-server` threads. It is designed for the session-level workflow described in `FEISHU_CODEX_CONTROL_DESIGN.md`: projects contain Codex tasks, and each task is represented by a Feishu topic/root message.

The first implementation uses TypeScript on Node.js 22 with the built-in `node:sqlite` module. That keeps the Windows install path simple while still giving the bridge durable state for task bindings, queues, approvals, and notification retry.

Design coverage is tracked in [docs/FULL_DESIGN_COVERAGE.md](docs/FULL_DESIGN_COVERAGE.md). It compares every section of `FEISHU_CODEX_CONTROL_DESIGN.md` against the current implementation, including unfinished P1/P2 work.

## P0 Scope

- Feishu long-connection message transport by default.
- Button-first hybrid interaction by default: cards render buttons and also show equivalent commands.
- Card actions use Feishu long connection by default through the newer `card.action.trigger` callback event; HTTP callback remains an optional fallback when a public endpoint is available.
- Local Codex `app-server` JSONL transport over stdio.
- `thread/list`, `thread/read`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt` wrappers.
- SQLite tables for projects, session bindings, semantic events, pending approvals, idempotent actions, incoming message dedupe, message queue, notification outbox, trusted Feishu subjects, and device state.
- SQLite-backed incoming message dedupe for Feishu long-connection retries.
- Semantic event store and projection builder so Feishu cards are based on bridge events instead of raw Codex payloads.
- Busy message queue so topic replies are not lost while a task is running.
- Approval request capture and Feishu approval card generation.
- Notification outbox with dedupe and retry.
- Diagnostics endpoint and Feishu diagnostic card.
- Safe project path checks and basic Git status/diff summary helpers.

## Quick Start

```powershell
npm install
npm run build
npm test
npm run generate:codex-schema
npm run doctor
```

Create a config:

```powershell
copy .\config.example.json $env:USERPROFILE\.feishu-codex\config.json
notepad $env:USERPROFILE\.feishu-codex\config.json
```

Start the bridge:

```powershell
npm run start
```

The default Feishu control path is long-connection group messages plus long-connection card actions. Keep the local HTTP server on `127.0.0.1`; it is used for health, diagnostics, and optional HTTP fallback, not as the primary Feishu entry point.

Card button callbacks do not require exposing the local machine when the Feishu app uses the newer `card.action.trigger` callback event in long-connection mode. If a tenant is still wired to the older card callback path that only supports HTTP callback URLs, switch `feishu.interactionMode` to `message_command`, or set `feishu.cardActionTransport` to `http_callback` and expose only `/feishu/card` through a public relay/tunnel.

Expose these endpoints only when the matching transport is `http_callback`:

- `POST /feishu/events`
- `POST /feishu/card`
- `GET /healthz`
- `GET /doctor`

For local testing, use `FEISHU_CODEX_ADMIN_TOKEN` and call:

```powershell
curl http://127.0.0.1:8787/doctor -H "authorization: Bearer <token>"
```

## Feishu App Setup

In the Feishu developer console:

- Enable the bot and add it to the target group.
- Set Events and Callbacks subscription mode to long connection if both messages and newer card callbacks should enter by WebSocket.
- Subscribe to `im.message.receive_v1`.
- Subscribe to the newer card callback `card.action.trigger` for interactive card buttons. Choose long connection for this callback when available.
- Enable the permission to receive all group messages, so the bot can read group messages without `@`.
- Grant message send/reply/card scopes needed by `im/v1/messages` APIs.
- Grant `im:chat:readonly` or equivalent chat read scope if you want to search or verify group information by API.
- If event encryption is enabled in the app, set `feishu.encryptKey`; otherwise keep encryption disabled while using the bridge.
- If card clicks show a Feishu-side error and `/doctor` never records `lastFeishuCardActionAt`, first confirm the app subscribes to the newer `card.action.trigger` callback with long connection. If the tenant only supports HTTP callbacks for cards, either leave `feishu.interactionMode` as `message_command` or configure a public relay/tunnel for `https://<public-url>/feishu/card`, set `feishu.cardActionTransport` to `http_callback`, and keep `feishu.interactionMode` as `hybrid`.

Operational notes:

- Do not run another `lark-cli event +subscribe` or a second bridge instance for the same app unless you are intentionally load-balancing. Feishu can split long-connection events between consumers, which makes one process appear to miss messages.
- In mixed mode, `/feishu/events` or `/feishu/card` return `409` only for the transport that is still set to long connection.

## Feishu Commands

Inside the allowed Feishu chat:

- `/codex` shows the control console.
- `/doctor` returns bridge diagnostics.
- `/tasks` lists recent local Codex sessions that can be claimed.
- `/claim <codexThreadId>` binds an existing local Codex thread to the current Feishu topic.
- `/projects` shows configured projects.
- `/notify test` sends a test notification; `/notify history` shows notification history.
- Any reply inside a bound task topic continues that Codex task.
- Inside a bound task topic, `/status`, `/logs`, `/diff`, `/queue`, `/queue cancel <queueId>`, `/run-tests`, `/retry`, `/analyze-failure`, `/stop`, and `/archive` map to the same operations as the old card buttons.
- Approval cards include explicit commands: `/approval list`, `/approval detail <approvalId>`, `/approval once <approvalId>`, `/approval task <approvalId>`, and `/approval deny <approvalId>`.

## Local-Only Callback Workarounds

When the bridge must run on a private local IP with no domain, use one of these patterns:

- Long-connection hybrid mode, recommended: Feishu messages and newer card actions arrive through the bot long connection. Cards show buttons plus equivalent text commands, with no public local IP or domain required.
- Message-command mode: disable buttons and use the command text only. This is the most conservative fallback when the app cannot receive card callbacks over long connection.
- HTTP hybrid fallback: keep message commands, but expose only `/feishu/card` through a public HTTPS endpoint or tunnel when a tenant requires HTTP for cards.
- Cloud relay: deploy a tiny public relay that accepts Feishu callbacks while the local bridge maintains an outbound WebSocket or polling connection to it. This avoids exposing the local machine, but adds a small hosted component.
- Local custom protocol: use URL buttons such as `codex-feishu://...` on Feishu Desktop. This is Windows-desktop-only and less reliable across web/mobile clients.
- Polling/search fallback: have the local bridge poll message history through OpenAPI. This avoids event delivery but needs extra message-history permissions and is slower than long connection.

## Security Notes

- Configure both `allowedUserIds` and `allowedChatIds` before using this outside a private test chat.
- Do not expose `codex app-server` directly to a non-loopback network address.
- This bridge starts Codex through stdio and keeps Feishu-facing HTTP as the only inbound control surface.
- High-risk command approvals intentionally do not expose a "trust for task" button.
