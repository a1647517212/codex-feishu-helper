import type { StatementSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { newId } from "../core/ids.js";
import { asString, parseJsonArray, parseJsonObject, stringifyJson } from "../core/json.js";
import { nowIso, plusMsIso } from "../core/time.js";
import type {
  ActionRequest,
  ActionStatus,
  ApprovalStatus,
  BridgeDevice,
  CreatedFrom,
  IgnoredThread,
  NotificationLevel,
  NotificationOutboxItem,
  NotificationPreference,
  NotificationScopeType,
  NotificationType,
  OutboxStatus,
  PendingApproval,
  PendingProjectPrompt,
  Project,
  QueuedMessage,
  QueueStatus,
  SessionBinding,
  TaskEvent,
  TaskStatus,
  ThreadOwnerKind,
  ThreadOwnership,
  TrustedFeishuSubject,
  TrustedRole,
  TrustedSubjectStatus,
  WorkspaceCheckpoint,
  WorkspaceCheckpointKind
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
    defaultReasoningEffort?: string | null;
    approvalPolicy?: string | null;
    sandboxPolicy?: string | null;
    notificationPolicy?: string | null;
  }): Project {
    const now = nowIso();
    const id = input.id ?? newId("proj");
    this.database.db
      .prepare(
        `INSERT INTO projects (
          id, name, root_path, default_model, default_reasoning_effort, approval_policy, sandbox_policy, feishu_chat_id,
          notification_policy, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          default_model = excluded.default_model,
          default_reasoning_effort = excluded.default_reasoning_effort,
          approval_policy = excluded.approval_policy,
          sandbox_policy = excluded.sandbox_policy,
          feishu_chat_id = excluded.feishu_chat_id,
          notification_policy = COALESCE(excluded.notification_policy, projects.notification_policy),
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.name,
        input.rootPath,
        input.defaultModel ?? null,
        input.defaultReasoningEffort ?? null,
        input.approvalPolicy ?? null,
        input.sandboxPolicy ?? null,
        input.feishuChatId ?? null,
        input.notificationPolicy ?? null,
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

  updateProjectDefaults(input: {
    projectId: string;
    defaultModel?: string | null;
    defaultReasoningEffort?: string | null;
  }): void {
    this.database.db
      .prepare(
        `UPDATE projects
         SET default_model = COALESCE(?, default_model),
             default_reasoning_effort = COALESCE(?, default_reasoning_effort),
             updated_at = ?
         WHERE id = ?`
      )
      .run(input.defaultModel ?? null, input.defaultReasoningEffort ?? null, nowIso(), input.projectId);
  }

  updateProjectNotificationPolicy(projectId: string, notificationPolicy: string | null): void {
    this.database.db
      .prepare(
        `UPDATE projects
         SET notification_policy = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(notificationPolicy, nowIso(), projectId);
  }

  updateBindingProject(bindingId: string, projectId: string | null): void {
    this.database.db
      .prepare("UPDATE session_bindings SET project_id = ?, updated_at = ? WHERE id = ?")
      .run(projectId, nowIso(), bindingId);
  }

  ignoreThread(input: {
    codexThreadId: string;
    title?: string | null;
    cwd?: string | null;
    reason?: string | null;
    createdByFeishuUserId?: string | null;
  }): IgnoredThread {
    this.database.db
      .prepare(
        `INSERT INTO ignored_threads (
          codex_thread_id, title, cwd, reason, created_by_feishu_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(codex_thread_id) DO UPDATE SET
          title = COALESCE(excluded.title, ignored_threads.title),
          cwd = COALESCE(excluded.cwd, ignored_threads.cwd),
          reason = COALESCE(excluded.reason, ignored_threads.reason),
          created_by_feishu_user_id = COALESCE(excluded.created_by_feishu_user_id, ignored_threads.created_by_feishu_user_id)`
      )
      .run(
        input.codexThreadId,
        input.title ?? null,
        input.cwd ?? null,
        input.reason ?? null,
        input.createdByFeishuUserId ?? null,
        nowIso()
      );
    return this.findIgnoredThread(input.codexThreadId)!;
  }

  unignoreThread(codexThreadId: string): void {
    this.database.db.prepare("DELETE FROM ignored_threads WHERE codex_thread_id = ?").run(codexThreadId);
  }

  findIgnoredThread(codexThreadId: string): IgnoredThread | null {
    const row = this.database.db
      .prepare("SELECT * FROM ignored_threads WHERE codex_thread_id = ?")
      .get(codexThreadId) as DbRow | undefined;
    return row ? mapIgnoredThread(row) : null;
  }

  listIgnoredThreads(limit = 100): IgnoredThread[] {
    return this.database.db
      .prepare("SELECT * FROM ignored_threads ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapIgnoredThread(row as DbRow));
  }

  findProjectForPath(cwd: string | null | undefined): Project | null {
    if (!cwd) return null;
    const normalized = normalizeFsPath(cwd);
    return (
      this.listProjects().find((project) => {
        const root = normalizeFsPath(project.rootPath);
        return normalized === root || normalized.startsWith(`${root}/`);
      }) ?? null
    );
  }

  findProjectForContext(input: {
    cwd?: string | null;
  }): Project | null {
    const byPath = this.findProjectForPath(input.cwd);
    if (byPath) return byPath;
    if (input.cwd) {
      const byRule = this.findProjectByPrefixRule("cwd_prefix", input.cwd);
      if (byRule) return byRule;
    }
    return null;
  }

  addProjectMatchRule(input: {
    projectId: string;
    ruleType: "cwd_prefix";
    ruleValue: string;
  }): void {
    this.database.db
      .prepare(
        `INSERT INTO project_match_rules (id, project_id, rule_type, rule_value, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, rule_type, rule_value) DO NOTHING`
      )
      .run(newId("rule"), input.projectId, input.ruleType, normalizeRuleValue(input.ruleValue), nowIso());
  }

  createOrUpdateBinding(input: {
    projectId?: string | null;
    codexThreadId: string;
    feishuChatId: string;
    feishuTopicRootMessageId: string;
    feishuThreadId?: string | null;
    feishuTaskCardMessageId?: string | null;
    feishuContainerKind?: "topic" | "dedicated_chat";
    feishuControlChatId?: string | null;
    title?: string | null;
    cwd?: string | null;
    selectedModel?: string | null;
    selectedReasoningEffort?: string | null;
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
          feishu_thread_id, feishu_task_card_message_id, feishu_container_kind, feishu_control_chat_id, title, cwd,
          selected_model, selected_reasoning_effort, status,
          last_turn_id, last_event_cursor, created_by_feishu_user_id, created_from, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(codex_thread_id) DO UPDATE SET
          project_id = COALESCE(excluded.project_id, session_bindings.project_id),
          feishu_chat_id = excluded.feishu_chat_id,
          feishu_topic_root_message_id = excluded.feishu_topic_root_message_id,
          feishu_thread_id = excluded.feishu_thread_id,
          feishu_task_card_message_id = COALESCE(excluded.feishu_task_card_message_id, session_bindings.feishu_task_card_message_id),
          feishu_container_kind = COALESCE(excluded.feishu_container_kind, session_bindings.feishu_container_kind),
          feishu_control_chat_id = COALESCE(excluded.feishu_control_chat_id, session_bindings.feishu_control_chat_id),
          title = COALESCE(excluded.title, session_bindings.title),
          cwd = COALESCE(excluded.cwd, session_bindings.cwd),
          selected_model = COALESCE(excluded.selected_model, session_bindings.selected_model),
          selected_reasoning_effort = COALESCE(excluded.selected_reasoning_effort, session_bindings.selected_reasoning_effort),
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
        input.feishuTaskCardMessageId ?? null,
        input.feishuContainerKind ?? "topic",
        input.feishuControlChatId ?? null,
        input.title ?? null,
        input.cwd ?? null,
        input.selectedModel ?? null,
        input.selectedReasoningEffort ?? null,
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

  updateBindingSettings(input: {
    bindingId: string;
    selectedModel?: string | null;
    selectedReasoningEffort?: string | null;
  }): void {
    this.database.db
      .prepare(
        `UPDATE session_bindings
         SET selected_model = COALESCE(?, selected_model),
             selected_reasoning_effort = COALESCE(?, selected_reasoning_effort),
             updated_at = ?
         WHERE id = ?`
      )
      .run(input.selectedModel ?? null, input.selectedReasoningEffort ?? null, nowIso(), input.bindingId);
  }

  updateBindingTopic(input: {
    bindingId: string;
    feishuChatId: string;
    feishuTopicRootMessageId: string;
    feishuThreadId?: string | null;
    feishuTaskCardMessageId?: string | null;
    feishuContainerKind?: "topic" | "dedicated_chat";
    feishuControlChatId?: string | null;
  }): void {
    this.database.db
      .prepare(
        `UPDATE session_bindings
         SET feishu_chat_id = ?, feishu_topic_root_message_id = ?, feishu_thread_id = ?,
             feishu_task_card_message_id = COALESCE(?, feishu_task_card_message_id),
             feishu_container_kind = COALESCE(?, feishu_container_kind),
             feishu_control_chat_id = COALESCE(?, feishu_control_chat_id),
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.feishuChatId,
        input.feishuTopicRootMessageId,
        input.feishuThreadId ?? null,
        input.feishuTaskCardMessageId ?? null,
        input.feishuContainerKind ?? null,
        input.feishuControlChatId ?? null,
        nowIso(),
        input.bindingId
      );
  }

  updateBindingTaskCardMessageId(bindingId: string, messageId: string | null): void {
    this.database.db
      .prepare(
        `UPDATE session_bindings
         SET feishu_task_card_message_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(messageId, nowIso(), bindingId);
  }

  findBindingByTaskCardMessageId(chatId: string, messageId: string): SessionBinding | null {
    const row = this.database.db
      .prepare("SELECT * FROM session_bindings WHERE feishu_chat_id = ? AND feishu_task_card_message_id = ?")
      .get(chatId, messageId) as DbRow | undefined;
    return row ? mapBinding(row) : null;
  }

  activateDraftBinding(input: {
    bindingId: string;
    codexThreadId: string;
    projectId?: string | null;
    title: string;
    cwd?: string | null;
    status: TaskStatus;
    lastTurnId?: string | null;
  }): void {
    this.database.db
      .prepare(
        `UPDATE session_bindings
         SET codex_thread_id = ?, project_id = ?, title = ?, cwd = ?, status = ?, last_turn_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.codexThreadId,
        input.projectId ?? null,
        input.title,
        input.cwd ?? null,
        input.status,
        input.lastTurnId ?? null,
        nowIso(),
        input.bindingId
      );
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

  findBindingByFeishuThreadId(chatId: string, feishuThreadId: string): SessionBinding | null {
    const row = this.database.db
      .prepare("SELECT * FROM session_bindings WHERE feishu_chat_id = ? AND feishu_thread_id = ?")
      .get(chatId, feishuThreadId) as DbRow | undefined;
    return row ? mapBinding(row) : null;
  }

  findBindingByTopic(chatId: string, rootMessageId: string): SessionBinding | null {
    const row = this.database.db
      .prepare("SELECT * FROM session_bindings WHERE feishu_chat_id = ? AND feishu_topic_root_message_id = ?")
      .get(chatId, rootMessageId) as DbRow | undefined;
    return row ? mapBinding(row) : null;
  }

  findBindingByChatId(chatId: string): SessionBinding | null {
    const row = this.database.db
      .prepare("SELECT * FROM session_bindings WHERE feishu_chat_id = ? AND feishu_container_kind = 'dedicated_chat' ORDER BY updated_at DESC LIMIT 1")
      .get(chatId) as DbRow | undefined;
    return row ? mapBinding(row) : null;
  }

  listBindings(limit = 50): SessionBinding[] {
    return this.database.db
      .prepare("SELECT * FROM session_bindings ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapBinding(row as DbRow));
  }

  listBindingsByStatuses(statuses: TaskStatus[], limit = 50): SessionBinding[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.database.db
      .prepare(`SELECT * FROM session_bindings WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...statuses, limit)
      .map((row) => mapBinding(row as DbRow));
  }

  searchBindings(query: string, limit = 20): SessionBinding[] {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    const pattern = `%${trimmed}%`;
    return this.database.db
      .prepare(
        `SELECT DISTINCT b.*
         FROM session_bindings b
         LEFT JOIN projects p ON p.id = b.project_id
         LEFT JOIN task_events e ON e.session_binding_id = b.id
         WHERE lower(COALESCE(b.title, '')) LIKE ?
            OR lower(COALESCE(b.cwd, '')) LIKE ?
            OR lower(COALESCE(b.codex_thread_id, '')) LIKE ?
            OR lower(COALESCE(p.name, '')) LIKE ?
            OR lower(COALESCE(e.event_type, '')) LIKE ?
            OR lower(COALESCE(e.event_payload_json, '')) LIKE ?
         ORDER BY b.updated_at DESC
         LIMIT ?`
      )
      .all(pattern, pattern, pattern, pattern, pattern, pattern, limit)
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

  searchEvents(query: string, limit = 50): TaskEvent[] {
    const normalized = `%${query.trim().toLowerCase()}%`;
    if (!query.trim()) return [];
    return this.database.db
      .prepare(
        `SELECT * FROM task_events
         WHERE lower(event_type) LIKE ? OR lower(COALESCE(event_payload_json, '')) LIKE ?
         ORDER BY seq DESC LIMIT ?`
      )
      .all(normalized, normalized, limit)
      .map((row) => mapEvent(row as DbRow));
  }

  createWorkspaceCheckpoint(input: {
    sessionBindingId: string;
    codexThreadId: string;
    turnId?: string | null;
    workspaceRoot: string;
    checkpointRef: string;
    snapshotNote?: string | null;
    kind: WorkspaceCheckpointKind;
    manifest: Record<string, unknown>;
  }): WorkspaceCheckpoint {
    const id = newId("ckpt");
    this.database.db
      .prepare(
        `INSERT INTO workspace_checkpoints (
          id, session_binding_id, codex_thread_id, turn_id, workspace_root,
          checkpoint_ref, snapshot_note, kind, manifest_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionBindingId,
        input.codexThreadId,
        input.turnId ?? null,
        input.workspaceRoot,
        input.checkpointRef,
        input.snapshotNote ?? null,
        input.kind,
        stringifyJson(input.manifest),
        nowIso()
      );
    return this.getWorkspaceCheckpoint(id)!;
  }

  getWorkspaceCheckpoint(id: string): WorkspaceCheckpoint | null {
    const row = this.database.db.prepare("SELECT * FROM workspace_checkpoints WHERE id = ?").get(id) as
      | DbRow
      | undefined;
    return row ? mapWorkspaceCheckpoint(row) : null;
  }

  listWorkspaceCheckpoints(bindingId: string, limit = 20): WorkspaceCheckpoint[] {
    return this.database.db
      .prepare("SELECT * FROM workspace_checkpoints WHERE session_binding_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(bindingId, limit)
      .map((row) => mapWorkspaceCheckpoint(row as DbRow));
  }

  findLatestWorkspaceCheckpoint(
    bindingId: string,
    kind?: WorkspaceCheckpointKind,
    turnId?: string | null
  ): WorkspaceCheckpoint | null {
    const conditions = ["session_binding_id = ?"];
    const values: SQLInputValue[] = [bindingId];
    if (kind) {
      conditions.push("kind = ?");
      values.push(kind);
    }
    if (turnId !== undefined) {
      conditions.push(turnId === null ? "turn_id IS NULL" : "turn_id = ?");
      if (turnId !== null) values.push(turnId);
    }
    const row = this.database.db
      .prepare(`SELECT * FROM workspace_checkpoints WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 1`)
      .get(...values) as DbRow | undefined;
    return row ? mapWorkspaceCheckpoint(row) : null;
  }

  findWorkspaceCheckpointPair(bindingId: string, turnId?: string | null): {
    start: WorkspaceCheckpoint | null;
    end: WorkspaceCheckpoint | null;
  } {
    const end = this.findLatestWorkspaceCheckpoint(bindingId, "turn_end", turnId);
    const effectiveTurnId = turnId !== undefined ? turnId : end?.turnId;
    return {
      start: this.findLatestWorkspaceCheckpoint(bindingId, "turn_start", effectiveTurnId),
      end
    };
  }

  updateWorkspaceCheckpointTurnId(id: string, turnId: string | null): void {
    this.database.db
      .prepare("UPDATE workspace_checkpoints SET turn_id = ? WHERE id = ?")
      .run(turnId, id);
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

  createPendingProjectPrompt(input: {
    feishuMessageId: string;
    feishuChatId: string;
    feishuUserId?: string | null;
    text: string;
  }): PendingProjectPrompt {
    const now = nowIso();
    const existing = this.findPendingProjectPromptByMessageId(input.feishuMessageId);
    const id = existing?.id ?? newId("pending_prompt");
    this.database.db
      .prepare(
        `INSERT INTO pending_project_prompts (
          id, feishu_message_id, feishu_chat_id, feishu_user_id, text, status, created_at, used_at, selected_project_id
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)
        ON CONFLICT(feishu_message_id) DO UPDATE SET
          feishu_chat_id = excluded.feishu_chat_id,
          feishu_user_id = excluded.feishu_user_id,
          text = excluded.text`
      )
      .run(id, input.feishuMessageId, input.feishuChatId, input.feishuUserId ?? null, input.text, now);
    return this.getPendingProjectPrompt(id)!;
  }

  getPendingProjectPrompt(id: string): PendingProjectPrompt | null {
    const row = this.database.db.prepare("SELECT * FROM pending_project_prompts WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapPendingProjectPrompt(row) : null;
  }

  findPendingProjectPromptByMessageId(feishuMessageId: string): PendingProjectPrompt | null {
    const row = this.database.db
      .prepare("SELECT * FROM pending_project_prompts WHERE feishu_message_id = ?")
      .get(feishuMessageId) as DbRow | undefined;
    return row ? mapPendingProjectPrompt(row) : null;
  }

  consumePendingProjectPrompt(id: string, projectId: string): PendingProjectPrompt | null {
    const prompt = this.getPendingProjectPrompt(id);
    if (!prompt || prompt.status !== "pending") return null;
    this.database.db
      .prepare(
        `UPDATE pending_project_prompts
         SET status = 'used', used_at = ?, selected_project_id = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(nowIso(), projectId, id);
    return prompt;
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
    feishuThreadId?: string | null;
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
          feishu_topic_root_message_id, feishu_thread_id, payload_json, dedupe_key,
          status, attempts, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(dedupe_key) DO NOTHING`
      )
      .run(
        id,
        input.sessionBindingId ?? null,
        input.eventSeq ?? null,
        input.notificationType,
        input.feishuChatId,
        input.feishuTopicRootMessageId ?? null,
        input.feishuThreadId ?? null,
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

  getOutboxByDedupeKey(dedupeKey: string): NotificationOutboxItem | null {
    const row = this.database.db.prepare("SELECT * FROM notification_outbox WHERE dedupe_key = ?").get(dedupeKey) as
      | DbRow
      | undefined;
    return row ? mapOutbox(row) : null;
  }

  listRecentOutbox(limit = 20): NotificationOutboxItem[] {
    return this.database.db
      .prepare("SELECT * FROM notification_outbox ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapOutbox(row as DbRow));
  }

  resetDeadOutbox(limit = 50): number {
    const now = nowIso();
    const rows = this.database.db
      .prepare("SELECT id FROM notification_outbox WHERE status = 'dead' ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ id?: unknown }>;
    for (const row of rows) {
      this.database.db
        .prepare(
          `UPDATE notification_outbox
           SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL
           WHERE id = ?`
        )
        .run(now, String(row.id));
    }
    return rows.length;
  }

  upsertNotificationPreference(input: {
    scopeType: NotificationScopeType;
    scopeId: string;
    feishuUserId?: string | null;
    level: NotificationLevel;
  }): NotificationPreference {
    const now = nowIso();
    const existing = this.getNotificationPreference(input.scopeType, input.scopeId, input.feishuUserId ?? null);
    const id = existing?.id ?? newId("notify_pref");
    this.database.db
      .prepare(
        `INSERT INTO notification_preferences (
          id, scope_type, scope_id, feishu_user_id, level, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, feishu_user_id) DO UPDATE SET
          level = excluded.level,
          updated_at = excluded.updated_at`
      )
      .run(id, input.scopeType, input.scopeId, input.feishuUserId ?? null, input.level, now, now);
    return this.getNotificationPreference(input.scopeType, input.scopeId, input.feishuUserId ?? null)!;
  }

  getNotificationPreference(
    scopeType: NotificationScopeType,
    scopeId: string,
    feishuUserId?: string | null
  ): NotificationPreference | null {
    const row = this.database.db
      .prepare(
        `SELECT * FROM notification_preferences
         WHERE scope_type = ? AND scope_id = ? AND (
           (feishu_user_id IS NULL AND ? IS NULL) OR feishu_user_id = ?
         )`
      )
      .get(scopeType, scopeId, feishuUserId ?? null, feishuUserId ?? null) as DbRow | undefined;
    return row ? mapNotificationPreference(row) : null;
  }

  listNotificationPreferences(limit = 100): NotificationPreference[] {
    return this.database.db
      .prepare("SELECT * FROM notification_preferences ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapNotificationPreference(row as DbRow));
  }

  upsertBridgeDevice(input: {
    id?: string;
    machineName: string;
    devicePublicKey?: string | null;
    devicePrivateKeyRef?: string | null;
    codexHome?: string | null;
    status: string;
  }): BridgeDevice {
    const now = nowIso();
    const id = input.id ?? newId("device");
    this.database.db
      .prepare(
        `INSERT INTO bridge_devices (
          id, machine_name, device_public_key, device_private_key_ref, codex_home, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          machine_name = excluded.machine_name,
          device_public_key = COALESCE(excluded.device_public_key, bridge_devices.device_public_key),
          device_private_key_ref = COALESCE(excluded.device_private_key_ref, bridge_devices.device_private_key_ref),
          codex_home = COALESCE(excluded.codex_home, bridge_devices.codex_home),
          status = excluded.status,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.machineName,
        input.devicePublicKey ?? null,
        input.devicePrivateKeyRef ?? null,
        input.codexHome ?? null,
        input.status,
        now,
        now
      );
    return this.getBridgeDevice(id)!;
  }

  getBridgeDevice(id: string): BridgeDevice | null {
    const row = this.database.db.prepare("SELECT * FROM bridge_devices WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapBridgeDevice(row) : null;
  }

  listBridgeDevices(limit = 20): BridgeDevice[] {
    return this.database.db
      .prepare("SELECT * FROM bridge_devices ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapBridgeDevice(row as DbRow));
  }

  upsertTrustedFeishuSubject(input: {
    id?: string;
    tenantKey?: string | null;
    chatId?: string | null;
    userId?: string | null;
    role: TrustedRole;
    status: TrustedSubjectStatus;
  }): TrustedFeishuSubject {
    const now = nowIso();
    const existing = this.findTrustedFeishuSubject(input.chatId ?? null, input.userId ?? null);
    const id = input.id ?? existing?.id ?? newId("trusted_subject");
    this.database.db
      .prepare(
        `INSERT INTO trusted_feishu_subjects (
          id, tenant_key, chat_id, user_id, role, status, paired_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          tenant_key = COALESCE(excluded.tenant_key, trusted_feishu_subjects.tenant_key),
          chat_id = COALESCE(excluded.chat_id, trusted_feishu_subjects.chat_id),
          user_id = COALESCE(excluded.user_id, trusted_feishu_subjects.user_id),
          role = excluded.role,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        id,
        input.tenantKey ?? null,
        input.chatId ?? null,
        input.userId ?? null,
        input.role,
        input.status,
        existing?.pairedAt ?? now,
        now
      );
    return this.getTrustedFeishuSubject(id)!;
  }

  getTrustedFeishuSubject(id: string): TrustedFeishuSubject | null {
    const row = this.database.db
      .prepare("SELECT * FROM trusted_feishu_subjects WHERE id = ?")
      .get(id) as DbRow | undefined;
    return row ? mapTrustedFeishuSubject(row) : null;
  }

  findTrustedFeishuSubject(chatId?: string | null, userId?: string | null): TrustedFeishuSubject | null {
    if (!chatId && !userId) return null;
    const row = this.database.db
      .prepare(
        `SELECT * FROM trusted_feishu_subjects
         WHERE status = 'active'
           AND ((chat_id IS NOT NULL AND chat_id = ?) OR (user_id IS NOT NULL AND user_id = ?))
         ORDER BY last_seen_at DESC, paired_at DESC
         LIMIT 1`
      )
      .get(chatId ?? null, userId ?? null) as DbRow | undefined;
    return row ? mapTrustedFeishuSubject(row) : null;
  }

  listTrustedFeishuSubjects(limit = 20): TrustedFeishuSubject[] {
    return this.database.db
      .prepare("SELECT * FROM trusted_feishu_subjects ORDER BY last_seen_at DESC, paired_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapTrustedFeishuSubject(row as DbRow));
  }

  touchTrustedFeishuSubject(chatId?: string | null, userId?: string | null): void {
    if (!chatId && !userId) return;
    this.database.db
      .prepare(
        `UPDATE trusted_feishu_subjects
         SET last_seen_at = ?
         WHERE status = 'active'
           AND ((chat_id IS NOT NULL AND chat_id = ?) OR (user_id IS NOT NULL AND user_id = ?))`
      )
      .run(nowIso(), chatId ?? null, userId ?? null);
  }

  upsertThreadOwnership(input: {
    codexThreadId: string;
    ownerKind: ThreadOwnerKind;
    ownerClientId?: string | null;
    confidence: string;
  }): ThreadOwnership {
    const observedAt = nowIso();
    this.database.db
      .prepare(
        `INSERT INTO thread_ownership (
          codex_thread_id, owner_kind, owner_client_id, observed_at, confidence
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(codex_thread_id) DO UPDATE SET
          owner_kind = excluded.owner_kind,
          owner_client_id = excluded.owner_client_id,
          observed_at = excluded.observed_at,
          confidence = excluded.confidence`
      )
      .run(input.codexThreadId, input.ownerKind, input.ownerClientId ?? null, observedAt, input.confidence);
    return this.getThreadOwnership(input.codexThreadId)!;
  }

  getThreadOwnership(codexThreadId: string): ThreadOwnership | null {
    const row = this.database.db
      .prepare("SELECT * FROM thread_ownership WHERE codex_thread_id = ?")
      .get(codexThreadId) as DbRow | undefined;
    return row ? mapThreadOwnership(row) : null;
  }

  listThreadOwnership(limit = 50): ThreadOwnership[] {
    return this.database.db
      .prepare("SELECT * FROM thread_ownership ORDER BY observed_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapThreadOwnership(row as DbRow));
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
      "notification_preferences",
      "pending_approvals",
      "message_queue",
      "incoming_messages",
      "pending_project_prompts",
      "ignored_threads",
      "bridge_devices",
      "trusted_feishu_subjects",
      "thread_ownership",
      "workspace_checkpoints"
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

  private findProjectByPrefixRule(ruleType: "cwd_prefix", value: string): Project | null {
    const normalized = normalizeRuleValue(value);
    const rows = this.database.db
      .prepare(
        `SELECT p.*, r.rule_value
         FROM project_match_rules r
         JOIN projects p ON p.id = r.project_id
         WHERE r.rule_type = ? AND p.status = 'active'`
      )
      .all(ruleType) as Array<DbRow & { rule_value?: unknown }>;
    const matched = rows
      .map((row) => ({
        project: mapProject(row),
        ruleValue: String(row.rule_value ?? "")
      }))
      .filter(({ ruleValue }) => normalized === ruleValue || normalized.startsWith(`${ruleValue}/`))
      .sort((left, right) => right.ruleValue.length - left.ruleValue.length)[0];
    return matched?.project ?? null;
  }
}

const mapProject = (row: DbRow): Project => ({
  id: String(row.id),
  name: String(row.name),
  rootPath: String(row.root_path),
  defaultModel: asString(row.default_model),
  defaultReasoningEffort: asString(row.default_reasoning_effort),
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
  feishuTaskCardMessageId: asString(row.feishu_task_card_message_id),
  feishuContainerKind: (asString(row.feishu_container_kind) === "dedicated_chat" ? "dedicated_chat" : "topic"),
  feishuControlChatId: asString(row.feishu_control_chat_id),
  title: asString(row.title),
  cwd: asString(row.cwd),
  selectedModel: asString(row.selected_model),
  selectedReasoningEffort: asString(row.selected_reasoning_effort),
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
  feishuThreadId: asString(row.feishu_thread_id),
  payload: parseJsonObject(asString(row.payload_json)),
  dedupeKey: String(row.dedupe_key),
  status: String(row.status) as OutboxStatus,
  attempts: Number(row.attempts),
  nextAttemptAt: asString(row.next_attempt_at),
  sentAt: asString(row.sent_at),
  lastError: asString(row.last_error),
  createdAt: String(row.created_at)
});

const mapNotificationPreference = (row: DbRow): NotificationPreference => ({
  id: String(row.id),
  scopeType: String(row.scope_type) as NotificationScopeType,
  scopeId: String(row.scope_id),
  feishuUserId: asString(row.feishu_user_id),
  level: String(row.level) as NotificationLevel,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});

const mapBridgeDevice = (row: DbRow): BridgeDevice => ({
  id: String(row.id),
  machineName: String(row.machine_name),
  devicePublicKey: asString(row.device_public_key),
  devicePrivateKeyRef: asString(row.device_private_key_ref),
  codexHome: asString(row.codex_home),
  status: String(row.status),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});

const mapTrustedFeishuSubject = (row: DbRow): TrustedFeishuSubject => ({
  id: String(row.id),
  tenantKey: asString(row.tenant_key),
  chatId: asString(row.chat_id),
  userId: asString(row.user_id),
  role: String(row.role) as TrustedRole,
  status: String(row.status) as TrustedSubjectStatus,
  pairedAt: String(row.paired_at),
  lastSeenAt: asString(row.last_seen_at)
});

const mapThreadOwnership = (row: DbRow): ThreadOwnership => ({
  codexThreadId: String(row.codex_thread_id),
  ownerKind: String(row.owner_kind) as ThreadOwnerKind,
  ownerClientId: asString(row.owner_client_id),
  observedAt: String(row.observed_at),
  confidence: String(row.confidence)
});

const mapWorkspaceCheckpoint = (row: DbRow): WorkspaceCheckpoint => ({
  id: String(row.id),
  sessionBindingId: String(row.session_binding_id),
  codexThreadId: String(row.codex_thread_id),
  turnId: asString(row.turn_id),
  workspaceRoot: String(row.workspace_root),
  checkpointRef: String(row.checkpoint_ref),
  snapshotNote: asString(row.snapshot_note),
  kind: String(row.kind) as WorkspaceCheckpointKind,
  manifest: parseJsonObject(asString(row.manifest_json)),
  createdAt: String(row.created_at)
});

const mapIgnoredThread = (row: DbRow): IgnoredThread => ({
  codexThreadId: String(row.codex_thread_id),
  title: asString(row.title),
  cwd: asString(row.cwd),
  reason: asString(row.reason),
  createdByFeishuUserId: asString(row.created_by_feishu_user_id),
  createdAt: String(row.created_at)
});

const mapPendingProjectPrompt = (row: DbRow): PendingProjectPrompt => ({
  id: String(row.id),
  feishuMessageId: String(row.feishu_message_id),
  feishuChatId: String(row.feishu_chat_id),
  feishuUserId: asString(row.feishu_user_id),
  text: String(row.text),
  status: String(row.status) as PendingProjectPrompt["status"],
  createdAt: String(row.created_at),
  usedAt: asString(row.used_at),
  selectedProjectId: asString(row.selected_project_id)
});

const hashText = (text: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const normalizeFsPath = (value: string): string => {
  const normalized = value.trim().replace(/[\\/]+/g, "/").replace(/\/+$/g, "").toLowerCase();
  return normalized || "/";
};

const normalizeRuleValue = (value: string): string => {
  const trimmed = value.trim();
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed.toLowerCase() : normalizeFsPath(trimmed);
};
