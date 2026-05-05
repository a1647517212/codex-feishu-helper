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
  | "task_status";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  gitRepoRoot: string | null;
  gitRemote: string | null;
  defaultBranch: string | null;
  defaultModel: string | null;
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
  title: string | null;
  cwd: string | null;
  gitRepoRoot: string | null;
  branchName: string | null;
  worktreePath: string | null;
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
  payload: Record<string, unknown>;
  dedupeKey: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  lastError: string | null;
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
  databasePath: string;
  projectsCount: number;
  sessionBindingsCount: number;
  runningTasksCount: number;
  pendingOutboxCount: number;
  pendingApprovalsCount: number;
  lastError: string | null;
}

export interface TaskStatusProjection {
  bindingId: string;
  title: string;
  projectName: string;
  status: TaskStatus;
  cwd: string | null;
  branchName: string | null;
  changedFiles: number;
  queuedMessages: number;
  pendingApprovals: number;
  lastTurnId: string | null;
  lastSummary: string | null;
  updatedAt: string;
}

export interface FeishuIncomingMessage {
  messageId: string;
  chatId: string;
  rootMessageId: string | null;
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
