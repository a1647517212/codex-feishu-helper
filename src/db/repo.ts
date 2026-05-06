import type { StatementSync } from "node:sqlite";
import { newId } from "../core/ids.js";
import { asString, parseJsonArray, parseJsonObject, stringifyJson } from "../core/json.js";
import { nowIso, plusMsIso } from "../core/time.js";
import type {
  ActionRequest,
  ActionStatus,
  ApprovalStatus,
  CreatedFrom,
  NotificationOutboxItem,
  NotificationType,
  OutboxStatus,
  PendingApproval,
  Project,
  QueuedMessage,
  QueueStatus,
  SessionBinding,
  TaskEvent,
  TaskStatus
} from "../core/types.js";
import type { BridgeDatabase } from "./database.js";

type DbRow = Record<string, unknown>;

export class Repository {
  constructor(private readonly database: BridgeDatabase) {}

  upsertProject(input: {
    id?: string;
    name: string;
    rootPath: string;
    feishuChatId?: string | null;
    defaultModel?: string | null;
    approvalPolicy?: string | null;
    sandboxPolicy?: string | null;
  }): Project {
    const now = nowIso();
    const id = input.id ?? newId("proj");
    this.database.db
      .prepare(
        `INSERT INTO projects (
          id, name, root_path, default_model, approval_policy, sandbox_policy,
          feishu_chat_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          default_model = excluded.default_model,
          approval_policy = excluded.approval_policy,
          sandbox_policy = excluded.sandbox_policy,
          feishu_chat_id = excluded.feishu_chat_id,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.name,
        input.rootPath,
        input.defaultModel ?? null,
        input.approvalPolicy ?? null,
        input.sandboxPolicy ?? null,
        input.feishuChatId ?? null,
        now,
        now
      );
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const row = this.database.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapProject(row) : null;
  }

  listProjects(): Project[] {
    return this.database.db
      .prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY updated_at DESC")
      .all()
      .map((row) => mapProject(row as DbRow));
  }

  findProjectForPath(cwd: string | null | undefined): Project | null {
    if (!cwd) return null;
    const normalized = cwd.toLowerCase();
    return (
      this.listProjects().find((project) => {
        const root = project.rootPath.toLowerCase();
        return normalized === root || normalized.startsWith(`${root}\\`) || normalized.startsWith(`${root}/`);
      }) ?? null
    );
  }

  createOrUpdateBinding(input: {
    projectId?: string | null;
    codexThreadId: string;
    feishuChatId: string;
    feishuTopicRootMessageId: string;
    feishuThreadId?: string | null;
    title?: string | null;
    cwd?: string | null;
    gitRepoRoot?: string | null;
    branchName?: string | null;
    worktreePath?: string | null;
    status?: TaskStatus;
    createdByFeishuUserId?: string | null;
    createdFrom: CreatedFrom;
  }): SessionBinding {
    const now = nowIso();
    const id = newId("bind");
    this.database.db
      .prepare(
        `INSERT INTO session_bindings (
          id, project_id, codex_thread_id, feishu_chat_id, feishu_topic_root_message_id,
          feishu_thread_id, title, cwd, git_repo_root, branch_name, worktree_path, status,
          last_turn_id, last_event_cursor, created_by_feishu_user_id, created_from, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(codex_thread_id) DO UPDATE SET
          project_id = COALESCE(excluded.project_id, session_bindings.project_id),
          feishu_chat_id = excluded.feishu_chat_id,
          feishu_topic_root_message_id = excluded.feishu_topic_root_message_id,
          feishu_thread_id = excluded.feishu_thread_id,
          title = COALESCE(excluded.title, session_bindings.title),
          cwd = COALESCE(excluded.cwd, session_bindings.cwd),
          git_repo_root = COALESCE(excluded.git_repo_root, session_bindings.git_repo_root),
          branch_name = COALESCE(excluded.branch_name, session_bindings.branch_name),
          worktree_path = COALESCE(excluded.worktree_path, session_bindings.worktree_path),
          status = excluded.status,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.projectId ?? null,
        input.codexThreadId,
        input.feishuChatId,
        input.feishuTopicRootMessageId,
        input.feishuThreadId ?? null,
        input.title ?? null,
        input.cwd ?? null,
        input.gitRepoRoot ?? null,
        input.branchName ?? null,
        input.worktreePath ?? null,
        input.status ?? "idle",
        input.createdByFeishuUserId ?? null,
        input.createdFrom,
        now,
        now
      );
    return this.findBindingByThreadId(input.codexThreadId)!;
  }

  updateBindingStatus(bindingId: string, status: TaskStatus, lastTurnId?: string | null): void {
    this.database.db
      .prepare(
        `UPDATE session_bindings
         SET status = ?, last_turn_id = COALESCE(?, last_turn_id), updated_at = ?
         WHERE id = ?`
      )
      .run(status, lastTurnId ?? null, nowIso(), bindingId);
  }

  findBindingById(id: string): SessionBinding | null {
    const row = this.database.db.prepare("SELECT * FROM session_bindings WHERE id = ?").get(id) as
      | DbRow
      | undefined;
    return row ? mapBinding(row) : null;
  }

  findBindingByThreadId(threadId: string): SessionBinding | null {
    const row = this.database.db.prepare("SELECT * FROM session_bindings WHERE codex_thread_id = ?").get(threadId) as
      | DbRow
      | undefined;
    return row ? mapBinding(row) : null;
  }

  findBindingByTopic(chatId: string, rootMessageId: string): SessionBinding | null {
    const row = this.database.db
      .prepare("SELECT * FROM session_bindings WHERE feishu_chat_id = ? AND feishu_topic_root_message_id = ?")
      .get(chatId, rootMessageId) as DbRow | undefined;
    return row ? mapBinding(row) : null;
  }

  listBindings(limit = 50): SessionBinding[] {
    return this.database.db
      .prepare("SELECT * FROM session_bindings ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapBinding(row as DbRow));
  }

  insertEvent(input: {
    sessionBindingId: string;
    codexThreadId: string;
    codexTurnId?: string | null;
    eventType: string;
    eventPayload?: Record<string, unknown>;
    feishuMessageId?: string | null;
  }): TaskEvent {
    const id = newId("evt");
    this.database.db
      .prepare(
        `INSERT INTO task_events (
          id, session_binding_id, codex_thread_id, codex_turn_id, event_type,
          event_payload_json, feishu_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionBindingId,
        input.codexThreadId,
        input.codexTurnId ?? null,
        input.eventType,
        stringifyJson(input.eventPayload ?? {}),
        input.feishuMessageId ?? null,
        nowIso()
      );
    const row = this.database.db.prepare("SELECT * FROM task_events WHERE id = ?").get(id) as DbRow;
    return mapEvent(row);
  }

  listEventsForBinding(bindingId: string, limit = 200): TaskEvent[] {
    return this.database.db
      .prepare("SELECT * FROM task_events WHERE session_binding_id = ? ORDER BY seq DESC LIMIT ?")
      .all(bindingId, limit)
      .reverse()
      .map((row) => mapEvent(row as DbRow));
  }

  beginIncomingMessage(input: {
    messageId: string;
    chatId: string;
    userId?: string | null;
    text: string;
  }): { duplicate: boolean; deliveries: number } {
    const now = nowIso();
    const existing = this.database.db
      .prepare("SELECT deliveries FROM incoming_messages WHERE feishu_message_id = ?")
      .get(input.messageId) as { deliveries?: number } | undefined;
    if (existing) {
      const deliveries = Number(existing.deliveries ?? 1) + 1;
      this.database.db
        .prepare("UPDATE incoming_messages SET last_seen_at = ?, deliveries = ? WHERE feishu_message_id = ?")
        .run(now, deliveries, input.messageId);
      return { duplicate: true, deliveries };
    }
    this.database.db
      .prepare(
        `INSERT INTO incoming_messages (
          feishu_message_id, feishu_chat_id, feishu_user_id, text_hash,
          first_seen_at, last_seen_at, deliveries
        ) VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run(input.messageId, input.chatId, input.userId ?? null, hashText(input.text), now, now);
    return { duplicate: false, deliveries: 1 };
  }

  beginAction(input: {
    actionId: string;
    actionType: string;
    payload: Record<string, unknown>;
    requestedByFeishuUserId?: string | null;
  }): { existing: ActionRequest | null; action: ActionRequest } {
    const existing = this.findAction(input.actionId);
    if (existing) return { existing, action: existing };
    const now = nowIso();
    this.database.db
      .prepare(
        `INSERT INTO action_requests (
          action_id, action_type, payload_json, status, result_json,
          requested_by_feishu_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'processing', NULL, ?, ?, ?)`
      )
      .run(
        input.actionId,
        input.actionType,
        stringifyJson(input.payload),
        input.requestedByFeishuUserId ?? null,
        now,
        now
      );
    return { existing: null, action: this.findAction(input.actionId)! };
  }

  completeAction(actionId: string, result: Record<string, unknown>): void {
    this.updateAction(actionId, "completed", result);
  }

  failAction(actionId: string, result: Record<string, unknown>): void {
    this.updateAction(actionId, "failed", result);
  }

  findAction(actionId: string): ActionRequest | null {
    const row = this.database.db.prepare("SELECT * FROM action_requests WHERE action_id = ?").get(actionId) as
      | DbRow
      | undefined;
    return row ? mapAction(row) : null;
  }

  enqueueMessage(input: {
    sessionBindingId: string;
    feishuMessageId: string;
    text: string;
    createdByFeishuUserId: string;
  }): QueuedMessage {
    const existing = this.database.db
      .prepare("SELECT * FROM message_queue WHERE feishu_message_id = ?")
      .get(input.feishuMessageId) as DbRow | undefined;
    if (existing) return mapQueuedMessage(existing);
    const row = this.database.db
      .prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM message_queue WHERE session_binding_id = ?")
      .get(input.sessionBindingId) as { max_position?: number };
    const position = Number(row.max_position ?? 0) + 1;
    const id = newId("queue");
    this.database.db
      .prepare(
        `INSERT INTO message_queue (
          id, session_binding_id, feishu_message_id, text, status, position,
          created_by_feishu_user_id, created_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`
      )
      .run(id, input.sessionBindingId, input.feishuMessageId, input.text, position, input.createdByFeishuUserId, nowIso());
    return this.getQueuedMessage(id)!;
  }

  getQueuedMessage(id: string): QueuedMessage | null {
    const row = this.database.db.prepare("SELECT * FROM message_queue WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapQueuedMessage(row) : null;
  }

  listQueuedMessages(bindingId: string, status: QueueStatus = "queued"): QueuedMessage[] {
    return this.database.db
      .prepare(
        "SELECT * FROM message_queue WHERE session_binding_id = ? AND status = ? ORDER BY position ASC"
      )
      .all(bindingId, status)
      .map((row) => mapQueuedMessage(row as DbRow));
  }

  markQueuedDelivered(id: string): void {
    this.database.db
      .prepare("UPDATE message_queue SET status = 'delivered', delivered_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  cancelQueuedMessage(id: string): boolean {
    const result = this.database.db
      .prepare("UPDATE message_queue SET status = 'cancelled', failed_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowIso(), id);
    return Number(result.changes) > 0;
  }

  upsertPendingApproval(input: {
    sessionBindingId: string;
    codexThreadId: string;
    codexTurnId?: string | null;
    requestId: string;
    itemId?: string | null;
    approvalType: "command_execution" | "file_change";
    command?: string | null;
    filePaths?: string[];
    reason?: string | null;
    riskLevel?: "low" | "medium" | "high";
  }): PendingApproval {
    const id = newId("appr");
    const requestedAt = nowIso();
    this.database.db
      .prepare(
        `INSERT INTO pending_approvals (
          id, session_binding_id, codex_thread_id, codex_turn_id, request_id,
          item_id, approval_type, command, file_paths_json, reason, risk_level,
          status, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(codex_thread_id, request_id) DO UPDATE SET
          command = COALESCE(excluded.command, pending_approvals.command),
          file_paths_json = excluded.file_paths_json,
          reason = COALESCE(excluded.reason, pending_approvals.reason),
          risk_level = excluded.risk_level`
      )
      .run(
        id,
        input.sessionBindingId,
        input.codexThreadId,
        input.codexTurnId ?? null,
        input.requestId,
        input.itemId ?? null,
        input.approvalType,
        input.command ?? null,
        stringifyJson(input.filePaths ?? []),
        input.reason ?? null,
        input.riskLevel ?? "medium",
        requestedAt
      );
    return this.findApproval(input.codexThreadId, input.requestId)!;
  }

  findApproval(codexThreadId: string, requestId: string): PendingApproval | null {
    const row = this.database.db
      .prepare("SELECT * FROM pending_approvals WHERE codex_thread_id = ? AND request_id = ?")
      .get(codexThreadId, requestId) as DbRow | undefined;
    return row ? mapApproval(row) : null;
  }

  findApprovalById(id: string): PendingApproval | null {
    const row = this.database.db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapApproval(row) : null;
  }

  listPendingApprovals(bindingId?: string): PendingApproval[] {
    const stmt = bindingId
      ? this.database.db.prepare(
          "SELECT * FROM pending_approvals WHERE status = 'pending' AND session_binding_id = ? ORDER BY requested_at"
        )
      : this.database.db.prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY requested_at");
    const rows = bindingId ? stmt.all(bindingId) : stmt.all();
    return rows.map((row) => mapApproval(row as DbRow));
  }

  resolveApproval(id: string, status: ApprovalStatus, resolvedByFeishuUserId: string | null): void {
    this.database.db
      .prepare(
        `UPDATE pending_approvals
         SET status = ?, resolved_at = ?, resolved_by_feishu_user_id = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(status, nowIso(), resolvedByFeishuUserId, id);
  }

  enqueueOutbox(input: {
    sessionBindingId?: string | null;
    eventSeq?: number | null;
    notificationType: NotificationType;
    feishuChatId: string;
    feishuTopicRootMessageId?: string | null;
    payload: Record<string, unknown>;
    dedupeKey: string;
    delayMs?: number;
  }): NotificationOutboxItem {
    const id = newId("out");
    const now = nowIso();
    this.database.db
      .prepare(
        `INSERT INTO notification_outbox (
          id, session_binding_id, event_seq, notification_type, feishu_chat_id,
          feishu_topic_root_message_id, payload_json, dedupe_key, status,
          attempts, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(dedupe_key) DO NOTHING`
      )
      .run(
        id,
        input.sessionBindingId ?? null,
        input.eventSeq ?? null,
        input.notificationType,
        input.feishuChatId,
        input.feishuTopicRootMessageId ?? null,
        stringifyJson(input.payload),
        input.dedupeKey,
        plusMsIso(input.delayMs ?? 0),
        now
      );
    const row = this.database.db.prepare("SELECT * FROM notification_outbox WHERE dedupe_key = ?").get(input.dedupeKey) as
      | DbRow
      | undefined;
    return mapOutbox(row!);
  }

  listDueOutbox(limit = 20): NotificationOutboxItem[] {
    return this.database.db
      .prepare(
        `SELECT * FROM notification_outbox
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(nowIso(), limit)
      .map((row) => mapOutbox(row as DbRow));
  }

  listRecentOutbox(limit = 20): NotificationOutboxItem[] {
    return this.database.db
      .prepare("SELECT * FROM notification_outbox ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapOutbox(row as DbRow));
  }

  updateOutbox(id: string, status: OutboxStatus, attempts: number, lastError?: string | null, nextAttemptAt?: string | null): void {
    this.database.db
      .prepare(
        `UPDATE notification_outbox
         SET status = ?, attempts = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
             last_error = ?, next_attempt_at = ?
         WHERE id = ?`
      )
      .run(status, attempts, status, nowIso(), lastError ?? null, nextAttemptAt ?? null, id);
  }

  count(table: string, where = "1 = 1"): number {
    const allowed = new Set([
      "projects",
      "session_bindings",
      "notification_outbox",
      "pending_approvals",
      "message_queue",
      "incoming_messages"
    ]);
    if (!allowed.has(table)) throw new Error(`Unsupported count table: ${table}`);
    const row = this.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
      count: number;
    };
    return Number(row.count);
  }

  private updateAction(actionId: string, status: ActionStatus, result: Record<string, unknown>): void {
    this.database.db
      .prepare("UPDATE action_requests SET status = ?, result_json = ?, updated_at = ? WHERE action_id = ?")
      .run(status, stringifyJson(result), nowIso(), actionId);
  }
}

const mapProject = (row: DbRow): Project => ({
  id: String(row.id),
  name: String(row.name),
  rootPath: String(row.root_path),
  gitRepoRoot: asString(row.git_repo_root),
  gitRemote: asString(row.git_remote),
  defaultBranch: asString(row.default_branch),
  defaultModel: asString(row.default_model),
  approvalPolicy: asString(row.approval_policy),
  sandboxPolicy: asString(row.sandbox_policy),
  feishuChatId: asString(row.feishu_chat_id),
  notificationPolicy: asString(row.notification_policy),
  status: String(row.status),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});

const mapBinding = (row: DbRow): SessionBinding => ({
  id: String(row.id),
  projectId: asString(row.project_id),
  codexThreadId: String(row.codex_thread_id),
  feishuChatId: String(row.feishu_chat_id),
  feishuTopicRootMessageId: String(row.feishu_topic_root_message_id),
  feishuThreadId: asString(row.feishu_thread_id),
  title: asString(row.title),
  cwd: asString(row.cwd),
  gitRepoRoot: asString(row.git_repo_root),
  branchName: asString(row.branch_name),
  worktreePath: asString(row.worktree_path),
  status: String(row.status) as TaskStatus,
  lastTurnId: asString(row.last_turn_id),
  lastEventCursor: asString(row.last_event_cursor),
  createdByFeishuUserId: asString(row.created_by_feishu_user_id),
  createdFrom: String(row.created_from) as CreatedFrom,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});

const mapEvent = (row: DbRow): TaskEvent => ({
  id: String(row.id),
  seq: Number(row.seq),
  sessionBindingId: String(row.session_binding_id),
  codexThreadId: String(row.codex_thread_id),
  codexTurnId: asString(row.codex_turn_id),
  eventType: String(row.event_type),
  eventPayload: parseJsonObject(asString(row.event_payload_json)),
  feishuMessageId: asString(row.feishu_message_id),
  createdAt: String(row.created_at)
});

const mapAction = (row: DbRow): ActionRequest => ({
  actionId: String(row.action_id),
  actionType: String(row.action_type),
  payload: parseJsonObject(asString(row.payload_json)),
  status: String(row.status) as ActionStatus,
  result: row.result_json ? parseJsonObject(String(row.result_json)) : null,
  requestedByFeishuUserId: asString(row.requested_by_feishu_user_id),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});

const mapQueuedMessage = (row: DbRow): QueuedMessage => ({
  id: String(row.id),
  sessionBindingId: String(row.session_binding_id),
  feishuMessageId: String(row.feishu_message_id),
  text: String(row.text),
  status: String(row.status) as QueueStatus,
  position: Number(row.position),
  createdByFeishuUserId: String(row.created_by_feishu_user_id),
  createdAt: String(row.created_at),
  deliveredAt: asString(row.delivered_at),
  failedAt: asString(row.failed_at),
  error: asString(row.error)
});

const mapApproval = (row: DbRow): PendingApproval => ({
  id: String(row.id),
  sessionBindingId: String(row.session_binding_id),
  codexThreadId: String(row.codex_thread_id),
  codexTurnId: asString(row.codex_turn_id),
  requestId: String(row.request_id),
  itemId: asString(row.item_id),
  approvalType: String(row.approval_type) as "command_execution" | "file_change",
  command: asString(row.command),
  filePaths: parseJsonArray(asString(row.file_paths_json)).filter((entry): entry is string => typeof entry === "string"),
  reason: asString(row.reason),
  riskLevel: String(row.risk_level) as "low" | "medium" | "high",
  status: String(row.status) as ApprovalStatus,
  feishuCardMessageId: asString(row.feishu_card_message_id),
  requestedAt: String(row.requested_at),
  resolvedAt: asString(row.resolved_at),
  resolvedByFeishuUserId: asString(row.resolved_by_feishu_user_id)
});

const mapOutbox = (row: DbRow): NotificationOutboxItem => ({
  id: String(row.id),
  sessionBindingId: asString(row.session_binding_id),
  eventSeq: row.event_seq == null ? null : Number(row.event_seq),
  notificationType: String(row.notification_type) as NotificationType,
  feishuChatId: String(row.feishu_chat_id),
  feishuTopicRootMessageId: asString(row.feishu_topic_root_message_id),
  payload: parseJsonObject(asString(row.payload_json)),
  dedupeKey: String(row.dedupe_key),
  status: String(row.status) as OutboxStatus,
  attempts: Number(row.attempts),
  nextAttemptAt: asString(row.next_attempt_at),
  sentAt: asString(row.sent_at),
  lastError: asString(row.last_error),
  createdAt: String(row.created_at)
});

const hashText = (text: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
