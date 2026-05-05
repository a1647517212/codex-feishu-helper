# codex-feishu

`codex-feishu` is a local bridge that lets Feishu messages and cards control local Codex `app-server` threads. It is designed for the session-level workflow described in `FEISHU_CODEX_CONTROL_DESIGN.md`: projects contain Codex tasks, and each task is represented by a Feishu topic/root message.

The first implementation uses TypeScript on Node.js 22 with the built-in `node:sqlite` module. That keeps the Windows install path simple while still giving the bridge durable state for task bindings, queues, approvals, and notification retry.

## P0 Scope

- Feishu HTTP event callback and card action callback.
- Local Codex `app-server` JSONL transport over stdio.
- `thread/list`, `thread/read`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt` wrappers.
- SQLite tables for projects, session bindings, semantic events, pending approvals, idempotent actions, message queue, notification outbox, trusted Feishu subjects, and device state.
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

Expose these local endpoints to Feishu Enterprise App callbacks:

- `POST /feishu/events`
- `POST /feishu/card`
- `GET /healthz`
- `GET /doctor`

For local testing, use `FEISHU_CODEX_ADMIN_TOKEN` and call:

```powershell
curl http://127.0.0.1:8787/doctor -H "authorization: Bearer <token>"
```

## Feishu Commands

Inside the allowed Feishu chat:

- `/codex` shows the control console.
- `/doctor` returns bridge diagnostics.
- `/tasks` lists recent local Codex sessions that can be claimed.
- Any reply inside a bound task topic continues that Codex task.

## Security Notes

- Configure both `allowedUserIds` and `allowedChatIds` before using this outside a private test chat.
- Do not expose `codex app-server` directly to a non-loopback network address.
- This bridge starts Codex through stdio and keeps Feishu-facing HTTP as the only inbound control surface.
- High-risk command approvals intentionally do not expose a "trust for task" button.
