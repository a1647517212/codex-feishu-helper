export type TaskStatus =
  | "draft"
  | "waiting_for_prompt"
  | "running"
  | "waiting_for_approval"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted"
  | "archived";

export type CreatedFrom = "codex_app_claimed" | "feishu_new_task" | "manual_import";

export type FeishuTaskContainerKind = "topic" | "dedicated_chat";

export type ApprovalType = "command_execution" | "file_change";

export type ApprovalStatus =
  | "pending"
  | "approved_once"
  | "approved_for_task"
  | "denied"
  | "expired";

export type QueueStatus = "queued" | "delivered" | "cancelled" | "failed";

export type OutboxStatus = "pending" | "sent" | "failed" | "dead";

export type ActionStatus = "processing" | "completed" | "failed";

export type TrustedRole = "owner" | "operator" | "viewer";

export type TrustedSubjectStatus = "active" | "disabled";

export type NotificationType =
  | "task_completed"
  | "task_failed"
  | "approval_required"
  | "task_interrupted"
  | "bridge_unavailable"
  | "project_unclassified"
  | "console"
  | "diagnostic"
  | "task_progress"
  | "task_status";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  approvalPolicy: string | null;
  sandboxPolicy: string | null;
  feishuChatId: string | null;
  notificationPolicy: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBinding {
  id: string;
  projectId: string | null;
  codexThreadId: string;
  feishuChatId: string;
  feishuTopicRootMessageId: string;
  feishuThreadId: string | null;
  feishuTaskCardMessageId: string | null;
  feishuContainerKind: FeishuTaskContainerKind;
  feishuControlChatId: string | null;
  title: string | null;
  cwd: string | null;
  status: TaskStatus;
  lastTurnId: string | null;
  lastEventCursor: string | null;
  createdByFeishuUserId: string | null;
  createdFrom: CreatedFrom;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  seq: number;
  sessionBindingId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  eventType: string;
  eventPayload: Record<string, unknown>;
  feishuMessageId: string | null;
  createdAt: string;
}

export interface PendingApproval {
  id: string;
  sessionBindingId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  requestId: string;
  itemId: string | null;
  approvalType: ApprovalType;
  command: string | null;
  filePaths: string[];
  reason: string | null;
  riskLevel: "low" | "medium" | "high";
  status: ApprovalStatus;
  feishuCardMessageId: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedByFeishuUserId: string | null;
}

export interface QueuedMessage {
  id: string;
  sessionBindingId: string;
  feishuMessageId: string;
  text: string;
  status: QueueStatus;
  position: number;
  createdByFeishuUserId: string;
  createdAt: string;
  deliveredAt: string | null;
  failedAt: string | null;
  error: string | null;
}

export interface NotificationOutboxItem {
  id: string;
  sessionBindingId: string | null;
  eventSeq: number | null;
  notificationType: NotificationType;
  feishuChatId: string;
  feishuTopicRootMessageId: string | null;
  feishuThreadId: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface IgnoredThread {
  codexThreadId: string;
  title: string | null;
  cwd: string | null;
  reason: string | null;
  createdByFeishuUserId: string | null;
  createdAt: string;
}

export interface ActionRequest {
  actionId: string;
  actionType: string;
  payload: Record<string, unknown>;
  status: ActionStatus;
  result: Record<string, unknown> | null;
  requestedByFeishuUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnosticSnapshot {
  uptimeSeconds: number;
  machineName: string;
  platform: string;
  nodeVersion: string;
  codexCommand: string;
  codexAvailable: boolean;
  appServerStatus: "connected" | "disconnected" | "not_started" | "error";
  feishuConfigured: boolean;
  feishuMessageTransport: "long_connection" | "http_callback";
  feishuCardActionTransport: "long_connection" | "http_callback";
  feishuInteractionMode: "message_command" | "hybrid" | "card_callback";
  feishuDefaultChatId: string | null;
  feishuDefaultChatDiagnostic: FeishuChatDiagnostic | null;
  feishuTaskContainerMode: "dedicated_chat" | "topic";
  databasePath: string;
  projectsCount: number;
  sessionBindingsCount: number;
  runningTasksCount: number;
  pendingOutboxCount: number;
  pendingApprovalsCount: number;
  lastFeishuMessageAt: string | null;
  lastFeishuMessageId: string | null;
  lastFeishuCardActionAt: string | null;
  lastFeishuCardAction: string | null;
  lastFeishuCardActionId: string | null;
  lastError: string | null;
}

export interface FeishuChatDiagnostic {
  ok: boolean;
  chatId: string;
  name: string | null;
  chatMode: string | null;
  groupMessageType: string | null;
  topicReplySupported: boolean | null;
  fullTopicMode: boolean | null;
  recommendation: string;
  requiredScopes: string[];
  error: string | null;
}

export interface TaskStatusProjection {
  bindingId: string;
  title: string;
  projectName: string;
  status: TaskStatus;
  cwd: string | null;
  queuedMessages: number;
  pendingApprovals: number;
  lastTurnId: string | null;
  lastSummary: string | null;
  updatedAt: string;
}

export interface TaskProgressProjection {
  title: string;
  status: TaskStatus;
  projectName: string;
  updatedAt: string;
  sections: Array<{
    label: string;
    text: string;
  }>;
}

export interface TaskReportProjection {
  title: string;
  status: TaskStatus;
  projectName: string;
  reasoningSummary: string | null;
  finalResult: string | null;
  updatedAt: string;
}

export interface TaskProcessProjection {
  title: string;
  status: TaskStatus;
  projectName: string;
  updatedAt: string;
  sections: Array<{
    label: string;
    text: string;
  }>;
}

export interface FeishuIncomingMessage {
  messageId: string;
  chatId: string;
  rootMessageId: string | null;
  parentMessageId?: string | null;
  threadId: string | null;
  userId: string;
  text: string;
  createTime?: string;
}

export interface FeishuCardAction {
  actionId: string;
  action: string;
  userId: string;
  chatId: string;
  rootMessageId?: string | null;
  payload: Record<string, unknown>;
}
