import { DatabaseSync } from "node:sqlite";

export class BridgeDatabase {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  migrate(): void {
    this.db.exec(schemaSql);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}

const schemaSql = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  git_repo_root TEXT,
  git_remote TEXT,
  default_branch TEXT,
  default_model TEXT,
  approval_policy TEXT,
  sandbox_policy TEXT,
  feishu_chat_id TEXT,
  notification_policy TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  codex_thread_id TEXT NOT NULL,
  feishu_chat_id TEXT NOT NULL,
  feishu_topic_root_message_id TEXT NOT NULL,
  feishu_thread_id TEXT,
  title TEXT,
  cwd TEXT,
  git_repo_root TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL,
  last_turn_id TEXT,
  last_event_cursor TEXT,
  created_by_feishu_user_id TEXT,
  created_from TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(codex_thread_id),
  UNIQUE(feishu_chat_id, feishu_topic_root_message_id)
);

CREATE TABLE IF NOT EXISTS task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_binding_id TEXT NOT NULL,
  codex_thread_id TEXT NOT NULL,
  codex_turn_id TEXT,
  event_type TEXT NOT NULL,
  event_payload_json TEXT,
  feishu_message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_binding_seq ON task_events(session_binding_id, seq);
CREATE INDEX IF NOT EXISTS idx_task_events_thread ON task_events(codex_thread_id);

CREATE TABLE IF NOT EXISTS incoming_messages (
  feishu_message_id TEXT PRIMARY KEY,
  feishu_chat_id TEXT NOT NULL,
  feishu_user_id TEXT,
  text_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  deliveries INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_incoming_messages_chat_seen ON incoming_messages(feishu_chat_id, last_seen_at);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  session_binding_id TEXT NOT NULL,
  codex_thread_id TEXT NOT NULL,
  codex_turn_id TEXT,
  request_id TEXT NOT NULL,
  item_id TEXT,
  approval_type TEXT NOT NULL,
  command TEXT,
  file_paths_json TEXT,
  reason TEXT,
  risk_level TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL,
  feishu_card_message_id TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_feishu_user_id TEXT,
  UNIQUE(codex_thread_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_binding ON pending_approvals(session_binding_id, status);

CREATE TABLE IF NOT EXISTS action_requests (
  action_id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  requested_by_feishu_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_queue (
  id TEXT PRIMARY KEY,
  session_binding_id TEXT NOT NULL,
  feishu_message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_by_feishu_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  failed_at TEXT,
  error TEXT,
  UNIQUE(feishu_message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_queue_binding ON message_queue(session_binding_id, status, position);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  session_binding_id TEXT,
  event_seq INTEGER,
  notification_type TEXT NOT NULL,
  feishu_chat_id TEXT NOT NULL,
  feishu_topic_root_message_id TEXT,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  feishu_user_id TEXT,
  level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope_type, scope_id, feishu_user_id)
);

CREATE TABLE IF NOT EXISTS bridge_devices (
  id TEXT PRIMARY KEY,
  machine_name TEXT NOT NULL,
  device_public_key TEXT,
  device_private_key_ref TEXT,
  codex_home TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trusted_feishu_subjects (
  id TEXT PRIMARY KEY,
  tenant_key TEXT,
  chat_id TEXT,
  user_id TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  paired_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trusted_subjects_user ON trusted_feishu_subjects(user_id, status);
CREATE INDEX IF NOT EXISTS idx_trusted_subjects_chat ON trusted_feishu_subjects(chat_id, status);

CREATE TABLE IF NOT EXISTS thread_ownership (
  codex_thread_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_client_id TEXT,
  observed_at TEXT NOT NULL,
  confidence TEXT NOT NULL
);
`;
