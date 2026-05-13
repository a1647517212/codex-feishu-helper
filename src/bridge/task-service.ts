import type { BridgeConfig } from "../config.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { newId } from "../core/ids.js";
import { asString } from "../core/json.js";
import type {
  ActionRequest,
  FeishuCardAction,
  FeishuIncomingMessage,
  FeishuMessageAttachment,
  NotificationLevel,
  NotificationType,
  PendingApproval,
  Project,
  SessionBinding,
  TaskEvent,
  TaskProcessProjection,
  TaskStatus,
  WorkspaceCheckpoint,
  WorkspaceCheckpointKind
} from "../core/types.js";
import type { Repository } from "../db/repo.js";
import { DiagnosticsService } from "./diagnostics.js";
import { commandApprovalDecision, fileApprovalDecision, classifyCommandRisk } from "../domain/approval.js";
import { CardRenderer } from "../domain/cards.js";
import {
  captureWorkspaceManifest,
  compareWorkspaceManifests,
  restoreWorkspaceFromCheckpoints
} from "../domain/checkpoints.js";
import { ProjectionBuilder } from "../domain/projection.js";
import { SecurityPolicy } from "../domain/security.js";
import {
  extractSubAgentsFromEvents,
  extractSubAgentsFromThreadDetail,
  formatSubAgentLines,
  subAgentEventsFromItem
} from "../domain/subagents.js";
import type { CodexClient, CodexExecutionReadiness, CodexModelSummary, CodexThreadSummary } from "../codex/client.js";
import { detectDesktopIpcCapabilities } from "../codex/desktop-ipc-capabilities.js";
import type { CodexLocalImageAttachment } from "../codex/protocol.js";
import type { FeishuSender, SentMessage } from "../feishu/client.js";
import type { Logger } from "../logger.js";

type TaskContainer = {
  chatId: string;
  rootMessageId: string;
  threadId: string | null;
  cardMessageId: string | null;
  kind: "topic" | "dedicated_chat";
  controlChatId: string | null;
};

type FeishuReplyTarget = {
  chatId: string;
  rootMessageId?: string | null;
  threadId?: string | null;
};

type ProgressSection = {
  label: string;
  text: string;
  updatedAt: number;
};

type TaskListKind = "recent" | "running" | "completed" | "failed" | "archived";

type WorkspaceImportSummary = {
  imported: number;
  matched: number;
  skipped: number;
  sources: string[];
};

type CodexMessageInput = {
  prompt: string;
  attachments: CodexLocalImageAttachment[];
  feishuAttachments: FeishuMessageAttachment[];
};

type StoredServerRequestPayload = {
  requestId: string;
  method: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  bindingId: string;
  params: Record<string, unknown>;
};

function activeTurnIdFromThreadDetail(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const rawThread = detail.thread && typeof detail.thread === "object" ? (detail.thread as Record<string, unknown>) : detail;
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn || typeof turn !== "object") continue;
    const object = turn as Record<string, unknown>;
    if (!isActiveCodexTurnStatus(object.status)) continue;
    return asString(object.id) ?? asString(object.turnId) ?? `turn_${index}`;
  }
  return null;
}

export class TaskService {
  private readonly cards: CardRenderer;
  private readonly projection: ProjectionBuilder;
  private readonly security: SecurityPolicy;
  private readonly progressState = new Map<string, { text: string; lastSentLength: number; lastSentAt: number }>();
  private readonly progressCards = new Map<string, { messageId: string; sections: Map<string, ProgressSection>; lastUpdatedAt: number }>();
  private codexOnlyCompletionTimer: NodeJS.Timeout | null = null;
  private codexOnlyCompletionScanRunning = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly repo: Repository,
    private readonly codex: CodexClient,
    private readonly feishu: FeishuSender,
    private readonly logger: Logger,
    private readonly diagnostics: DiagnosticsService = new DiagnosticsService(config, repo, codex)
  ) {
    this.cards = new CardRenderer(config.feishu.interactionMode);
    this.projection = new ProjectionBuilder(repo);
    this.security = new SecurityPolicy(config, repo);
    this.codex.on("notification", (message) => this.handleCodexNotification(message).catch((error) => this.logger.error("codex notification handling failed", { error: String(error), message })));
    this.codex.on("serverRequest", (message) => this.handleCodexServerRequest(message).catch((error) => this.logger.error("codex server request handling failed", { error: String(error), message })));
  }

  async bootstrapProjectsFromConfig(options: { reconcile?: boolean } = {}): Promise<void> {
    this.repo.upsertBridgeDevice({
      id: this.config.machine.id,
      machineName: this.config.machine.name,
      codexHome: this.config.storage.homeDir,
      status: "active"
    });
    if (this.config.feishu.defaultChatId) {
      this.repo.upsertTrustedFeishuSubject({
        chatId: this.config.feishu.defaultChatId,
        role: "owner",
        status: "active"
      });
    }
    for (const project of this.config.projects) {
      this.repo.upsertProject({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        feishuChatId: project.feishuChatId,
        defaultModel: project.defaultModel,
        defaultReasoningEffort: project.defaultReasoningEffort,
        approvalPolicy: project.approvalPolicy,
        sandboxPolicy: project.sandboxPolicy
      });
    }
    if (options.reconcile !== false) {
      await this.reconcilePersistedBindings();
    }
  }

  async bootstrapRuntimeState(): Promise<void> {
    await this.syncCodexAppWorkspaces();
    await this.reconcilePersistedBindings();
    await this.scanCodexOnlyCompletions();
  }

  startCodexOnlyCompletionWatch(): void {
    if (!this.config.bridge.codexOnlyCompletionWatchEnabled) return;
    if (this.codexOnlyCompletionTimer) return;
    this.codexOnlyCompletionTimer = setInterval(() => {
      this.scanCodexOnlyCompletions().catch((error) => {
        this.logger.warn("codex-only completion scan failed", { error: String(error) });
      });
    }, this.config.bridge.codexOnlyCompletionPollMs);
  }

  stopCodexOnlyCompletionWatch(): void {
    if (this.codexOnlyCompletionTimer) clearInterval(this.codexOnlyCompletionTimer);
    this.codexOnlyCompletionTimer = null;
  }

  async scanCodexOnlyCompletions(): Promise<number> {
    const defaultChatId = this.config.feishu.defaultChatId;
    if (!defaultChatId) return 0;
    if (!this.config.bridge.codexOnlyCompletionWatchEnabled) return 0;
    if (this.codexOnlyCompletionScanRunning) return 0;
    this.codexOnlyCompletionScanRunning = true;
    try {
      const threads = await this.codex.listThreads(this.config.bridge.threadListLimit);
      let enqueued = 0;
      for (const thread of threads) {
        if (isSubAgentThread(thread)) continue;
        const binding = this.repo.findBindingByThreadId(thread.id);
        if (this.repo.findIgnoredThread(thread.id)) continue;
        const detail = await this.codex.readThread(thread.id, true).catch((error) => {
          this.logger.warn("codex-only completion thread read failed", { threadId: thread.id, error: String(error) });
          return null;
        });
        const detailThread = detail ? normalizeThreadFromDetail(thread.id, detail) : thread;
        if (isSubAgentThread(detailThread)) continue;
        if (binding) {
          if (detailThread.status === "running" && binding.status !== "running") {
            const activeTurnId = activeTurnIdFromThreadDetail(detail) ?? binding.lastTurnId;
            this.repo.updateBindingStatus(binding.id, "running", activeTurnId);
            this.repo.insertEvent({
              sessionBindingId: binding.id,
              codexThreadId: binding.codexThreadId,
              codexTurnId: activeTurnId,
              eventType: "session.reconciled_active_turn",
              eventPayload: {
                previousStatus: binding.status,
                currentStatus: "running",
                source: "codex_only_completion_scan"
              }
            });
            await this.updateTaskCard(binding.id);
          }
          continue;
        }
        if (detailThread.status === "running") continue;
        const state = normalizeThreadCompletionState(thread, detail);
        if (!state || !isRecentCodexOnlyCompletion(state.updatedAt, this.config.bridge.codexOnlyCompletionLookbackMs)) {
          continue;
        }
        const threadCwd = detailThread.cwd ?? thread.cwd;
        const threadTitle = detailThread.title ?? detailThread.preview ?? thread.title ?? thread.preview ?? thread.id;
        const project = this.repo.findProjectForPath(threadCwd);
        const summary =
          state.report?.finalResult
            ? truncatePlain(singleLine(state.report.finalResult), 220)
            : state.report?.reasoningSummary
              ? truncatePlain(singleLine(state.report.reasoningSummary), 220)
              : detailThread.preview ?? thread.preview
                ? truncatePlain(singleLine(detailThread.preview ?? thread.preview ?? ""), 220)
                : null;
        const before = this.repo.getOutboxByDedupeKey(codexOnlyCompletionDedupeKey(thread.id, state.turnId, state.status));
        this.repo.enqueueOutbox({
          notificationType: codexOnlyCompletionNotificationType(state.status),
          feishuChatId: defaultChatId,
          payload: {
            card: this.cards.codexOnlyCompletionCard({
              id: thread.id,
              title: threadTitle,
              status: state.status,
              cwd: threadCwd,
              projectName: project?.name ?? null,
              updatedAt: state.updatedAt,
              summary
            })
          },
          dedupeKey: codexOnlyCompletionDedupeKey(thread.id, state.turnId, state.status)
        });
        if (!before) enqueued += 1;
      }
      if (enqueued > 0) {
        this.logger.info("codex-only completion reminders enqueued", { count: enqueued });
      }
      return enqueued;
    } finally {
      this.codexOnlyCompletionScanRunning = false;
    }
  }

  async syncCodexAppWorkspaces(): Promise<WorkspaceImportSummary> {
    const candidates = await this.discoverCodexAppWorkspaces();
    const knownBefore = this.repo.listProjects();
    const knownRoots = new Set(knownBefore.map((project) => normalizeWorkspacePath(project.rootPath)));
    let imported = 0;
    let matched = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const normalized = normalizeWorkspacePath(candidate.rootPath);
      if (!normalized || knownRoots.has(normalized)) {
        if (normalized) matched += 1;
        else skipped += 1;
        continue;
      }
      const project = this.repo.upsertProject({
        name: candidate.name,
        rootPath: candidate.rootPath,
        feishuChatId: this.config.feishu.defaultChatId ?? null,
        defaultModel: this.config.codex.defaultModel,
        defaultReasoningEffort: this.config.codex.defaultReasoningEffort,
        approvalPolicy: this.config.codex.defaultApprovalPolicy,
        sandboxPolicy: this.config.codex.defaultSandboxMode
      });
      this.repo.addProjectMatchRule({
        projectId: project.id,
        ruleType: "cwd_prefix",
        ruleValue: candidate.rootPath
      });
      knownRoots.add(normalized);
      imported += 1;
    }
    this.logger.info("codex app workspace sync completed", {
      discovered: candidates.length,
      imported,
      matched,
      skipped,
      sources: [...new Set(candidates.map((candidate) => candidate.source))]
    });
    return {
      imported,
      matched,
      skipped,
      sources: [...new Set(candidates.map((candidate) => candidate.source))]
    };
  }

  private async discoverCodexAppWorkspaces(): Promise<Array<{ name: string; rootPath: string; source: string }>> {
    const seen = new Set<string>();
    const candidates: Array<{ name: string; rootPath: string; source: string }> = [];
    const push = (rootPath: string | null | undefined, source: string): void => {
      if (!rootPath) return;
      const resolved = resolveWorkspacePath(rootPath);
      const normalized = normalizeWorkspacePath(resolved);
      if (!normalized || seen.has(normalized)) return;
      if (!existsSync(resolved)) return;
      seen.add(normalized);
      candidates.push({
        name: inferProjectName(resolved, basename(resolved)),
        rootPath: resolved,
        source
      });
    };

    for (const entry of readCodexAppWorkspaceRoots(this.config.codex.appStatePath)) {
      push(entry.rootPath, entry.source);
    }
    return candidates;
  }

  async reconcilePersistedBindings(): Promise<void> {
    for (const binding of this.repo.listBindings(this.config.bridge.threadListLimit)) {
      if (binding.status === "waiting_for_prompt" || binding.codexThreadId.startsWith("draft_")) {
        continue;
      }
      try {
        const detail = await this.readThreadForReconcile(binding);
        const thread = normalizeThreadFromDetail(binding.codexThreadId, detail);
        if (thread.status === "running" && binding.status !== "running") {
          const activeTurnId = activeTurnIdFromThreadDetail(detail) ?? binding.lastTurnId;
          this.repo.updateBindingStatus(binding.id, "running", activeTurnId);
          this.repo.insertEvent({
            sessionBindingId: binding.id,
            codexThreadId: binding.codexThreadId,
            codexTurnId: activeTurnId,
            eventType: "session.reconciled_active_turn",
            eventPayload: {
              previousStatus: binding.status,
              currentStatus: "running",
              source: "persisted_binding_reconcile"
            }
          });
          await this.updateTaskCard(binding.id);
          continue;
        }
        const latestTerminalTurn = latestTerminalTurnFromThreadDetail(detail);
        if (latestTerminalTurn && latestTerminalTurn.status !== binding.status) {
          const turnId = latestTerminalTurn.id;
          const summaryText =
            latestTerminalTurn.status === "completed"
              ? latestTerminalTurn.report?.finalResult
                ? truncatePlain(singleLine(latestTerminalTurn.report.finalResult), 90)
                : "已完成。需要细节时发送 /logs 查看任务记录。"
              : formatTurnTerminalSummary(latestTerminalTurn.status, latestTerminalTurn.raw);
          const eventType = latestTerminalTurn.status === "completed" ? "task.completed" : `task.${latestTerminalTurn.status}`;
          const existingTerminalEvent = this.repo
            .listEventsForBinding(binding.id, 200)
            .some((event) => event.eventType === eventType && event.codexTurnId === turnId);
          this.repo.updateBindingStatus(binding.id, latestTerminalTurn.status, turnId);
          if (!existingTerminalEvent) {
            this.repo.insertEvent({
              sessionBindingId: binding.id,
              codexThreadId: binding.codexThreadId,
              codexTurnId: turnId,
              eventType,
              eventPayload: {
                text: summaryText,
                reasoningSummary: latestTerminalTurn.report?.reasoningSummary ?? null,
                finalResult: latestTerminalTurn.report?.finalResult ?? null,
                workspaceCheckpointId: null,
                subAgents: [],
                turn: latestTerminalTurn.raw,
                source: "persisted_binding_reconcile"
              }
            });
          }
          this.repo.insertEvent({
            sessionBindingId: binding.id,
            codexThreadId: binding.codexThreadId,
            codexTurnId: turnId,
            eventType: "session.reconciled_terminal_turn",
            eventPayload: {
              previousStatus: binding.status,
              currentStatus: latestTerminalTurn.status,
              turnId
            }
          });
          await this.updateTaskTitle(binding.id, latestTerminalTurn.status, binding.title ?? "Codex 任务");
          await this.updateTaskCard(binding.id);
          continue;
        }
        const historyStatus = this.latestStateFromHistory(binding.id);
        if (thread.status === "idle" && historyStatus && isTerminalStatus(historyStatus)) {
          if (binding.status !== historyStatus) {
            this.repo.updateBindingStatus(binding.id, historyStatus, binding.lastTurnId);
            this.repo.insertEvent({
              sessionBindingId: binding.id,
              codexThreadId: binding.codexThreadId,
              eventType: "session.reconcile_restored_terminal_status",
              eventPayload: {
                previousStatus: binding.status,
                restoredStatus: historyStatus
              }
            });
          }
          continue;
        }
        if (thread.status === "idle" && isTerminalStatus(binding.status)) {
          continue;
        }
        if (thread.status !== binding.status) {
          this.repo.updateBindingStatus(binding.id, thread.status);
          this.repo.insertEvent({
            sessionBindingId: binding.id,
            codexThreadId: binding.codexThreadId,
            eventType: "session.reconciled",
            eventPayload: {
              previousStatus: binding.status,
              currentStatus: thread.status
            }
          });
          await this.updateTaskCard(binding.id);
        }
      } catch (error) {
        this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: binding.codexThreadId,
          eventType: "session.reconcile_failed",
          eventPayload: { error: String(error) }
        });
      }
    }
  }

  private async readThreadForReconcile(binding: SessionBinding): Promise<Record<string, unknown>> {
    try {
      return await this.codex.readThread(binding.codexThreadId, true);
    } catch (error) {
      if (!isTerminalStatus(binding.status)) throw error;
      const unarchive = (this.codex as unknown as { unarchiveThread?: (threadId: string) => Promise<Record<string, unknown>> }).unarchiveThread;
      if (!unarchive) throw error;
      await unarchive.call(this.codex, binding.codexThreadId);
      this.repo.insertEvent({
        sessionBindingId: binding.id,
        codexThreadId: binding.codexThreadId,
        eventType: "session.unarchived_codex_thread",
        eventPayload: { reason: "restore_completed_thread_visibility" }
      });
      return this.codex.readThread(binding.codexThreadId, false);
    }
  }

  async showConsole(chatId: string, rootMessageId?: string | null): Promise<void> {
    const running = this.repo.count("session_bindings", "status = 'running'");
    const approvals = this.repo.count("pending_approvals", "status = 'pending'");
    const queued = this.repo.count("message_queue", "status = 'queued'");
    const completedToday = this.repo.count(
      "session_bindings",
      `status = 'completed' AND updated_at >= '${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}'`
    );
    const card = this.cards.consoleCard({
      running,
      approvals,
      queued,
      completedToday,
      recentTasks: this.listTaskSummaries("recent", 5).map((task) => ({
        title: task.title,
        status: task.status,
        projectName: task.projectName,
        model: task.model,
        reasoningEffort: task.reasoningEffort
      }))
    });
    await this.feishu.sendCard(chatId, card, rootMessageId);
  }

  async listClaimableSessions(chatId: string, rootMessageId?: string | null, projectId?: string | null): Promise<void> {
    const threads = await this.codex.listThreads(this.config.bridge.threadListLimit);
    const filtered = threads
      .map((thread) => {
        const binding = this.repo.findBindingByThreadId(thread.id);
        const project =
          (binding?.projectId ? this.repo.getProject(binding.projectId) : null) ?? this.repo.findProjectForPath(thread.cwd);
        const ignored = this.repo.findIgnoredThread(thread.id);
        return {
          thread,
          binding,
          project,
          ignored
        };
      })
      .filter(({ project, ignored }) => !ignored && (!projectId || project?.id === projectId));
    if (filtered.length === 0) {
      await this.feishu.sendText(chatId, "没有发现可接管的本机 Codex 任务。", rootMessageId);
      return;
    }
    await this.feishu.sendCard(
      chatId,
      this.cards.claimableSessionsCard(
        filtered.map(({ thread, binding, project }) => ({
          id: thread.id,
          title: thread.title ?? thread.preview ?? thread.id,
          status: thread.status,
          cwd: thread.cwd,
          projectName: project?.name ?? null,
          claimed: Boolean(binding),
          bindingId: binding?.id ?? null,
          rootMessageId: binding?.feishuTopicRootMessageId ?? null,
          unclassified: !project
        }))
      ),
      rootMessageId
    );
  }

  async handleMessage(message: FeishuIncomingMessage): Promise<void> {
    this.security.assertFeishuMessageAllowed(message);
    const text = normalizeMessageText(message);
    const normalizedMessage: FeishuIncomingMessage = { ...message, text };
    const incoming = this.repo.beginIncomingMessage({
      messageId: normalizedMessage.messageId,
      chatId: normalizedMessage.chatId,
      userId: normalizedMessage.userId,
      text
    });
    if (incoming.duplicate) {
      this.logger.warn("duplicate feishu message ignored", {
        messageId: normalizedMessage.messageId,
        chatId: normalizedMessage.chatId,
        deliveries: incoming.deliveries
      });
      return;
    }
    if (text === "/codex" || text === "codex") {
      await this.showConsole(message.chatId, message.rootMessageId ?? message.messageId);
      return;
    }
    if (text === "/doctor" || text === "诊断") {
      await this.sendDoctorCard(message.chatId, message.rootMessageId ?? message.messageId);
      return;
    }
    if (text === "/tasks" || text === "接管电脑任务") {
      await this.listClaimableSessions(message.chatId, message.rootMessageId ?? message.messageId);
      return;
    }
    this.repo.upsertTrustedFeishuSubject({
      chatId: normalizedMessage.chatId,
      userId: normalizedMessage.userId,
      role: "owner",
      status: "active"
    });
    if (await this.tryHandleMessageCommand(normalizedMessage, text)) {
      return;
    }
    const rootMessageId = normalizedMessage.rootMessageId ?? normalizedMessage.messageId;
    const binding =
      (normalizedMessage.threadId ? this.repo.findBindingByFeishuThreadId(normalizedMessage.chatId, normalizedMessage.threadId) : null) ??
      (normalizedMessage.parentMessageId ? this.repo.findBindingByTaskCardMessageId(normalizedMessage.chatId, normalizedMessage.parentMessageId) : null) ??
      this.repo.findBindingByTopic(normalizedMessage.chatId, rootMessageId) ??
      this.repo.findBindingByChatId(normalizedMessage.chatId);
    if (binding) {
      if (binding.status === "waiting_for_prompt") {
        await this.startNewTaskFromPrompt(binding, normalizedMessage);
        return;
      }
      await this.continueBindingFromFeishu(binding, normalizedMessage);
      return;
    }
    await this.createNewTaskFromFeishu(normalizedMessage);
  }

  async handleCardAction(action: FeishuCardAction): Promise<Record<string, unknown>> {
    this.security.assertFeishuAllowed(action.userId, action.chatId || this.config.feishu.defaultChatId || "");
    this.repo.upsertTrustedFeishuSubject({
      chatId: action.chatId || this.config.feishu.defaultChatId || null,
      userId: action.userId,
      role: "owner",
      status: "active"
    });
    const { existing } = this.repo.beginAction({
      actionId: action.actionId,
      actionType: action.action,
      payload: action.payload,
      requestedByFeishuUserId: action.userId
    });
    if (existing?.status === "completed") return existing.result ?? { ok: true, repeated: true };
    try {
      const result = await this.dispatchCardAction(action);
      this.repo.completeAction(action.actionId, result);
      return result;
    } catch (error) {
      const result = { ok: false, error: String(error) };
      this.repo.failAction(action.actionId, result);
      throw error;
    }
  }

  async processCardActionDeferred(action: FeishuCardAction): Promise<void> {
    try {
      const result = await this.handleCardAction(action);
      if (result.repeated === true) return;
      const text = typeof result.text === "string" ? result.text.trim() : "";
      if (!text) return;
      await this.sendTextToTarget(this.resolveActionReplyTarget(action), text);
    } catch (error) {
      this.logger.error("feishu card action failed", {
        action: action.action,
        actionId: action.actionId,
        chatId: action.chatId,
        error: String(error)
      });
      try {
        await this.sendTextToTarget(
          this.resolveActionReplyTarget(action),
          `按钮处理失败：${error instanceof Error ? error.message : String(error)}`
        );
      } catch (notifyError) {
        const fallbackChatId = action.chatId || this.config.feishu.defaultChatId || "";
        this.logger.error("feishu card action failure notification failed", {
          action: action.action,
          actionId: action.actionId,
          chatId: fallbackChatId,
          error: String(notifyError)
        });
      }
    }
  }

  taskDetailData(bindingId: string): Record<string, unknown> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) throw new Error("任务不存在");
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const events = this.repo.listEventsForBinding(binding.id, 500);
    const checkpoints = this.repo.listWorkspaceCheckpoints(binding.id, 50);
    const pair = this.repo.findWorkspaceCheckpointPair(binding.id, binding.lastTurnId);
    const impact = compareWorkspaceManifests(pair.start, pair.end);
    return {
      binding,
      project,
      status: this.projection.buildTaskStatus(binding.id),
      process: this.buildTaskProcessProjection(binding),
      impact,
      checkpoints,
      events
    };
  }

  async claimThread(params: {
    thread: CodexThreadSummary;
    chatId: string;
    rootMessageId: string;
    userId: string;
    skipCardRefresh?: boolean;
  }): Promise<SessionBinding> {
    const project = this.repo.findProjectForContext({
      cwd: params.thread.cwd
    });
    const binding = this.repo.createOrUpdateBinding({
      projectId: project?.id ?? null,
      codexThreadId: params.thread.id,
      feishuChatId: params.chatId,
      feishuTopicRootMessageId: params.rootMessageId,
      title: params.thread.title ?? params.thread.preview ?? "Codex 任务",
      cwd: params.thread.cwd,
      selectedModel: projectModel(project, this.config),
      selectedReasoningEffort: projectReasoningEffort(project, this.config),
      status: params.thread.status,
      createdByFeishuUserId: params.userId,
      createdFrom: "codex_app_claimed"
    });
    this.repo.upsertThreadOwnership({
      codexThreadId: binding.codexThreadId,
      ownerKind: "feishu_bridge",
      ownerClientId: this.config.machine.id,
      confidence: "high"
    });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
        codexThreadId: binding.codexThreadId,
        eventType: "session.claimed",
        eventPayload: { title: binding.title, cwd: binding.cwd }
      });
    if (!params.skipCardRefresh) {
      await this.updateTaskCard(binding.id);
    }
    return binding;
  }

  private async createNewTaskFromFeishu(message: FeishuIncomingMessage): Promise<void> {
    await this.syncCodexAppWorkspaces();
    const pendingPrompt = this.repo.createPendingProjectPrompt({
      feishuMessageId: message.messageId,
      feishuChatId: message.chatId,
      feishuUserId: message.userId,
      text: message.text,
      attachments: message.attachments ?? []
    });
    await this.feishu.sendCard(
      message.chatId,
      this.cards.projectListCard(this.repo.listProjects(), { pendingPromptId: pendingPrompt.id }),
      message.rootMessageId ?? message.messageId
    );
  }

  private async startProjectTaskFromPrompt(input: {
    project: Project;
    prompt: string;
    userId: string;
    sourceMessageId: string;
    sourceChatId: string;
    sourceRootMessageId?: string | null;
    attachments?: FeishuMessageAttachment[];
  }): Promise<void> {
    const threadCreation = await this.canCreateDesktopThreadFromFeishu();
    if (!threadCreation.ok) {
      return this.startDesktopIpcProjectTaskFromPrompt(input, threadCreation.guidance);
    }
    const title = summarizeTitle(input.prompt);
    const container = await this.ensureTaskContainer(
      {
        chatId: input.project.feishuChatId ?? input.sourceChatId,
        title,
        card: this.cards.waitingForPromptCard(input.project)
      },
      { userId: input.userId }
    );
    if (container.kind === "dedicated_chat") {
      await this.feishu.sendText(container.chatId, `任务：${title}\n\n后续补充、/status、/logs、/archive 都在这个会话里发送。`);
      await this.repo.beginIncomingMessage({
        messageId: `system:${container.chatId}:${input.sourceMessageId}`,
        chatId: container.chatId,
        userId: input.userId,
        text: input.prompt
      });
    }
    const thread = await this.codex.startThread({
      cwd: input.project.rootPath,
      model: projectModel(input.project, this.config),
      reasoningEffort: projectReasoningEffort(input.project, this.config)
    });
    const codexInput = await this.resolveCodexMessageInput({
      messageId: input.sourceMessageId,
      prompt: input.prompt,
      attachments: input.attachments
    });
    const binding = this.repo.createOrUpdateBinding({
      projectId: input.project.id,
      codexThreadId: thread.id,
      feishuChatId: container.chatId,
      feishuTopicRootMessageId: container.rootMessageId,
      feishuThreadId: container.threadId,
      feishuTaskCardMessageId: container.cardMessageId,
      feishuContainerKind: container.kind,
      feishuControlChatId: container.controlChatId,
      title,
      cwd: thread.cwd ?? input.project.rootPath,
      selectedModel: projectModel(input.project, this.config),
      selectedReasoningEffort: projectReasoningEffort(input.project, this.config),
      status: "running",
      createdByFeishuUserId: input.userId,
      createdFrom: "feishu_new_task"
    });
    this.repo.upsertThreadOwnership({
      codexThreadId: binding.codexThreadId,
      ownerKind: "feishu_bridge",
      ownerClientId: this.config.machine.id,
      confidence: "high"
    });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.created_from_feishu",
      eventPayload: { text: input.prompt, attachments: describeFeishuAttachments(input.attachments) },
      feishuMessageId: input.sourceMessageId
    });
    const startCheckpoint = await this.captureCheckpointForWorkspace({
      binding,
      codexThreadId: thread.id,
      workspaceRoot: thread.cwd ?? input.project.rootPath ?? binding.cwd ?? null,
      kind: "turn_start",
      turnId: null,
      note: "任务开始前"
    });
    const turn = await this.codex.startTurn(binding.codexThreadId, codexInput.prompt, {
      cwd: binding.cwd,
      model: resolveBindingModel(binding, input.project, this.config),
      reasoningEffort: resolveBindingReasoningEffort(binding, input.project, this.config),
      attachments: codexInput.attachments
    });
    const turnId = extractTurnId(turn);
    if (startCheckpoint && turnId) this.repo.updateWorkspaceCheckpointTurnId(startCheckpoint.id, turnId);
    this.repo.updateBindingStatus(binding.id, "running", turnId);
    await this.updateTaskTitle(binding.id, "running", title);
    await this.updateTaskCard(binding.id);
  }

  private async startNewTaskFromPrompt(binding: SessionBinding, message: FeishuIncomingMessage): Promise<void> {
    const threadCreation = await this.canCreateDesktopThreadFromFeishu();
    if (!threadCreation.ok) {
      await this.sendTextToTarget(
        this.targetForBinding(binding, message.chatId),
        threadCreation.guidance ?? await this.desktopIpcCreationUnavailableGuidance()
      );
      await this.updateTaskCard(binding.id);
      return;
    }
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const thread = await this.codex.startThread({
      cwd: project?.rootPath ?? binding.cwd ?? null,
      model: projectModel(project, this.config),
      reasoningEffort: projectReasoningEffort(project, this.config)
    });
    const title = summarizeTitle(message.text);
    const startCheckpoint = await this.captureCheckpoint(binding.id, "turn_start", null, "任务开始前");
    const codexInput = await this.resolveCodexMessageInput({
      messageId: message.messageId,
      prompt: message.text,
      attachments: message.attachments
    });
    const turn = await this.codex.startTurn(thread.id, codexInput.prompt, {
      cwd: thread.cwd ?? project?.rootPath ?? binding.cwd ?? null,
      model: resolveBindingModel(binding, project, this.config),
      reasoningEffort: resolveBindingReasoningEffort(binding, project, this.config),
      attachments: codexInput.attachments
    });
    const turnId = extractTurnId(turn);
    if (startCheckpoint && turnId) this.repo.updateWorkspaceCheckpointTurnId(startCheckpoint.id, turnId);
    this.repo.activateDraftBinding({
      bindingId: binding.id,
      codexThreadId: thread.id,
      projectId: project?.id ?? null,
      title,
      cwd: thread.cwd ?? project?.rootPath ?? binding.cwd ?? null,
      status: "running",
      lastTurnId: turnId
    });
    this.repo.upsertThreadOwnership({
      codexThreadId: thread.id,
      ownerKind: "feishu_bridge",
      ownerClientId: this.config.machine.id,
      confidence: "high"
    });
    this.repo.updateBindingSettings({
      bindingId: binding.id,
      selectedModel: binding.selectedModel ?? projectModel(project, this.config),
      selectedReasoningEffort: binding.selectedReasoningEffort ?? projectReasoningEffort(project, this.config)
    });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: thread.id,
      eventType: "task.created_from_feishu",
      eventPayload: { text: message.text, fromDraft: true, attachments: describeFeishuAttachments(codexInput.feishuAttachments) },
      feishuMessageId: message.messageId
    });
    await this.updateTaskTitle(binding.id, "running", title);
    await this.updateTaskCard(binding.id);
  }

  private async startDesktopIpcProjectTaskFromPrompt(input: {
    project: Project;
    prompt: string;
    userId: string;
    sourceMessageId: string;
    sourceChatId: string;
    sourceRootMessageId?: string | null;
    attachments?: FeishuMessageAttachment[];
  }, guidanceOverride?: string | null): Promise<void> {
    const title = summarizeTitle(input.prompt);
    const container = await this.ensureTaskContainer(
      {
        chatId: input.project.feishuChatId ?? input.sourceChatId,
        title,
        card: this.cards.waitingForPromptCard(input.project)
      },
      { userId: input.userId }
    );
    if (container.kind === "dedicated_chat") {
      await this.feishu.sendText(container.chatId, `任务：${title}\n\n后续补充、/status、/logs、/archive 都在这个会话里发送。`);
      await this.repo.beginIncomingMessage({
        messageId: `system:${container.chatId}:${input.sourceMessageId}`,
        chatId: container.chatId,
        userId: input.userId,
        text: input.prompt
      });
    }
    const binding = this.repo.createOrUpdateBinding({
      projectId: input.project.id,
      codexThreadId: newId("draft"),
      feishuChatId: container.chatId,
      feishuTopicRootMessageId: container.rootMessageId,
      feishuThreadId: container.threadId,
      feishuTaskCardMessageId: container.cardMessageId,
      feishuContainerKind: container.kind,
      feishuControlChatId: container.controlChatId,
      title,
      cwd: input.project.rootPath,
      selectedModel: projectModel(input.project, this.config),
      selectedReasoningEffort: projectReasoningEffort(input.project, this.config),
      status: "waiting_for_prompt",
      createdByFeishuUserId: input.userId,
      createdFrom: "feishu_new_task"
    });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.desktop_thread_creation_unavailable",
      eventPayload: {
        text: guidanceOverride ?? [
          "当前运行态只能接管已有 Desktop 线程。",
          "本次需求没有自动创建新对话，也没有发送到 Codex Desktop。",
          "如需继续，请先发送 /tasks 接管已有线程，再把需求补发到对应任务会话。"
        ].join("\n"),
        prompt: input.prompt,
        desktopIpc: this.codex.connectionKind === "desktop_ipc",
        desktopProxy: this.codex.connectionKind === "desktop_proxy",
        attachments: describeFeishuAttachments(input.attachments)
      },
      feishuMessageId: input.sourceMessageId
    });
    await this.updateTaskTitle(binding.id, "waiting_for_prompt", title);
    await this.updateTaskCard(binding.id);
    await this.sendTextToTarget(
      this.targetForBinding(binding, container.chatId),
      [
        "当前不能从飞书直接新建新对话。",
        guidanceOverride ?? await this.desktopIpcCreationUnavailableGuidance(),
        "这条需求已保留在飞书草稿会话里，但还没有发给任何 Desktop 线程。"
      ].join("\n")
    );
  }

  private async continueBindingFromFeishu(binding: SessionBinding, message: FeishuIncomingMessage): Promise<void> {
    if (binding.codexThreadId.startsWith("pending_desktop_")) {
      this.repo.resetBindingToWaitingForPrompt({
        bindingId: binding.id,
        codexThreadId: newId("draft"),
        projectId: binding.projectId,
        title: binding.title,
        cwd: binding.cwd,
        lastTurnId: null
      });
      const repaired = this.repo.findBindingById(binding.id) ?? binding;
      this.repo.insertEvent({
        sessionBindingId: repaired.id,
        codexThreadId: repaired.codexThreadId,
        eventType: "task.desktop_placeholder_recovered",
        eventPayload: {
          previousThreadId: binding.codexThreadId,
          reason: "legacy_pending_desktop_binding_recovered"
        },
        feishuMessageId: message.messageId
      });
      await this.updateTaskTitle(repaired.id, "waiting_for_prompt", repaired.title ?? "新任务");
      await this.updateTaskCard(repaired.id);
      await this.sendTextToTarget(
        this.targetForBinding(repaired, message.chatId),
        "检测到旧的无效 Desktop 占位任务，已自动恢复为可重试草稿。请重新发送需求。"
      );
      return;
    }
    const codexInput = await this.resolveCodexMessageInput({
      messageId: message.messageId,
      prompt: message.text,
      attachments: message.attachments
    });
    if (binding.status === "running") {
      try {
        await this.codex.steerTurn(binding.codexThreadId, codexInput.prompt, codexInput.attachments);
        this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: binding.codexThreadId,
          eventType: "turn.steer_requested_from_feishu",
          eventPayload: { text: message.text, attachments: describeFeishuAttachments(codexInput.feishuAttachments) },
          feishuMessageId: message.messageId
        });
        await this.sendTextToTarget(this.targetForBinding(binding, message.chatId), "已追加要求，当前任务会优先按这条继续处理。");
        return;
      } catch (error) {
        this.logger.warn("codex steer failed, fallback to queue", {
          bindingId: binding.id,
          threadId: binding.codexThreadId,
          error: String(error)
        });
      }
    }
    if (binding.status === "running" || binding.status === "waiting_for_approval") {
      const queued = this.repo.enqueueMessage({
        sessionBindingId: binding.id,
        feishuMessageId: message.messageId,
        text: codexInput.prompt,
        attachments: codexInput.feishuAttachments,
        createdByFeishuUserId: message.userId
      });
      await this.sendTextToTarget(
        this.targetForBinding(binding, message.chatId),
        `已收到，当前任务完成后继续处理。\n\n排队：第 ${queued.position} 条`
      );
      await this.updateTaskCard(binding.id);
      return;
    }
    this.resetProgressState(binding.id);
    this.repo.updateBindingStatus(binding.id, "running");
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "turn.requested_from_feishu",
      eventPayload: { text: message.text, attachments: describeFeishuAttachments(codexInput.feishuAttachments) },
      feishuMessageId: message.messageId
    });
    await this.updateTaskTitle(binding.id, "running", binding.title ?? "Codex 任务");
    await this.updateTaskCard(binding.id);
    await this.codex.resumeThread(binding.codexThreadId);
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const startCheckpoint = await this.captureCheckpoint(binding.id, "turn_start", null, "继续处理前");
    const turn = await this.codex.startTurn(binding.codexThreadId, codexInput.prompt, {
      cwd: binding.cwd,
      model: resolveBindingModel(binding, project, this.config),
      reasoningEffort: resolveBindingReasoningEffort(binding, project, this.config),
      attachments: codexInput.attachments
    });
    const turnId = extractTurnId(turn);
    if (startCheckpoint && turnId) this.repo.updateWorkspaceCheckpointTurnId(startCheckpoint.id, turnId);
    if (turnId) this.repo.updateBindingStatus(binding.id, "running", turnId);
  }

  private async dispatchCardAction(action: FeishuCardAction): Promise<Record<string, unknown>> {
    switch (action.action) {
      case "doctor":
        await this.sendDoctorCard(action.chatId || this.config.feishu.defaultChatId || "", action.rootMessageId);
        return { ok: true, action: "doctor" };
      case "diagnostic_recover":
        return this.runDiagnosticRecover(action);
      case "new_task":
        await this.sendNewTaskDraft(action);
        return { ok: true };
      case "claim_sessions":
        await this.listClaimableSessions(
          action.chatId || this.config.feishu.defaultChatId || "",
          action.rootMessageId,
          asString(action.payload.projectId)
        );
        return { ok: true };
      case "claim_thread":
        return this.claimThreadById(action);
      case "claim_summary":
        await this.sendClaimSummary(action);
        return { ok: true };
      case "claim_ignore":
        return this.ignoreClaimableThread(action);
      case "unclassified_create_project":
        return this.createProjectFromThread(action);
      case "unclassified_pick_project":
        await this.showProjectAssignment(action);
        return { ok: true };
      case "unclassified_assign_project":
        return this.assignThreadToProject(action);
      case "open_bound_topic":
        return this.openBoundTopic(action);
      case "project_list":
        await this.sendProjectList(action);
        return { ok: true };
      case "project_open":
        await this.sendProjectOpen(action);
        return { ok: true };
      case "project_start_prompt":
        await this.startPendingPromptForProject(action);
        return { ok: true };
      case "project_settings":
        await this.sendProjectSettings(action);
        return { ok: true };
      case "project_setting_model":
        await this.updateProjectSettingModel(action);
        return { ok: true, text: "项目默认模型已更新，新任务会按新模型执行。" };
      case "project_setting_reasoning":
        await this.updateProjectSettingReasoning(action);
        return { ok: true, text: "项目默认思考强度已更新，新任务会按新设置执行。" };
      case "project_notification_level":
        await this.updateProjectNotificationLevel(action);
        return { ok: true, text: "项目通知级别已更新。" };
      case "project_tasks":
        await this.sendProjectTaskList(action, "recent");
        return { ok: true };
      case "project_running":
        await this.sendProjectTaskList(action, "running");
        return { ok: true };
      case "project_completed":
        await this.sendProjectTaskList(action, "completed");
        return { ok: true };
      case "unclassified_threads":
        await this.sendUnclassifiedThreads(action);
        return { ok: true };
      case "send_test_notification":
        await this.sendTestNotification(action);
        return { ok: true };
      case "notification_history":
        await this.sendNotificationHistory(action);
        return { ok: true };
      case "notification_settings_global":
        await this.sendGlobalNotificationSettings(action);
        return { ok: true };
      case "notification_level_set":
        await this.updateNotificationLevel(action);
        return { ok: true, text: "通知级别已更新。" };
      case "task_list_recent":
        await this.sendTaskList(action, "recent");
        return { ok: true };
      case "task_list_running":
        await this.sendTaskList(action, "running");
        return { ok: true };
      case "task_list_completed":
        await this.sendTaskList(action, "completed");
        return { ok: true };
      case "task_list_failed":
        await this.sendTaskList(action, "failed");
        return { ok: true };
      case "task_list_archived":
        await this.sendTaskList(action, "archived");
        return { ok: true };
      case "task_search":
        await this.sendTaskSearch(action);
        return { ok: true };
      case "approval_list_all":
        await this.sendApprovalListAll(action);
        return { ok: true };
      case "server_request_list":
        await this.sendPendingServerRequestList(action);
        return { ok: true };
      case "task_status":
        await this.sendTaskStatus(action);
        return { ok: true };
      case "task_logs":
        await this.sendTaskProcess(action);
        return { ok: true };
      case "task_impact":
        await this.sendTaskImpact(action);
        return { ok: true };
      case "task_restore_confirm":
        await this.sendTaskRestoreConfirm(action);
        return { ok: true };
      case "task_restore_apply":
        await this.applyTaskRestore(action);
        return { ok: true };
      case "task_detail":
        await this.sendTaskDetail(action);
        return { ok: true };
      case "task_settings":
        await this.sendTaskSettings(action);
        return { ok: true };
      case "task_setting_model":
        await this.updateTaskSettingModel(action);
        return { ok: true, text: "模型已更新，下一轮处理会按新模型执行。" };
      case "task_setting_reasoning":
        await this.updateTaskSettingReasoning(action);
        return { ok: true, text: "思考强度已更新，下一轮处理会按新设置执行。" };
      case "task_continue":
      case "task_append_hint":
        return { ok: true, text: "请直接在当前任务会话回复要追加的要求。" };
      case "task_run_tests":
        await this.startSyntheticInstruction(action, "请根据当前项目的测试配置运行相关测试；如果失败，先分析原因，再修复。");
        return { ok: true };
      case "queue_view":
        await this.sendQueueCard(action);
        return { ok: true };
      case "queue_cancel":
        await this.cancelQueuedMessage(action);
        return { ok: true, text: "已处理队列操作。" };
      case "task_stop":
        await this.stopTask(String(action.payload.bindingId ?? ""));
        return { ok: true };
      case "task_retry":
        await this.startSyntheticInstruction(action, "请重试刚才失败的任务；先复盘失败原因，再继续执行。");
        return { ok: true };
      case "task_analyze_failure":
        await this.startSyntheticInstruction(action, "请分析刚才任务失败的原因，给出修复方案，并在安全范围内修复。");
        return { ok: true };
      case "task_archive":
        await this.archiveTask(String(action.payload.bindingId ?? ""));
        return { ok: true, text: "任务已归档。" };
      case "task_unarchive":
        await this.unarchiveTask(String(action.payload.bindingId ?? ""));
        return { ok: true, text: "任务已恢复，可继续处理。" };
      case "new_related_task":
        await this.sendNewTaskDraft(action);
        return { ok: true };
      case "approval_list":
        await this.sendApprovalList(action);
        return { ok: true };
      case "approval_detail":
        await this.sendApprovalDetail(action);
        return { ok: true };
      case "approval_once":
        await this.resolveApproval(String(action.payload.approvalId ?? ""), "once", action.userId);
        return { ok: true };
      case "approval_for_task":
        await this.resolveApproval(String(action.payload.approvalId ?? ""), "task", action.userId);
        return { ok: true };
      case "approval_deny":
        await this.resolveApproval(String(action.payload.approvalId ?? ""), "deny", action.userId);
        return { ok: true };
      case "server_request_detail":
        await this.sendServerRequestDetail(action);
        return { ok: true };
      case "server_request_resolve":
        await this.resolveServerRequest(action);
        return { ok: true, text: "已提交到当前 Desktop 任务。" };
      default:
        return { ok: true, ignored: action.action };
    }
  }

  private async tryHandleMessageCommand(message: FeishuIncomingMessage, text: string): Promise<boolean> {
    if (!isCommandText(text)) return false;
    const rootMessageId = message.rootMessageId ?? message.messageId;
    try {
      const action = this.parseMessageCommand(message, text, rootMessageId);
      if (!action) return false;
      const result = await this.handleCardAction(action);
      const resultText = typeof result.text === "string" ? result.text.trim() : "";
      if (resultText) {
        await this.feishu.sendText(message.chatId, resultText, rootMessageId);
      } else if (shouldAckCommand(action.action)) {
        await this.feishu.sendText(message.chatId, "已处理。", rootMessageId);
      }
    } catch (error) {
      await this.feishu.sendText(
        message.chatId,
        `命令处理失败：${error instanceof Error ? error.message : String(error)}`,
        rootMessageId
      );
    }
    return true;
  }

  private parseMessageCommand(message: FeishuIncomingMessage, text: string, rootMessageId: string): FeishuCardAction | null {
    const parts = splitCommand(text);
    const command = parts[0] ?? "";
    if (!command) return null;
    const currentBinding =
      (message.threadId ? this.repo.findBindingByFeishuThreadId(message.chatId, message.threadId) : null) ??
      this.repo.findBindingByTopic(message.chatId, rootMessageId) ??
      this.repo.findBindingByChatId(message.chatId);
    const actionId = newId("cmd");
    const base = (action: string, payload: Record<string, unknown> = {}, root = rootMessageId): FeishuCardAction => ({
      actionId,
      action,
      userId: message.userId,
      chatId: message.chatId,
      rootMessageId: root,
      payload
    });

    if (command === "projects") return base("project_list");
    if (command === "unclassified") return base("unclassified_threads");
    if (command === "recent") return base("task_list_recent");
    if (command === "running") return base("task_list_running");
    if (command === "completed") return base("task_list_completed");
    if (command === "failed") return base("task_list_failed");
    if (command === "archived") return base("task_list_archived");
    if (command === "search") {
      return base("task_search", { query: requireArgument(parts.slice(1).join(" "), "/search <关键词>") });
    }
    if (command === "create-project") {
      return base("unclassified_create_project", {
        codexThreadId: requireArgument(parts[1], "/create-project <codexThreadId>")
      });
    }
    if (command === "pick-project") {
      return base("unclassified_pick_project", {
        codexThreadId: requireArgument(parts[1], "/pick-project <codexThreadId>")
      });
    }
    if (command === "assign-project") {
      return base("unclassified_assign_project", {
        codexThreadId: requireArgument(parts[1], "/assign-project <codexThreadId> <projectId>"),
        projectId: requireArgument(parts[2], "/assign-project <codexThreadId> <projectId>")
      });
    }
    if (command === "status") return base("task_status", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "logs") return base("task_logs", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "impact") return base("task_impact", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "detail") return base("task_detail", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "settings") return base("task_settings", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "queue") {
      if (parts[1]?.toLowerCase() === "cancel") {
        return base("queue_cancel", {
          bindingId: requireCurrentBindingId(currentBinding, command),
          queueId: requireArgument(parts[2], "/queue cancel <queueId>")
        });
      }
      return base("queue_view", { bindingId: requireCurrentBindingId(currentBinding, command) });
    }
    if (command === "claim") {
      if (parts[1]?.toLowerCase() === "summary") {
        return base("claim_summary", { codexThreadId: requireArgument(parts[2], "/claim summary <codexThreadId>") });
      }
      if (parts[1]?.toLowerCase() === "ignore") {
        return base("claim_ignore", { codexThreadId: requireArgument(parts[2], "/claim ignore <codexThreadId>") });
      }
      return base("claim_thread", { codexThreadId: requireArgument(parts[1], "/claim <codexThreadId>") });
    }
    if (command === "notify") {
      const sub = parts[1] ?? "";
      if (sub === "test") return base("send_test_notification");
      if (sub === "history") return base("notification_history");
      throw new Error("未知通知命令，请使用 /notify test 或 /notify history。");
    }
    if (command === "run-tests") return base("task_run_tests", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "stop") return base("task_stop", { bindingId: parts[1] ?? requireCurrentBindingId(currentBinding, command) });
    if (command === "retry") return base("task_retry", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "analyze-failure") return base("task_analyze_failure", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "archive") return base("task_archive", { bindingId: requireCurrentBindingId(currentBinding, command) });
    if (command === "approval") {
      const sub = parts[1] ?? "";
      if (sub === "list") {
        return base("approval_list", { bindingId: requireCurrentBindingId(currentBinding, command) });
      }
      if (sub === "detail") {
        return base("approval_detail", { approvalId: requireArgument(parts[2], "/approval detail <approvalId>") });
      }
      const approvalId = requireArgument(parts[2], "/approval once|task|deny <approvalId>");
      if (sub === "once") return base("approval_once", { approvalId });
      if (sub === "task") return base("approval_for_task", { approvalId });
      if (sub === "deny") return base("approval_deny", { approvalId });
      throw new Error("未知审批命令，请使用 /approval list、/approval detail <id>、/approval once <id>、/approval task <id> 或 /approval deny <id>。");
    }
    if (command === "request") {
      const sub = parts[1] ?? "";
      if (sub === "detail") {
        return base("server_request_detail", { requestId: requireArgument(parts[2], "/request detail <requestId>") });
      }
      if (sub === "allow" || sub === "accept") {
        return base("server_request_resolve", {
          requestId: requireArgument(parts[2], "/request allow|accept <requestId>"),
          resolution: "accept_once"
        });
      }
      if (sub === "session") {
        return base("server_request_resolve", {
          requestId: requireArgument(parts[2], "/request session <requestId>"),
          resolution: "accept_session"
        });
      }
      if (sub === "deny") {
        return base("server_request_resolve", {
          requestId: requireArgument(parts[2], "/request deny <requestId>"),
          resolution: "deny"
        });
      }
      if (sub === "abort" || sub === "cancel") {
        return base("server_request_resolve", {
          requestId: requireArgument(parts[2], "/request abort|cancel <requestId>"),
          resolution: "abort"
        });
      }
      if (sub === "input") {
        return base("server_request_resolve", {
          requestId: requireArgument(parts[2], "/request input <requestId> <json>"),
          resolution: "custom_input",
          responseJson: requireArgument(parts.slice(3).join(" "), "/request input <requestId> <json>")
        });
      }
      throw new Error("未知请求命令，请使用 /request detail <id>、/request allow <id>、/request session <id>、/request deny <id>、/request abort <id> 或 /request input <id> <json>。");
    }
    return null;
  }

  private async sendNewTaskDraft(action: FeishuCardAction): Promise<void> {
    const projectId = asString(action.payload.projectId) ?? this.projectIdFromBindingPayload(action);
    if (!projectId) {
      await this.sendProjectList(action);
      return;
    }
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const chatId = project?.feishuChatId ?? action.chatId ?? this.config.feishu.defaultChatId ?? "";
    const card = project ? this.cards.waitingForPromptCard(project) : this.cards.newTaskDraftCard();
    const container = await this.ensureTaskContainer({
      chatId,
      title: project ? `新任务：${project.name}` : "新任务",
      card
    }, { userId: action.userId });
    if (container.kind === "dedicated_chat") {
      await this.feishu.sendText(container.chatId, "请直接发送你希望 Codex 完成的事情。");
    }
    this.repo.createOrUpdateBinding({
      projectId: project?.id ?? null,
      codexThreadId: newId("draft"),
      feishuChatId: container.chatId,
      feishuTopicRootMessageId: container.rootMessageId,
      feishuThreadId: container.threadId,
      feishuTaskCardMessageId: container.cardMessageId,
      feishuContainerKind: container.kind,
      feishuControlChatId: container.controlChatId,
      title: "新任务",
      cwd: project?.rootPath ?? null,
      status: "waiting_for_prompt",
      createdByFeishuUserId: action.userId,
      createdFrom: "feishu_new_task"
    });
  }

  private async ensureTaskContainer(
    input: {
      chatId: string;
      title: string;
      card: ReturnType<CardRenderer["newTaskDraftCard"]>;
    },
    actor?: { userId?: string | null }
  ): Promise<TaskContainer> {
    if (this.config.feishu.taskContainerMode === "dedicated_chat") {
      try {
        return await this.ensureTaskChat(input, actor);
      } catch (error) {
        this.logger.warn("feishu task chat creation failed", { error: String(error), title: input.title });
        if (!this.config.feishu.taskChatFallbackToTopic) throw error;
      }
    }
    return this.ensureTaskTopic(input);
  }

  private async ensureTaskChat(
    input: {
      chatId: string;
      title: string;
      card: ReturnType<CardRenderer["newTaskDraftCard"]>;
    },
    actor?: { userId?: string | null }
  ): Promise<TaskContainer> {
    const sequence = this.repo.count("session_bindings") + 1;
    const rootKey = `task-${Date.now().toString(36)}-${sequence.toString().padStart(3, "0")}`;
    const name = buildTaskChatName(this.config, rootKey, input.title);
    const created = await this.feishu.createTaskChat({
      name,
      userIds: actor?.userId ? [actor.userId] : [],
      chatType: this.config.feishu.taskChatType,
      description: "Codex 独立任务会话",
      setBotManager: this.config.feishu.taskChatSetBotManager
    });
    return {
      chatId: created.chatId,
      rootMessageId: rootKey,
      threadId: null,
      cardMessageId: null,
      kind: "dedicated_chat",
      controlChatId: input.chatId
    };
  }

  /**
   * Creates a Feishu task topic anchor owned by the bridge so later replies can
   * consistently stay inside the same thread instead of piggybacking on a user message.
   */
  private async ensureTaskTopic(input: {
    chatId: string;
    title: string;
    card: ReturnType<CardRenderer["newTaskDraftCard"]>;
  }): Promise<TaskContainer> {
    const anchor = await this.feishu.sendText(input.chatId, input.title);
    const sent = await this.feishu.replyCardInThread(anchor.messageId, input.card);
    return {
      chatId: input.chatId,
      rootMessageId: sent.rootId ?? anchor.messageId,
      threadId: sent.threadId,
      cardMessageId: sent.messageId,
      kind: "topic",
      controlChatId: null
    };
  }

  private async sendDoctorCard(chatId: string, rootMessageId?: string | null): Promise<void> {
    await this.feishu.sendCard(chatId, this.cards.diagnosticCard(await this.diagnostics.snapshot()), rootMessageId);
  }

  private async runDiagnosticRecover(action: FeishuCardAction): Promise<Record<string, unknown>> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.feishu.sendText(chatId, "正在恢复：检查 Codex 连接、重置失败通知、同步任务状态。", action.rootMessageId);
    const before = await this.diagnostics.snapshot();
    let codexRecovered = false;
    if (before.appServerStatus !== "connected") {
      await this.codex.stop().catch((error) => {
        this.logger.warn("codex stop during recovery failed", { error: String(error) });
      });
      await this.codex.start();
      codexRecovered = true;
    } else {
      await this.codex.start();
    }
    const resetOutbox = this.repo.resetDeadOutbox(50);
    await this.reconcilePersistedBindings();
    const after = await this.diagnostics.snapshot();
    await this.feishu.sendCard(chatId, this.cards.diagnosticCard(after), action.rootMessageId);
    return {
      ok: true,
      text: [
        "恢复完成。",
        `Codex：${before.appServerStatus} -> ${after.appServerStatus}${codexRecovered ? "（已重启）" : ""}`,
        `失败通知重置：${resetOutbox} 条`,
        "长连接如果处于 SDK 自动重连中，会继续由飞书 SDK 维持；如仍无事件，请重启 bridge 进程。"
      ].join("\n")
    };
  }

  private async claimThreadById(action: FeishuCardAction): Promise<Record<string, unknown>> {
    const threadId = String(action.payload.codexThreadId ?? "");
    if (!threadId) throw new Error("缺少 Codex 任务 ID");
    const existing = this.repo.findBindingByThreadId(threadId);
    if (existing) {
      return {
        ok: true,
        text:
          existing.feishuContainerKind === "dedicated_chat"
            ? "这个任务已经有独立会话，请直接去对应任务会话继续，不会再把内容回发到主控群。"
            : "这个任务已经绑定到原话题，请直接去对应任务话题继续，不会再把内容回发到主控群。"
      };
    }
    const detail = await this.codex.readThread(threadId, false);
    const thread = normalizeThreadFromDetail(threadId, detail);
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    const title = thread.title ?? thread.preview ?? thread.id;
    const container = await this.ensureTaskContainer({
      chatId,
      title: `任务接管：${title}`,
      card: this.cards.taskStatusCard({
        bindingId: "pending",
        title,
        projectName: "未归类项目",
        status: thread.status,
        cwd: thread.cwd,
        selectedModel: null,
        selectedReasoningEffort: null,
        subAgents: [],
        queuedMessages: 0,
        pendingApprovals: 0,
        lastTurnId: null,
        lastSummary: "正在接管本机 Codex 任务。",
        updatedAt: new Date().toISOString()
      })
    }, { userId: action.userId });
    const binding = await this.claimThread({
      thread,
      chatId: container.chatId,
      rootMessageId: container.rootMessageId,
      userId: action.userId,
      skipCardRefresh: true
    });
    this.repo.updateBindingTopic({
      bindingId: binding.id,
      feishuChatId: container.chatId,
      feishuTopicRootMessageId: container.rootMessageId,
      feishuThreadId: container.threadId,
      feishuTaskCardMessageId: container.cardMessageId,
      feishuContainerKind: container.kind,
      feishuControlChatId: container.controlChatId
    });
    await this.updateTaskTitle(binding.id, binding.status, title);
    await this.updateTaskCard(binding.id);
    return { ok: true };
  }

  private async sendProjectList(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.syncCodexAppWorkspaces();
    const projects = this.repo.listProjects();
    await this.feishu.sendCard(chatId, this.cards.projectListCard(projects), action.rootMessageId);
  }

  private async sendProjectOpen(action: FeishuCardAction): Promise<void> {
    const project = this.requireProject(action);
    await this.feishu.sendCard(
      action.chatId || this.config.feishu.defaultChatId || "",
      this.cards.projectCard(this.buildProjectCardInput(project)),
      action.rootMessageId
    );
  }

  private async startPendingPromptForProject(action: FeishuCardAction): Promise<void> {
    const project = this.requireProject(action);
    const pendingPromptId = String(action.payload.pendingPromptId ?? "").trim();
    if (!pendingPromptId) throw new Error("缺少待处理任务");
    const prompt = this.repo.consumePendingProjectPrompt(pendingPromptId, project.id);
    if (!prompt) {
      await this.feishu.sendText(
        action.chatId || this.config.feishu.defaultChatId || "",
        "这条任务已经被处理过，或已经过期。请重新发送需求。",
        action.rootMessageId
      );
      return;
    }
    await this.startProjectTaskFromPrompt({
      project,
      prompt: prompt.text,
      userId: action.userId,
      sourceMessageId: prompt.feishuMessageId,
      sourceChatId: prompt.feishuChatId,
      sourceRootMessageId: action.rootMessageId,
      attachments: prompt.attachments
    });
  }

  private async sendProjectSettings(action: FeishuCardAction): Promise<void> {
    const projectId = String(action.payload.projectId ?? "");
    if (!projectId) throw new Error("缺少项目 ID");
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const models = await this.getModelOptions();
    await this.feishu.sendCard(
      action.chatId || this.config.feishu.defaultChatId || "",
      this.cards.projectSettingsCard({
        projectId: project.id,
        projectName: project.name,
        rootPath: project.rootPath,
        currentModel: projectModel(project, this.config),
        currentReasoningEffort: projectReasoningEffort(project, this.config),
        currentNotificationLevel: resolveProjectNotificationLevel(project),
        modelOptions: prioritizeModels(models, projectModel(project, this.config)),
        reasoningOptions: prioritizeReasoningOptions(
          models,
          projectModel(project, this.config),
          projectReasoningEffort(project, this.config)
        )
      }),
      action.rootMessageId
    );
  }

  private async updateProjectSettingModel(action: FeishuCardAction): Promise<void> {
    const projectId = String(action.payload.projectId ?? "").trim();
    const model = String(action.payload.model ?? "").trim();
    if (!projectId) throw new Error("缺少项目 ID");
    if (!model) throw new Error("缺少模型参数");
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    this.repo.updateProjectDefaults({ projectId, defaultModel: model });
  }

  private async updateProjectSettingReasoning(action: FeishuCardAction): Promise<void> {
    const projectId = String(action.payload.projectId ?? "").trim();
    const reasoningEffort = String(action.payload.reasoningEffort ?? "").trim();
    if (!projectId) throw new Error("缺少项目 ID");
    if (!reasoningEffort) throw new Error("缺少思考强度参数");
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    this.repo.updateProjectDefaults({ projectId, defaultReasoningEffort: reasoningEffort });
  }

  private async updateProjectNotificationLevel(action: FeishuCardAction): Promise<void> {
    const projectId = String(action.payload.projectId ?? "").trim();
    const level = String(action.payload.level ?? "").trim();
    if (!projectId) throw new Error("缺少项目 ID");
    if (!level) throw new Error("缺少通知级别参数");
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    this.repo.updateProjectNotificationPolicy(projectId, level);
  }

  private async sendUnclassifiedThreads(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    const threads = await this.codex.listThreads(this.config.bridge.threadListLimit);
    const unclassified = (
      await Promise.all(
        threads.map(async (thread) => {
          if (this.repo.findIgnoredThread(thread.id)) return null;
          const binding = this.repo.findBindingByThreadId(thread.id);
          if (binding?.projectId) return null;
          const project = await this.classifyThreadContext(thread, binding);
          return project ? null : thread;
        })
      )
    ).filter((thread): thread is CodexThreadSummary => Boolean(thread));
    await this.feishu.sendCard(
      chatId,
      this.cards.unclassifiedThreadsCard(
        unclassified.map((thread) => ({
          id: thread.id,
          title: thread.title ?? thread.preview ?? thread.id,
          cwd: thread.cwd,
          status: thread.status,
          canCreateProject: Boolean(thread.cwd)
        }))
      ),
      action.rootMessageId
    );
  }

  private async classifyThreadContext(
    thread: CodexThreadSummary,
    binding?: SessionBinding | null
  ): Promise<Project | null> {
    return this.repo.findProjectForContext({
      cwd: thread.cwd ?? binding?.cwd
    });
  }

  private async sendClaimSummary(action: FeishuCardAction): Promise<void> {
    const threadId = String(action.payload.codexThreadId ?? "");
    if (!threadId) throw new Error("缺少 Codex 任务 ID");
    const existing = this.repo.findBindingByThreadId(threadId);
    if (existing?.feishuContainerKind === "dedicated_chat") {
      await this.feishu.sendText(
        action.chatId || this.config.feishu.defaultChatId || "",
        "这个任务已经进入独立会话，请在对应任务会话里查看处理记录；主控群不再展示子会话内容。",
        action.rootMessageId
      );
      return;
    }
    const detail = await this.codex.readThread(threadId, true);
    const thread = normalizeThreadFromDetail(threadId, detail);
    const summary = summarizeThreadDetail(detail);
    await this.feishu.sendText(
      action.chatId || this.config.feishu.defaultChatId || "",
      [
        `任务摘要：${thread.title ?? thread.preview ?? thread.id}`,
        `状态：${thread.status}`,
        `目录：${thread.cwd ?? "未知"}`,
        summary
      ]
        .filter(Boolean)
        .join("\n"),
      action.rootMessageId
    );
  }

  private async ignoreClaimableThread(action: FeishuCardAction): Promise<Record<string, unknown>> {
    const threadId = String(action.payload.codexThreadId ?? "");
    if (!threadId) throw new Error("缺少 Codex 任务 ID");
    const detail = await this.codex.readThread(threadId, false);
    const thread = normalizeThreadFromDetail(threadId, detail);
    this.repo.ignoreThread({
      codexThreadId: thread.id,
      title: thread.title ?? thread.preview ?? thread.id,
      cwd: thread.cwd,
      reason: "feishu_claim_ignored",
      createdByFeishuUserId: action.userId
    });
    return { ok: true, text: "已忽略这个任务；后续不会再出现在接管列表里。" };
  }

  private async createProjectFromThread(action: FeishuCardAction): Promise<Record<string, unknown>> {
    const threadId = String(action.payload.codexThreadId ?? "");
    if (!threadId) throw new Error("缺少 Codex 任务 ID");
    const detail = await this.codex.readThread(threadId, false);
    const thread = normalizeThreadFromDetail(threadId, detail);
    if (!thread.cwd) throw new Error("这个任务没有可用工作目录，无法创建项目。");
    const projectName = inferProjectName(thread.cwd, thread.title ?? thread.preview ?? thread.id);
    const project = this.repo.upsertProject({
      name: projectName,
      rootPath: thread.cwd,
      feishuChatId: action.chatId || this.config.feishu.defaultChatId || null
    });
    this.repo.addProjectMatchRule({
      projectId: project.id,
      ruleType: "cwd_prefix",
      ruleValue: thread.cwd
    });
    const binding = this.repo.findBindingByThreadId(thread.id);
    if (binding) {
      this.repo.updateBindingProject(binding.id, project.id);
    }
    this.repo.unignoreThread(thread.id);
    return { ok: true, text: `已创建项目：${project.name}` };
  }

  private async showProjectAssignment(action: FeishuCardAction): Promise<void> {
    const threadId = String(action.payload.codexThreadId ?? "");
    if (!threadId) throw new Error("缺少 Codex 任务 ID");
    const detail = await this.codex.readThread(threadId, false);
    const thread = normalizeThreadFromDetail(threadId, detail);
    await this.feishu.sendCard(
      action.chatId || this.config.feishu.defaultChatId || "",
      this.cards.projectAssignmentCard(
        {
          id: thread.id,
          title: thread.title ?? thread.preview ?? thread.id,
          cwd: thread.cwd
        },
        this.repo.listProjects().map((project) => ({
          id: project.id,
          name: project.name,
          rootPath: project.rootPath
        }))
      ),
      action.rootMessageId
    );
  }

  private async assignThreadToProject(action: FeishuCardAction): Promise<Record<string, unknown>> {
    const threadId = String(action.payload.codexThreadId ?? "");
    const projectId = String(action.payload.projectId ?? "");
    if (!threadId) throw new Error("缺少 Codex 任务 ID");
    if (!projectId) throw new Error("缺少项目 ID");
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const detail = await this.codex.readThread(threadId, false);
    const thread = normalizeThreadFromDetail(threadId, detail);
    if (thread.cwd) {
      this.repo.addProjectMatchRule({
        projectId,
        ruleType: "cwd_prefix",
        ruleValue: thread.cwd
      });
    }
    const binding = this.repo.findBindingByThreadId(threadId);
    if (binding) {
      this.repo.updateBindingProject(binding.id, projectId);
    }
    this.repo.unignoreThread(threadId);
    return { ok: true, text: `已将任务归入项目：${project.name}` };
  }

  private async openBoundTopic(action: FeishuCardAction): Promise<Record<string, unknown>> {
    const binding = this.requireBinding(action);
    return {
      ok: true,
      text: binding.feishuContainerKind === "dedicated_chat"
        ? "这个任务已有独立会话，请直接去对应任务会话继续；主控群不再同步子会话内容。"
        : "这个任务已绑定到原话题，请直接去对应任务话题继续；主控群不再同步详细内容。"
    };
  }

  private async sendTestNotification(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.feishu.sendText(chatId, "测试通知：Bridge 可以向飞书发送消息。", action.rootMessageId);
  }

  private async sendNotificationHistory(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.feishu.sendCard(chatId, this.cards.notificationHistoryCard(this.repo.listRecentOutbox(20)), action.rootMessageId);
  }

  private async sendGlobalNotificationSettings(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    const current = this.repo.getNotificationPreference("global", "bridge", null)?.level ?? "important";
    await this.feishu.sendCard(
      chatId,
      this.cards.notificationSettingsCard({
        title: "通知设置",
        scopeType: "global",
        scopeId: "bridge",
        currentLevel: current,
        description: "这里控制默认主动通知策略。状态卡刷新和手动查看不受影响。"
      }),
      action.rootMessageId
    );
  }

  private async updateNotificationLevel(action: FeishuCardAction): Promise<void> {
    const scopeType = String(action.payload.scopeType ?? "").trim() as "global" | "project" | "session";
    const scopeId = String(action.payload.scopeId ?? "").trim();
    const level = String(action.payload.level ?? "").trim() as NotificationLevel;
    if (!scopeType) throw new Error("缺少通知作用域");
    if (!scopeId) throw new Error("缺少通知作用域 ID");
    if (!level) throw new Error("缺少通知级别");
    this.repo.upsertNotificationPreference({
      scopeType,
      scopeId,
      level
    });
  }

  private async sendTaskList(action: FeishuCardAction, kind: TaskListKind): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    const titleMap: Record<TaskListKind, string> = {
      recent: "最近任务",
      running: "运行中任务",
      completed: "已完成任务",
      failed: "失败/中断任务",
      archived: "已归档任务"
    };
    if (kind === "archived") {
      const tasks = this.repo
        .listBindingsByStatuses(["archived"], 10)
        .map((binding) => {
          const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
          return {
            bindingId: binding.id,
            title: binding.title ?? "Codex 任务",
            projectName: project?.name ?? "未归类项目",
            status: binding.status,
            updatedAt: binding.updatedAt
          };
        });
      await this.feishu.sendCard(chatId, this.cards.archivedTaskCenterCard(tasks), action.rootMessageId);
      return;
    }
    await this.feishu.sendCard(chatId, this.cards.taskListCard(titleMap[kind], this.listTaskSummaries(kind, 10)), action.rootMessageId);
  }

  private async sendProjectTaskList(action: FeishuCardAction, kind: "recent" | "running" | "completed"): Promise<void> {
    const project = this.requireProject(action);
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    const titleMap = {
      recent: `${project.name}｜对话`,
      running: `${project.name}｜运行中`,
      completed: `${project.name}｜已完成`
    };
    await this.feishu.sendCard(
      chatId,
      this.cards.taskListCard(titleMap[kind], this.listTaskSummaries(kind, 20, project.id)),
      action.rootMessageId
    );
  }

  private async sendTaskSearch(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    const query = String(action.payload.query ?? "").trim();
    if (!query) throw new Error("缺少搜索关键词");
    const tasks = this.repo.searchBindings(query, 10).map((binding) => {
      const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
      return {
        bindingId: binding.id,
        title: binding.title ?? "Codex 任务",
        status: binding.status,
        projectName: project?.name ?? "未归类项目",
        updatedAt: binding.updatedAt
      };
    });
    await this.feishu.sendCard(chatId, this.cards.taskSearchCard({ query, tasks }), action.rootMessageId);
  }

  private async sendApprovalListAll(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.feishu.sendCard(chatId, this.cards.approvalListCard(this.repo.listPendingApprovals()), action.rootMessageId);
  }

  private async sendPendingServerRequestList(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    const requests = this.repo.listPendingServerRequests().map((request) => {
      const payload = parseStoredServerRequestPayload(request.payload);
      return {
        title: payload ? serverRequestTitleText(payload.method) : "桌面请求",
        requestId: request.actionId,
        createdAt: request.createdAt,
        detail: payload ? `线程：${payload.threadId}` : "请求记录已损坏"
      };
    });
    await this.feishu.sendCard(chatId, this.cards.pendingServerRequestListCard(requests), action.rootMessageId);
  }

  private async sendTaskStatus(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.taskStatusCard(this.projection.buildTaskStatus(binding.id))
    );
  }

  private async sendTaskProcess(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.taskProcessCard(this.buildTaskProcessProjection(binding))
    );
  }

  private async sendTaskImpact(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    const fallbackPair = this.workspaceCheckpointPair(binding);
    const impact = compareWorkspaceManifests(fallbackPair.start, fallbackPair.end);
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.taskImpactCard({
        bindingId: binding.id,
        title: binding.title ?? "Codex 任务",
        impact,
        startCheckpoint: fallbackPair.start,
        endCheckpoint: fallbackPair.end,
        detailUrl: this.localTaskDetailUrl(binding.id)
      })
    );
  }

  private async sendTaskRestoreConfirm(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    const pair = this.workspaceCheckpointPair(binding);
    const impact = compareWorkspaceManifests(pair.start, pair.end);
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.taskRestoreConfirmCard({
        bindingId: binding.id,
        title: binding.title ?? "Codex 任务",
        impact
      })
    );
  }

  private async applyTaskRestore(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    const pair = this.workspaceCheckpointPair(binding);
    if (!pair.start || !pair.end) throw new Error("缺少可撤销的检查点");
    await this.captureCheckpoint(binding.id, "manual", binding.lastTurnId, "撤销前备份");
    const result = restoreWorkspaceFromCheckpoints(pair.start, pair.end);
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      codexTurnId: binding.lastTurnId,
      eventType: "workspace.restore_applied",
      eventPayload: { result }
    });
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.taskRestoreResultCard({
        title: binding.title ?? "Codex 任务",
        result
      })
    );
  }

  private async sendTaskDetail(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    const status = this.projection.buildTaskStatus(binding.id);
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.taskDetailCard({
        bindingId: binding.id,
        title: status.title,
        status: status.status,
        projectName: status.projectName,
        cwd: status.cwd,
        model: status.selectedModel,
        reasoningEffort: status.selectedReasoningEffort,
        subAgents: status.subAgents,
        queuedMessages: status.queuedMessages,
        pendingApprovals: status.pendingApprovals,
        checkpoints: this.repo.listWorkspaceCheckpoints(binding.id, 100).length,
        updatedAt: status.updatedAt,
        lastSummary: status.lastSummary,
        detailUrl: this.localTaskDetailUrl(binding.id)
      })
    );
  }

  private async sendTaskSettings(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const models = await this.getModelOptions();
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.taskSettingsCard({
        bindingId: binding.id,
        title: binding.title ?? "Codex 任务",
        projectName: project?.name ?? "未归类项目",
        currentModel: resolveBindingModel(binding, project, this.config),
        currentReasoningEffort: resolveBindingReasoningEffort(binding, project, this.config),
        currentNotificationLevel: this.repo.getNotificationPreference("session", binding.id, null)?.level ?? resolveProjectNotificationLevel(project),
        modelOptions: prioritizeModels(models, resolveBindingModel(binding, project, this.config)),
        reasoningOptions: prioritizeReasoningOptions(
          models,
          resolveBindingModel(binding, project, this.config),
          resolveBindingReasoningEffort(binding, project, this.config)
        )
      })
    );
  }

  private async updateTaskSettingModel(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    const model = String(action.payload.model ?? "").trim();
    if (!model) throw new Error("缺少模型参数");
    this.repo.updateBindingSettings({ bindingId: binding.id, selectedModel: model });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.settings_updated",
      eventPayload: { selectedModel: model }
    });
    await this.updateTaskCard(binding.id);
  }

  private async updateTaskSettingReasoning(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    const reasoningEffort = String(action.payload.reasoningEffort ?? "").trim();
    if (!reasoningEffort) throw new Error("缺少思考强度参数");
    this.repo.updateBindingSettings({ bindingId: binding.id, selectedReasoningEffort: reasoningEffort });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.settings_updated",
      eventPayload: { selectedReasoningEffort: reasoningEffort }
    });
    await this.updateTaskCard(binding.id);
  }

  private async sendApprovalList(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.approvalListCard(this.repo.listPendingApprovals(binding.id))
    );
  }

  private async sendApprovalDetail(action: FeishuCardAction): Promise<void> {
    const approvalId = String(action.payload.approvalId ?? "");
    const approval = this.repo.findApprovalById(approvalId);
    if (!approval) throw new Error("审批不存在");
    const binding = this.repo.findBindingById(approval.sessionBindingId);
    await this.sendCardToTarget(
      binding ? this.targetForBinding(binding, action.chatId) : this.targetForAction(action),
      this.cards.approvalDetailCard(approval)
    );
  }

  private async sendServerRequestDetail(action: FeishuCardAction): Promise<void> {
    const request = this.requireStoredServerRequest(String(action.payload.requestId ?? ""));
    const payload = parseStoredServerRequestPayload(request.payload);
    const binding = payload ? this.repo.findBindingById(payload.bindingId) : null;
    await this.sendCardToTarget(
      binding ? this.targetForBinding(binding, action.chatId) : this.targetForAction(action),
      this.buildStoredServerRequestDetailCard(request)
    );
  }

  private async resolveServerRequest(action: FeishuCardAction): Promise<void> {
    const request = this.requireStoredServerRequest(String(action.payload.requestId ?? ""));
    if (request.status === "completed") return;
    const payload = parseStoredServerRequestPayload(request.payload);
    if (!payload) throw new Error("请求记录已损坏");
    const binding = this.repo.findBindingById(payload.bindingId);
    if (!binding) throw new Error("请求对应的任务不存在");
    const response = buildStoredServerRequestResponse(request, action.payload, action.formValue ?? null);
    await this.submitStoredServerRequest(payload, response);
    this.repo.completeAction(request.actionId, {
      response,
      resolution: action.payload.resolution ?? null,
      formValue: action.formValue ?? null
    });
    this.repo.updateBindingStatus(binding.id, "running", payload.turnId);
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: payload.threadId,
      codexTurnId: payload.turnId,
      eventType: "server_request.resolved",
      eventPayload: {
        requestId: payload.requestId,
        method: payload.method,
        resolution: action.payload.resolution ?? null
      }
    });
    await this.updateTaskCard(binding.id);
  }

  private async archiveTask(bindingId: string): Promise<void> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) throw new Error("任务不存在");
    this.repo.updateBindingStatus(binding.id, "archived");
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.archived",
      eventPayload: {}
    });
    await this.codex.archiveThread(binding.codexThreadId).catch((error) => {
      this.logger.warn("codex thread archive failed", { bindingId, threadId: binding.codexThreadId, error: String(error) });
    });
    await this.updateTaskTitle(binding.id, "archived", binding.title ?? "Codex 任务");
    await this.updateTaskCard(binding.id);
  }

  private async unarchiveTask(bindingId: string): Promise<void> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) throw new Error("任务不存在");
    await this.codex.unarchiveThread(binding.codexThreadId).catch((error) => {
      this.logger.warn("codex thread unarchive failed", { bindingId, threadId: binding.codexThreadId, error: String(error) });
    });
    this.repo.updateBindingStatus(binding.id, "idle");
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.unarchived",
      eventPayload: {}
    });
    await this.updateTaskTitle(binding.id, "idle", binding.title ?? "Codex 任务");
    await this.updateTaskCard(binding.id);
  }

  private async sendQueueCard(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.queueCard(binding.id, this.repo.listQueuedMessages(binding.id))
    );
  }

  private async cancelQueuedMessage(action: FeishuCardAction): Promise<void> {
    const queueId = String(action.payload.queueId ?? "");
    const binding = this.requireBinding(action);
    const cancelled = this.repo.cancelQueuedMessage(queueId);
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "queue.cancelled",
      eventPayload: { queueId, cancelled }
    });
    await this.updateTaskCard(binding.id);
  }

  private async startSyntheticInstruction(action: FeishuCardAction, instruction: string): Promise<void> {
    const binding = this.requireBinding(action);
    await this.continueBindingFromFeishu(binding, {
      messageId: newId("synthetic_msg"),
      chatId: binding.feishuChatId,
      rootMessageId: binding.feishuTopicRootMessageId,
      threadId: binding.feishuThreadId,
      userId: action.userId,
      text: instruction
    });
  }

  private async stopTask(bindingId: string): Promise<void> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) throw new Error("任务不存在");
    if (!binding.lastTurnId) throw new Error("当前任务没有可中断的 turnId");
    await this.codex.interruptTurn(binding.codexThreadId, binding.lastTurnId);
    this.repo.updateBindingStatus(binding.id, "interrupted");
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "turn.interrupted_by_feishu",
      eventPayload: {}
    });
    await this.updateTaskCard(binding.id);
  }

  private requireBinding(action: FeishuCardAction): SessionBinding {
    const bindingId = String(action.payload.bindingId ?? "");
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) throw new Error("任务不存在");
    return binding;
  }

  private requireProject(action: FeishuCardAction): Project {
    const projectId = String(action.payload.projectId ?? "");
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    return project;
  }

  private projectIdFromBindingPayload(action: FeishuCardAction): string | null {
    const bindingId = asString(action.payload.bindingId);
    if (!bindingId) return null;
    return this.repo.findBindingById(bindingId)?.projectId ?? null;
  }

  /**
   * Returns the canonical Feishu reply target for a bound task so later status,
   * approval and queue messages stay inside the same reply thread.
   */
  private targetForBinding(binding: SessionBinding, chatId?: string | null): FeishuReplyTarget {
    if (binding.feishuContainerKind === "dedicated_chat") {
      return {
        chatId: binding.feishuChatId,
        rootMessageId: firstRealFeishuMessageId(binding.feishuTaskCardMessageId, binding.feishuTopicRootMessageId),
        threadId: firstRealFeishuThreadId(binding.feishuThreadId)
      };
    }
    return {
      chatId: chatId || binding.feishuChatId || this.config.feishu.defaultChatId || "",
      rootMessageId: binding.feishuTopicRootMessageId,
      threadId: binding.feishuThreadId
    };
  }

  private targetForAction(action: FeishuCardAction): FeishuReplyTarget {
    return {
      chatId: action.chatId || this.config.feishu.defaultChatId || "",
      rootMessageId: action.rootMessageId
    };
  }

  private resolveActionReplyTarget(action: FeishuCardAction): FeishuReplyTarget {
    const bindingId = asString(action.payload.bindingId);
    if (bindingId) {
      const binding = this.repo.findBindingById(bindingId);
      if (binding) return this.targetForBinding(binding, action.chatId);
    }
    const approvalId = asString(action.payload.approvalId);
    if (approvalId) {
      const approval = this.repo.findApprovalById(approvalId);
      if (approval) {
        const binding = this.repo.findBindingById(approval.sessionBindingId);
        if (binding) return this.targetForBinding(binding, action.chatId);
      }
    }
    const codexThreadId = asString(action.payload.codexThreadId);
    if (codexThreadId) {
      const binding = this.repo.findBindingByThreadId(codexThreadId);
      if (binding) return this.targetForBinding(binding, action.chatId);
    }
    const requestId = asString(action.payload.requestId);
    if (requestId) {
      const request = this.repo.findAction(requestId);
      const payload = request ? parseStoredServerRequestPayload(request.payload) : null;
      if (payload) {
        const binding = this.repo.findBindingById(payload.bindingId);
        if (binding) return this.targetForBinding(binding, action.chatId);
      }
    }
    return this.targetForAction(action);
  }

  private async sendTextToTarget(target: FeishuReplyTarget, text: string): Promise<void> {
    const chunks = splitFeishuText(text, this.config.bridge.maxFeishuTextLength);
    for (const chunk of chunks) {
      if (target.threadId) {
        await this.feishu.replyTextInThread(target.rootMessageId ?? target.threadId, chunk);
        continue;
      }
      await this.feishu.sendText(target.chatId, chunk, target.rootMessageId);
    }
  }

  private async sendCardToTarget(target: FeishuReplyTarget, card: ReturnType<CardRenderer["taskStatusCard"]>): Promise<SentMessage> {
    if (target.threadId) {
      return this.feishu.replyCardInThread(target.rootMessageId ?? target.threadId, card);
    }
    return this.feishu.sendCard(target.chatId, card, target.rootMessageId);
  }

  private requireStoredServerRequest(requestId: string): ActionRequest {
    if (!requestId) throw new Error("缺少请求 ID");
    const request = this.repo.findAction(requestId);
    if (!request || !request.actionType.startsWith("codex_server_request:")) {
      throw new Error("请求不存在");
    }
    return request;
  }

  private buildStoredServerRequestCard(request: ActionRequest): ReturnType<CardRenderer["serverRequestCard"]> {
    const presentation = presentStoredServerRequest(request);
    return this.cards.serverRequestCard({
      title: presentation.title,
      body: presentation.body,
      form: presentation.form,
      commands: presentation.commands,
      buttons: presentation.buttons
    });
  }

  private buildStoredServerRequestDetailCard(request: ActionRequest): ReturnType<CardRenderer["serverRequestDetailCard"]> {
    const presentation = presentStoredServerRequest(request, { detail: true });
    return this.cards.serverRequestDetailCard({
      title: presentation.title,
      body: presentation.body,
      commands: presentation.commands
    });
  }

  private async submitStoredServerRequest(payload: StoredServerRequestPayload, response: Record<string, unknown>): Promise<void> {
    if (payload.method === "item/tool/requestUserInput") {
      await this.codex.submitUserInput(payload.threadId, payload.requestId, response);
      return;
    }
    if (payload.method === "mcpServer/elicitation/request") {
      await this.codex.submitMcpServerElicitationResponse(payload.threadId, payload.requestId, response);
      return;
    }
    await this.codex.respondToServerRequest(payload.requestId, response);
  }

  private async resolveApproval(id: string, decision: "once" | "task" | "deny", userId: string): Promise<void> {
    const approval = this.repo.findApprovalById(id);
    if (!approval) throw new Error("审批不存在");
    if (approval.status !== "pending") return;
    const response =
      approval.approvalType === "command_execution"
        ? { decision: commandApprovalDecision(decision) }
        : { decision: fileApprovalDecision(decision) };
    await this.codex.respondToServerRequest(approval.requestId, response);
    this.repo.resolveApproval(
      approval.id,
      decision === "once" ? "approved_once" : decision === "task" ? "approved_for_task" : "denied",
      userId
    );
    this.repo.updateBindingStatus(approval.sessionBindingId, "running");
    this.repo.insertEvent({
      sessionBindingId: approval.sessionBindingId,
      codexThreadId: approval.codexThreadId,
      codexTurnId: approval.codexTurnId,
      eventType: "approval.resolved",
      eventPayload: { decision }
    });
    await this.updateTaskCard(approval.sessionBindingId);
  }

  private async handleCodexServerRequest(message: Record<string, unknown>): Promise<void> {
    const method = String(message.method ?? "");
    if (method === "account/chatgptAuthTokens/refresh") {
      this.logger.warn("codex auth refresh request is not handled by the Feishu bridge", {
        requestId: String(message.id ?? ""),
        message
      });
      return;
    }
    const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
    const threadId = asString(params.threadId) ?? asString(params.conversationId) ?? "";
    const binding = this.repo.findBindingByThreadId(threadId);
    if (!binding) {
      await this.codex.respondErrorToServerRequest(String(message.id ?? ""), {
        message: `No Feishu binding found for thread ${threadId || "<unknown>"}.`,
        code: -32004
      }).catch((error) => {
        this.logger.warn("failed to reject unbound codex server request", { error: String(error), message });
      });
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const command = asString(params.command);
      const approval = this.repo.upsertPendingApproval({
        sessionBindingId: binding.id,
        codexThreadId: threadId,
        codexTurnId: asString(params.turnId),
        requestId: String(message.id ?? params.approvalId ?? params.itemId ?? newId("req")),
        itemId: asString(params.itemId),
        approvalType: method.includes("commandExecution") ? "command_execution" : "file_change",
        command,
        filePaths: asString(params.grantRoot) ? [String(params.grantRoot)] : [],
        reason: asString(params.reason),
        riskLevel: method.includes("commandExecution") ? classifyCommandRisk(command) : "medium"
      });
      this.repo.updateBindingStatus(binding.id, "waiting_for_approval", asString(params.turnId));
      this.repo.upsertThreadOwnership({
        codexThreadId: threadId,
        ownerKind: "app_server",
        ownerClientId: this.config.machine.id,
        confidence: "medium"
      });
      const event = this.repo.insertEvent({
        sessionBindingId: binding.id,
        codexThreadId: threadId,
        codexTurnId: asString(params.turnId),
        eventType: "approval.requested",
        eventPayload: { approvalId: approval.id, type: approval.approvalType, command: approval.command }
      });
      this.repo.enqueueOutbox({
        sessionBindingId: binding.id,
        eventSeq: event.seq,
        notificationType: "approval_required",
        feishuChatId: binding.feishuChatId,
        feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
        feishuThreadId: binding.feishuThreadId,
        payload: { card: this.cards.approvalCard(approval) },
        dedupeKey: `approval:${approval.codexThreadId}:${approval.requestId}`
      });
      await this.updateTaskCard(binding.id);
      return;
    }
    const command = asString(params.command);
    const requestId = String(message.id ?? params.approvalId ?? params.itemId ?? newId("req"));
    const stored = this.repo.beginAction({
      actionId: requestId,
      actionType: `codex_server_request:${method}`,
      payload: {
        requestId,
        method,
        threadId,
        turnId: asString(params.turnId),
        itemId: asString(params.itemId),
        bindingId: binding.id,
        params
      },
      requestedByFeishuUserId: null
    });
    if (stored.existing?.status === "completed") return;
    if (!isSupportedDeferredServerRequestMethod(method)) {
      await this.codex.respondErrorToServerRequest(requestId, {
        message: `Feishu bridge does not support ${method} yet.`,
        code: -32001
      });
      this.repo.failAction(requestId, {
        error: `unsupported server request: ${method}`
      });
      return;
    }
    this.repo.updateBindingStatus(binding.id, "waiting_for_approval", asString(params.turnId));
    this.repo.upsertThreadOwnership({
      codexThreadId: threadId,
      ownerKind: "app_server",
      ownerClientId: this.config.machine.id,
      confidence: "medium"
    });
    const event = this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: threadId,
      codexTurnId: asString(params.turnId),
      eventType: "server_request.requested",
      eventPayload: {
        requestId,
        method,
        itemId: asString(params.itemId),
        title: presentStoredServerRequest(stored.action).title
      }
    });
    this.repo.enqueueOutbox({
      sessionBindingId: binding.id,
      eventSeq: event.seq,
      notificationType: "approval_required",
      feishuChatId: binding.feishuChatId,
      feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
      feishuThreadId: binding.feishuThreadId,
      payload: { card: this.buildStoredServerRequestCard(stored.action) },
      dedupeKey: `server-request:${binding.codexThreadId}:${requestId}`
    });
    await this.updateTaskCard(binding.id);
  }

  private async handleCodexNotification(message: Record<string, unknown>): Promise<void> {
    try {
      await this.applyCodexNotification(message);
    } catch (error) {
      this.recordProtocolFailure(message, error);
      this.logger.warn("codex notification parse failed", { error: String(error), message });
    }
  }

  private async applyCodexNotification(message: Record<string, unknown>): Promise<void> {
    const method = String(message.method ?? "");
    const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
    const threadId = asString(params.threadId);
    if (!threadId) return;
    const binding = this.repo.findBindingByThreadId(threadId);
    if (!binding) return;
    if (method === "turn/started") {
      const turn = params.turn && typeof params.turn === "object" ? (params.turn as Record<string, unknown>) : {};
      const turnId = asString(turn.id);
      this.resetProgressState(binding.id);
      this.repo.updateBindingStatus(binding.id, "running", turnId);
      this.repo.upsertThreadOwnership({
        codexThreadId: threadId,
        ownerKind: "app_server",
        ownerClientId: this.config.machine.id,
        confidence: "medium"
      });
      this.repo.insertEvent({
        sessionBindingId: binding.id,
        codexThreadId: threadId,
        codexTurnId: turnId,
        eventType: "turn.started",
        eventPayload: { turn }
      });
      await this.updateTaskCard(binding.id);
    }
    if (method === "turn/completed") {
      const turn = params.turn && typeof params.turn === "object" ? (params.turn as Record<string, unknown>) : {};
      const turnId = asString(turn.id);
      if (!turnId) throw new Error("turn/completed notification missing turn.id");
      const status = normalizeTurnStatus(turn.status);
      const detail = await this.codex.readThread(threadId, true).catch(() => null);
      const activeTurnId = activeTurnIdFromThreadDetail(detail);
      if (isTerminalStatus(status) && activeTurnId && activeTurnId !== turnId) {
        this.repo.updateBindingStatus(binding.id, "running", activeTurnId);
        this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: turnId,
          eventType: "turn.terminal_ignored_due_to_active_turn",
          eventPayload: {
            ignoredStatus: status,
            ignoredTurnId: turnId,
            activeTurnId,
            turn
          }
        });
        await this.updateTaskTitle(binding.id, "running", binding.title ?? "Codex 任务");
        await this.updateTaskCard(binding.id);
        return;
      }
      this.repo.updateBindingStatus(binding.id, status, turnId);
      const endCheckpoint = await this.captureCheckpoint(binding.id, "turn_end", turnId, `任务${taskStatusText(status)}`);
      const report =
        status === "completed"
          ? mergeThreadReports(
              detail ? extractThreadReport(detail) : null,
              extractTurnReport(turn),
              extractEventReport(this.repo.listEventsForBinding(binding.id, 200), turnId)
            ) ?? emptyThreadReport()
          : null;
      const subAgents = compactSubAgentsForBinding(
        detail ? extractSubAgentsFromThreadDetail(detail) : [],
        extractSubAgentsFromEvents(this.repo.listEventsForBinding(binding.id, 200))
      );
      if (subAgents.length > 0) {
        this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: turnId,
          eventType: "codex.subagent",
          eventPayload: { subAgents, source: "thread_completion_scan" }
        });
      }
      const finalResult = report?.finalResult ?? null;
      const reasoningSummary = report?.reasoningSummary ?? null;
      const summaryText =
        status === "completed"
          ? finalResult
            ? truncatePlain(singleLine(finalResult), 90)
            : "已完成。需要细节时发送 /logs 查看任务记录。"
          : formatTurnTerminalSummary(status, turn);
      const event = this.repo.insertEvent({
        sessionBindingId: binding.id,
        codexThreadId: threadId,
        codexTurnId: turnId,
        eventType: status === "completed" ? "task.completed" : `task.${status}`,
        eventPayload: {
          text: summaryText,
          reasoningSummary,
          finalResult,
          workspaceCheckpointId: endCheckpoint?.id ?? null,
          subAgents,
          turn
        }
      });
      this.repo.enqueueOutbox({
        sessionBindingId: binding.id,
        eventSeq: event.seq,
        notificationType: status === "completed" ? "task_completed" : "task_failed",
        feishuChatId: binding.feishuChatId,
        feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
        feishuThreadId: binding.feishuThreadId,
        payload: { card: this.cards.taskStatusCard(this.projection.buildTaskStatus(binding.id)) },
        dedupeKey: `turn:${threadId}:${turnId}:completed`
      });
      if (status === "completed") {
        await this.updateTaskTitle(binding.id, "completed", binding.title ?? "Codex 任务");
        if (this.config.codex.autoArchiveOnCompletion) {
          await this.codex.archiveThread(threadId).catch((error) => {
            this.logger.warn("codex thread auto archive failed", { bindingId: binding.id, threadId, error: String(error) });
          });
        }
      } else if (status === "failed" || status === "interrupted") {
        await this.updateTaskTitle(binding.id, status, binding.title ?? "Codex 任务");
      }
      if (status === "completed" && report) {
        const formattedReport = formatThreadReport(
          binding,
          report,
          status,
          this.repo.listEventsForBinding(binding.id, 200),
          binding.projectId ? this.repo.getProject(binding.projectId)?.name ?? null : null,
          subAgents
        );
        const supplementalCards = this.cards.taskReportSupplementCards(formattedReport);
        this.repo.enqueueOutbox({
          sessionBindingId: binding.id,
          eventSeq: event.seq,
          notificationType: "task_completed",
          feishuChatId: binding.feishuChatId,
          feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
          feishuThreadId: binding.feishuThreadId,
          payload: {
            card: this.cards.taskReportCard(formattedReport),
            ...(supplementalCards.length > 0 ? { cards: supplementalCards } : {}),
            ...(this.cards.shouldSendTaskReportFullText(formattedReport) ? { text: formatFullFinalResult(report) } : {})
          },
          dedupeKey: `turn:${threadId}:${turnId}:result`
        });
      }
      this.clearProgressCard(binding.id);
      await this.deliverNextQueuedMessage(binding.id);
    }
    if (method === "item/completed") {
      const item = params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : {};
      await this.recordSubAgentItem(binding, threadId, asString(params.turnId), item, "item/completed");
      const itemEvent = buildCompletedItemEvent(item);
      if (itemEvent) {
        this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: itemEvent.eventType,
          eventPayload: {
            itemId: asString(item.id) ?? asString(params.itemId),
            text: itemEvent.text
          }
        });
      }
      this.recordItemProgress(binding, threadId, asString(params.turnId), item, "completed");
    }
    if (method === "item/started") {
      const item = params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : {};
      await this.recordSubAgentItem(binding, threadId, asString(params.turnId), item, "item/started");
      this.recordItemProgress(binding, threadId, asString(params.turnId), item, "started");
    }
    if (method === "item/agentMessage/delta") {
      const delta = asString(params.delta);
      if (delta) {
        const event = this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: "codex.agent_delta",
          eventPayload: {
            itemId: asString(params.itemId),
            text: truncate(delta, this.config.bridge.maxFeishuTextLength)
          }
        });
        this.enqueueProgressUpdate(binding, event.seq, "阶段性回复", asString(params.turnId), asString(params.itemId), delta);
      }
    }
    if (method === "item/plan/delta") {
      const delta = asString(params.delta);
      if (delta) {
        const event = this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: "codex.plan_delta",
          eventPayload: {
            itemId: asString(params.itemId),
            text: truncate(delta, this.config.bridge.maxFeishuTextLength)
          }
        });
        this.enqueueProgressUpdate(binding, event.seq, "处理步骤", asString(params.turnId), asString(params.itemId), delta);
      }
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const delta = asString(params.delta);
      if (delta) {
        const event = this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: method === "item/reasoning/summaryTextDelta" ? "codex.reasoning_summary_delta" : "codex.reasoning_delta",
          eventPayload: {
            itemId: asString(params.itemId),
            text: truncate(delta, this.config.bridge.maxFeishuTextLength)
          }
        });
        this.enqueueProgressUpdate(binding, event.seq, "处理摘要", asString(params.turnId), asString(params.itemId), delta);
      }
    }
    if (method === "turn/plan/updated") {
      const planText = formatPlanProgress(params.plan);
      if (planText) {
        const event = this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: "codex.plan_updated",
          eventPayload: { text: planText }
        });
        this.enqueueProgressUpdate(binding, event.seq, "处理步骤", asString(params.turnId), "plan-updated", planText, { force: true, replace: true });
      }
    }
    if (method === "item/mcpToolCall/progress") {
      const messageText = asString(params.message);
      if (messageText) {
        const event = this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: "codex.tool_progress",
          eventPayload: {
            itemId: asString(params.itemId),
            text: truncate(messageText, this.config.bridge.maxFeishuTextLength)
          }
        });
        this.enqueueProgressUpdate(binding, event.seq, "工具进度", asString(params.turnId), asString(params.itemId), messageText);
      }
    }
    if (method === "rawResponseItem/completed") {
      const item = params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : {};
      const itemEvent = buildRawResponseItemEvent(item);
      if (itemEvent) {
        const event = this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: itemEvent.eventType,
          eventPayload: {
            itemId: itemEvent.itemId,
            text: itemEvent.text,
            source: "rawResponseItem/completed"
          }
        });
        this.enqueueProgressUpdate(
          binding,
          event.seq,
          itemEvent.label,
          asString(params.turnId),
          itemEvent.itemId,
          itemEvent.text,
          { force: true, replace: true }
        );
      }
    }
    if (method === "item/fileChange/patchUpdated") {
      const changes = Array.isArray(params.changes) ? params.changes : [];
      const text = formatFileChangeSummary(changes, "updated");
      if (text) {
        const event = this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: "codex.file_change",
          eventPayload: {
            itemId: asString(params.itemId),
            text,
            source: "item/fileChange/patchUpdated"
          }
        });
        this.enqueueProgressUpdate(binding, event.seq, "文件变更", asString(params.turnId), asString(params.itemId), text, {
          force: true,
          replace: true
        });
      }
    }
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
      const delta = asString(params.delta);
      if (delta) {
        this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: method === "item/commandExecution/outputDelta" ? "codex.command_output" : "codex.file_change_output",
          eventPayload: {
            itemId: asString(params.itemId),
            text: truncate(delta, 1200)
          }
        });
      }
    }
    if (method === "item/commandExecution/terminalInteraction") {
      const stdin = asString(params.stdin);
      const text = stdin ? `终端交互：已向运行中的命令发送输入。` : "终端交互：命令等待输入。";
      const event = this.repo.insertEvent({
        sessionBindingId: binding.id,
        codexThreadId: threadId,
        codexTurnId: asString(params.turnId),
        eventType: "codex.command_execution",
        eventPayload: {
          itemId: asString(params.itemId),
          processId: asString(params.processId),
          text
        }
      });
      this.enqueueProgressUpdate(binding, event.seq, "执行命令", asString(params.turnId), asString(params.itemId), text, {
        force: true,
        replace: true
      });
    }
  }

  private recordItemProgress(
    binding: SessionBinding,
    threadId: string,
    turnId: string | null,
    item: Record<string, unknown>,
    phase: "started" | "completed"
  ): void {
    const itemEvent = buildItemProgressEvent(item, phase);
    if (!itemEvent) return;
    const event = this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: threadId,
      codexTurnId: turnId,
      eventType: itemEvent.eventType,
      eventPayload: {
        itemId: itemEvent.itemId,
        itemType: itemEvent.itemType,
        phase,
        text: itemEvent.text,
        ...itemEvent.payload
      }
    });
    this.enqueueProgressUpdate(binding, event.seq, itemEvent.label, turnId, itemEvent.itemId, itemEvent.text, {
      force: true,
      replace: true
    });
  }

  private enqueueProgressUpdate(
    binding: SessionBinding,
    eventSeq: number,
    label: string,
    turnId: string | null,
    itemId: string | null,
    delta: string,
    options: { force?: boolean; replace?: boolean } = {}
  ): void {
    if (!delta.trim()) return;
    const key = `${binding.id}:${turnId ?? "no-turn"}:${itemId ?? label}:${label}`;
    const current = this.progressState.get(key) ?? { text: "", lastSentLength: 0, lastSentAt: 0 };
    const nextText = options.replace ? delta.trim() : `${current.text}${delta}`.trim();
    const visible = sanitizeProgressText(nextText);
    if (!visible || visible === "有输出，原始内容已保留在本地记录中。") {
      this.progressState.set(key, { ...current, text: nextText });
      return;
    }
    const now = Date.now();
    const shouldSend =
      options.force ||
      current.lastSentLength === 0 ||
      visible.length - current.lastSentLength >= 120 ||
      now - current.lastSentAt >= 8000;
    if (!shouldSend) {
      this.progressState.set(key, { ...current, text: nextText });
      return;
    }
    this.progressState.set(key, {
      text: nextText,
      lastSentLength: visible.length,
      lastSentAt: now
    });
    this.updateProgressCard(binding, label, visible).catch((error) => {
      this.logger.warn("feishu progress card update failed", {
        bindingId: binding.id,
        eventSeq,
        label,
        error: String(error)
      });
    });
  }

  private async recordSubAgentItem(
    binding: SessionBinding,
    threadId: string,
    turnId: string | null,
    item: Record<string, unknown>,
    source: string
  ): Promise<void> {
    const subAgents = subAgentEventsFromItem(item);
    if (subAgents.length === 0) return;
    const event = this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: threadId,
      codexTurnId: turnId,
      eventType: "codex.subagent",
      eventPayload: {
        subAgents,
        itemId: asString(item.id),
        source
      }
    });
    const text = formatSubAgentLines(subAgents, 3);
    if (text) {
      this.enqueueProgressUpdate(binding, event.seq, "子 Agent", turnId, asString(item.id), text, { force: true, replace: true });
    }
    await this.updateTaskCard(binding.id);
  }

  private async updateProgressCard(binding: SessionBinding, label: string, text: string): Promise<void> {
    const current =
      this.progressCards.get(binding.id) ?? {
        messageId: "",
        sections: new Map<string, ProgressSection>(),
        lastUpdatedAt: 0
      };
    current.sections.set(label, { label, text, updatedAt: Date.now() });
    const projection = this.buildProgressProjection(binding, current.sections);
    if (current.messageId) {
      await this.feishu.updateCard(current.messageId, this.cards.taskProgressCard(projection));
    } else {
      const sent = await this.sendCardToTarget(
        this.targetForBinding(binding, binding.feishuChatId),
        this.cards.taskProgressCard(projection)
      );
      current.messageId = sent.messageId;
    }
    current.lastUpdatedAt = Date.now();
    this.progressCards.set(binding.id, current);
  }

  private buildProgressProjection(binding: SessionBinding, sections: Map<string, ProgressSection>) {
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    return {
      title: binding.title ?? "Codex 任务",
      status: binding.status,
      projectName: project?.name ?? "未归类项目",
      updatedAt: new Date().toISOString(),
      subAgents: extractSubAgentsFromEvents(this.repo.listEventsForBinding(binding.id, 100)),
      sections: [...sections.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 4)
        .map((section) => ({
          label: section.label,
          text: section.text
        }))
    };
  }

  private buildTaskProcessProjection(binding: SessionBinding): TaskProcessProjection {
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const events = this.repo.listEventsForBinding(binding.id, 200);
    const sections: TaskProcessProjection["sections"] = [];
    const pushSection = (label: string, value: string | null | undefined, maxLength = 1400): void => {
      const text = sanitizeProcessText(value ?? "", maxLength);
      if (text && !sections.some((section) => section.label === label && section.text === text)) {
        sections.push({ label, text });
      }
    };
    const originalPrompt = firstEventPayloadText(events, "task.created_from_feishu", "text");
    const latestRequest = latestEventPayloadText(
      events,
      ["turn.requested_from_feishu", "turn.steer_requested_from_feishu"],
      "text"
    );
    const taskLines = [
      originalPrompt ? `任务：${sanitizeProcessText(originalPrompt, 900)}` : null,
      latestRequest && latestRequest !== originalPrompt ? `最近补充：${sanitizeProcessText(latestRequest, 900)}` : null
    ].filter(Boolean);
    pushSection("任务", taskLines.join("\n"), 1400);
    pushSection("处理步骤", latestProcessText(events, ["codex.plan_updated", "codex.plan", "codex.plan_delta"]), 1600);
    pushSection(
      "处理摘要",
      latestProcessText(events, ["codex.reasoning_summary", "codex.reasoning_summary_delta", "codex.reasoning", "codex.reasoning_delta"]),
      1600
    );
    pushSection("子 Agent", formatSubAgentLines(extractSubAgentsFromEvents(events), 6), 1600);
    pushSection("执行命令", latestProcessText(events, ["codex.command_execution"]), 1000);
    pushSection("文件变更", latestProcessText(events, ["codex.file_change"]), 1200);
    pushSection("工具进度", latestProcessText(events, ["codex.tool_progress"]), 900);
    const finalText =
      latestEventPayloadText(events, ["task.completed", "task.failed", "task.interrupted"], "finalResult") ??
      latestProcessText(events, ["codex.agent_message", "codex.agent_delta"]);
    pushSection(isTerminalStatus(binding.status) ? "最终结论" : "阶段性回复", finalText, 2200);
    if (sections.length === 0) {
      pushSection("当前状态", `当前任务状态：${taskStatusText(binding.status)}。还没有收到可展示的处理摘要。`, 400);
    }
    return {
      title: binding.title ?? "Codex 任务",
      status: binding.status,
      projectName: project?.name ?? "未归类项目",
      updatedAt: new Date().toISOString(),
      subAgents: extractSubAgentsFromEvents(events),
      sections
    };
  }

  private recordProtocolFailure(message: Record<string, unknown>, error: unknown): void {
    const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
    const threadId = asString(params.threadId);
    if (!threadId) return;
    const binding = this.repo.findBindingByThreadId(threadId);
    if (!binding) return;
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: threadId,
      codexTurnId: asString(params.turnId),
      eventType: "protocol.validation_failed",
      eventPayload: {
        method: asString(message.method),
        error: String(error)
      }
    });
  }

  private async deliverNextQueuedMessage(bindingId: string): Promise<void> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) return;
    const [next] = this.repo.listQueuedMessages(bindingId);
    if (!next) return;
    this.repo.markQueuedDelivered(next.id);
    this.resetProgressState(binding.id);
    this.repo.updateBindingStatus(binding.id, "running");
    await this.updateTaskTitle(binding.id, "running", binding.title ?? "Codex 任务");
    await this.updateTaskCard(binding.id);
    await this.codex.resumeThread(binding.codexThreadId);
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const startCheckpoint = await this.captureCheckpoint(binding.id, "turn_start", null, "队列消息开始前");
    const codexAttachments = next.attachments
      .filter((attachment) => attachment.kind === "image" && typeof attachment.localPath === "string" && attachment.localPath.trim())
      .map((attachment) => ({ path: attachment.localPath as string }));
    await this.codex.startTurn(binding.codexThreadId, next.text, {
      cwd: binding.cwd,
      model: resolveBindingModel(binding, project, this.config),
      reasoningEffort: resolveBindingReasoningEffort(binding, project, this.config),
      attachments: codexAttachments
    }).then((turn) => {
      const turnId = extractTurnId(turn);
      if (startCheckpoint && turnId) this.repo.updateWorkspaceCheckpointTurnId(startCheckpoint.id, turnId);
      if (turnId) this.repo.updateBindingStatus(binding.id, "running", turnId);
      return turn;
    });
  }

  private async resolveCodexMessageInput(input: {
    messageId: string;
    prompt: string;
    attachments?: FeishuMessageAttachment[] | null;
  }): Promise<CodexMessageInput> {
    const prompt = input.prompt.trim() || defaultPromptForAttachments(input.attachments);
    this.logger.info("resolving codex message input", {
      messageId: input.messageId,
      attachmentCount: (input.attachments ?? []).length,
      promptLength: prompt.length
    });
    const downloaded: FeishuMessageAttachment[] = [];
    const codexAttachments: CodexLocalImageAttachment[] = [];
    for (const attachment of input.attachments ?? []) {
      if (attachment.kind !== "image") continue;
      if (attachment.localPath) {
        const normalized = { ...attachment, messageId: attachment.messageId ?? input.messageId };
        downloaded.push(normalized);
        codexAttachments.push({ path: attachment.localPath });
        continue;
      }
      const download = this.feishu.downloadMessageResource;
      if (!download) {
        throw new Error("当前 Feishu client 不支持下载图片资源，无法把图片转交给 Codex Desktop。");
      }
      const messageId = attachment.messageId ?? input.messageId;
      const resource = await download.call(this.feishu, {
        messageId,
        fileKey: attachment.key,
        resourceType: "image",
        attachment
      });
      const resolved = {
        ...attachment,
        messageId,
        localPath: resource.path,
        mimeType: resource.mimeType ?? attachment.mimeType ?? null,
        sizeBytes: resource.sizeBytes
      };
      downloaded.push(resolved);
      codexAttachments.push({ path: resource.path });
    }
    if (downloaded.length > 0) {
      this.logger.info("codex image attachments prepared", {
        messageId: input.messageId,
        attachmentCount: downloaded.length,
        promptLength: prompt.length
      });
    }
    return {
      prompt,
      attachments: codexAttachments,
      feishuAttachments: downloaded.length > 0 ? downloaded : sanitizeMessageAttachments(input.attachments)
    };
  }

  private isDesktopIpcMode(): boolean {
    return this.config.codex.connectionMode === "desktop_ipc" || this.codex.connectionKind === "desktop_ipc";
  }

  private async canCreateDesktopThreadFromFeishu(): Promise<{
    ok: boolean;
    guidance: string | null;
    readiness: CodexExecutionReadiness | null;
  }> {
    if (this.config.codex.connectionMode === "desktop_proxy") {
      try {
        await this.codex.start();
      } catch (error) {
        this.diagnostics.recordError(error);
        return { ok: false, guidance: null, readiness: null };
      }
      if (this.codex.connectionKind !== "desktop_proxy") {
        return { ok: false, guidance: null, readiness: null };
      }
      const readiness = await this.codex.getExecutionReadiness().catch((error) => {
        this.diagnostics.recordError(error);
        return null;
      });
      if (!readiness) {
        return { ok: false, guidance: null, readiness: null };
      }
      if (!readiness.usable) {
        const guidance = this.desktopProxyExecutionUnavailableGuidance(readiness);
        this.diagnostics.recordError(new Error(guidance));
        return { ok: false, guidance, readiness };
      }
      return { ok: true, guidance: null, readiness };
    }
    if (this.config.codex.connectionMode === "desktop_ipc") {
      const capabilities = detectDesktopIpcCapabilities();
      return { ok: Boolean(capabilities?.supportsHostThreadCreation), guidance: null, readiness: null };
    }
    if (this.codex.connectionKind === "desktop_proxy") {
      const readiness = await this.codex.getExecutionReadiness().catch((error) => {
        this.diagnostics.recordError(error);
        return null;
      });
      if (!readiness) return { ok: false, guidance: null, readiness: null };
      if (!readiness.usable) {
        const guidance = this.desktopProxyExecutionUnavailableGuidance(readiness);
        this.diagnostics.recordError(new Error(guidance));
        return { ok: false, guidance, readiness };
      }
      return { ok: true, guidance: null, readiness };
    }
    if (this.codex.connectionKind === "desktop_ipc") {
      const capabilities = detectDesktopIpcCapabilities();
      return { ok: Boolean(capabilities?.supportsHostThreadCreation), guidance: null, readiness: null };
    }
    try {
      await this.codex.start();
    } catch (error) {
      this.diagnostics.recordError(error);
      return { ok: false, guidance: null, readiness: null };
    }
    const resolvedConnectionKind: string = this.codex.connectionKind;
    if (resolvedConnectionKind === "desktop_proxy") {
      const readiness = await this.codex.getExecutionReadiness().catch((error) => {
        this.diagnostics.recordError(error);
        return null;
      });
      if (!readiness) return { ok: false, guidance: null, readiness: null };
      if (!readiness.usable) {
        const guidance = this.desktopProxyExecutionUnavailableGuidance(readiness);
        this.diagnostics.recordError(new Error(guidance));
        return { ok: false, guidance, readiness };
      }
      return { ok: true, guidance: null, readiness };
    }
    if (resolvedConnectionKind === "desktop_ipc") {
      const capabilities = detectDesktopIpcCapabilities();
      return { ok: Boolean(capabilities?.supportsHostThreadCreation), guidance: null, readiness: null };
    }
    return { ok: false, guidance: null, readiness: null };
  }

  private async desktopIpcCreationUnavailableGuidance(): Promise<string> {
    const capabilities = detectDesktopIpcCapabilities();
    const followerOnly =
      capabilities?.supportsFollowerControl === true &&
      capabilities.supportsHostThreadCreation === false &&
      capabilities.supportsThreadGoal === false &&
      capabilities.supportsThreadTitle === false &&
      capabilities.supportsArchiveControl === false;
    if (this.config.codex.connectionMode === "desktop_proxy") {
      return [
        "当前不能从飞书直接新建真实 Desktop 线程。",
        "当前配置要求走官方 desktop_proxy 主线；这里的 desktop_proxy 只是兼容模式名，bridge 实际底层使用的是 direct `codex app-server` stdio。",
        "这次没有成功连上 `codex app-server`，所以新线程没有创建出来。",
        "请先检查 `codex --version`、`codex app-server` 是否能在本机直接启动，以及 bridge 日志里的具体报错。",
        "在 direct app-server 恢复前，当前只能先发送 /tasks 接管电脑里已有线程。"
      ].join("\n");
    }
    if (this.config.codex.connectionMode === "desktop_auto") {
      return [
        followerOnly
          ? "当前自动模式已经回退到 Desktop IPC，而且当前安装的 stock Codex Desktop 只暴露了 thread-follower IPC handler，没有暴露官方新线程 host handler。"
          : "当前自动模式已经回退到 Desktop IPC，但这台普通 Codex Desktop 运行态仍没有可用的官方新线程 handler。",
        "当前从飞书接管已打开线程可用，但直接新建对话不可用。desktop_auto 还没有回到官方 app-server 主线。",
        "可以先发送 /tasks 接管电脑里已经存在的任务；如果一定要从飞书新建对话，必须让 desktop_auto 恢复到官方 app-server 主线。"
      ].join("\n");
    }
    return [
      followerOnly
        ? "当前安装的 stock Codex Desktop 只暴露了 thread-follower IPC handler，没有暴露官方新线程 host handler。"
        : "当前普通 Codex Desktop 运行态没有可用的官方新线程 handler。",
      "也就是说现在可以接管电脑里已有的线程，但不能从飞书直接新建新对话。",
      "可以先发送 /tasks 接管已有任务；如果一定要从飞书新建对话，需要切回可用的官方 desktop_proxy 主线。"
    ].join("\n");
  }

  private desktopProxyExecutionUnavailableGuidance(readiness: CodexExecutionReadiness): string {
    const authSummary = [
      readiness.authMethod ? `authMethod=${readiness.authMethod}` : null,
      readiness.accountType ? `accountType=${readiness.accountType}` : null,
      readiness.accountEmail ? `account=${readiness.accountEmail}` : null,
      readiness.requiresOpenaiAuth === true ? "requiresOpenaiAuth=true" : null
    ].filter(Boolean).join(", ");
    return [
      "当前不能从飞书直接新建真实 Desktop 线程。",
      "当前配置要求走 desktop_proxy 主线，但这里的 desktop_proxy 只是兼容模式名，bridge 实际底层是 direct `codex app-server` stdio。",
      "这次 direct app-server 虽然能启动，但当前运行态还不能真正执行首轮请求，所以如果继续创建线程会在第一轮直接失败。",
      readiness.reason ?? "当前 app-server 认证状态不足以执行首轮请求。",
      authSummary ? `运行态信息：${authSummary}` : null,
      "这条需求会先保留在飞书草稿会话里，不会再创建一个立刻 401 失败的假成功线程。",
      "可以先发送 /tasks 接管已有线程；如果要恢复飞书直接新建任务，先修复当前 Codex app-server 的认证可用性。"
    ].filter(Boolean).join("\n");
  }

  private async captureCheckpoint(
    bindingId: string,
    kind: WorkspaceCheckpointKind,
    turnId: string | null,
    note: string
  ): Promise<WorkspaceCheckpoint | null> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding?.cwd) return null;
    return this.captureCheckpointForWorkspace({
      binding,
      codexThreadId: binding.codexThreadId,
      workspaceRoot: binding.cwd,
      kind,
      turnId,
      note
    });
  }

  private async captureCheckpointForWorkspace(input: {
    binding: SessionBinding;
    codexThreadId: string;
    workspaceRoot: string | null;
    kind: WorkspaceCheckpointKind;
    turnId: string | null;
    note: string;
  }): Promise<WorkspaceCheckpoint | null> {
    if (!input.workspaceRoot) return null;
    try {
      return this.repo.createWorkspaceCheckpoint({
        sessionBindingId: input.binding.id,
        codexThreadId: input.codexThreadId,
        turnId: input.turnId,
        workspaceRoot: input.workspaceRoot,
        checkpointRef: `${input.kind}:${input.codexThreadId}:${input.turnId ?? Date.now().toString(36)}`,
        snapshotNote: input.note,
        kind: input.kind,
        manifest: captureWorkspaceManifest(input.workspaceRoot)
      });
    } catch (error) {
      this.logger.warn("workspace checkpoint capture failed", {
        bindingId: input.binding.id,
        kind: input.kind,
        turnId: input.turnId,
        cwd: input.workspaceRoot,
        error: String(error)
      });
      return null;
    }
  }

  private workspaceCheckpointPair(binding: SessionBinding): {
    start: WorkspaceCheckpoint | null;
    end: WorkspaceCheckpoint | null;
  } {
    const pair = this.repo.findWorkspaceCheckpointPair(binding.id, binding.lastTurnId);
    return pair.end ? pair : this.repo.findWorkspaceCheckpointPair(binding.id);
  }

  private async updateTaskCard(bindingId: string): Promise<void> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) return;
    const projection = this.projection.buildTaskStatus(bindingId);
    if (binding.feishuTaskCardMessageId) {
      await this.feishu.updateCard(binding.feishuTaskCardMessageId, this.cards.taskStatusCard(projection));
      return;
    }
    this.repo.enqueueOutbox({
      sessionBindingId: binding.id,
      notificationType: "task_status",
      feishuChatId: binding.feishuChatId,
      feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
      feishuThreadId: binding.feishuThreadId,
      payload: { card: this.cards.taskStatusCard(projection) },
      dedupeKey: [
        "task-status",
        binding.id,
        projection.status,
        projection.lastTurnId ?? "no-turn",
        projection.queuedMessages,
        projection.pendingApprovals,
        stableSummaryKey(formatSubAgentLines(projection.subAgents)),
        stableSummaryKey(projection.lastSummary)
      ].join(":")
    });
  }

  private async updateTaskTitle(bindingId: string, status: TaskStatus, title: string): Promise<void> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) return;
    if (binding.feishuContainerKind === "dedicated_chat") {
      try {
        await this.feishu.updateChatName(binding.feishuChatId, buildTaskChatName(this.config, binding.feishuTopicRootMessageId, title, status));
      } catch (error) {
        this.logger.warn("feishu task chat title update failed", {
          bindingId,
          chatId: binding.feishuChatId,
          error: String(error)
        });
      }
    } else {
      await this.updateTopicTitle(bindingId, buildTopicTitle(title, status));
    }
    await this.syncCodexThreadName(binding, buildCodexThreadTitle(title, status));
  }

  private async syncCodexThreadName(binding: SessionBinding, title: string): Promise<void> {
    if (this.isDesktopIpcMode()) return;
    const setThreadName = (this.codex as unknown as { setThreadName?: (threadId: string, name: string) => Promise<Record<string, unknown>> })
      .setThreadName;
    if (!setThreadName || binding.codexThreadId.startsWith("draft_")) return;
    try {
      await setThreadName.call(this.codex, binding.codexThreadId, truncatePlain(title, 80));
    } catch (error) {
      this.logger.warn("codex thread title sync failed", {
        bindingId: binding.id,
        threadId: binding.codexThreadId,
        error: String(error)
      });
    }
  }

  private async updateTopicTitle(bindingId: string, title: string): Promise<void> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding?.feishuTopicRootMessageId) return;
    try {
      await this.feishu.updateText(binding.feishuTopicRootMessageId, title);
    } catch (error) {
      this.logger.warn("feishu topic title update failed", {
        bindingId,
        rootMessageId: binding.feishuTopicRootMessageId,
        error: String(error)
      });
    }
  }

  private latestStateFromHistory(bindingId: string): TaskStatus | null {
    const events = this.repo.listEventsForBinding(bindingId, 200);
    for (const event of [...events].reverse()) {
      if (event.eventType === "task.completed") return "completed";
      if (event.eventType === "task.failed") return "failed";
      if (event.eventType === "task.interrupted" || event.eventType === "turn.interrupted_by_feishu") return "interrupted";
      if (event.eventType === "task.archived") return "archived";
      if (event.eventType === "approval.requested") return "waiting_for_approval";
      if (event.eventType === "turn.started" || event.eventType === "turn.requested_from_feishu") return "running";
    }
    return null;
  }

  private buildProjectCardInput(project: Project): {
    id: string;
    name: string;
    rootPath: string;
    runningCount: number;
    pendingApprovals: number;
    completedCount: number;
    defaultModel: string;
    defaultReasoningEffort: string;
  } {
    const bindings = this.repo.listBindings(500).filter((binding) => binding.projectId === project.id);
    const runningCount = bindings.filter((binding) => binding.status === "running").length;
    const completedCount = bindings.filter((binding) => binding.status === "completed").length;
    const pendingApprovals = bindings.reduce((sum, binding) => sum + this.repo.listPendingApprovals(binding.id).length, 0);
    return {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      runningCount,
      pendingApprovals,
      completedCount,
      defaultModel: projectModel(project, this.config),
      defaultReasoningEffort: projectReasoningEffort(project, this.config)
    };
  }

  private resetProgressState(bindingId: string): void {
    for (const key of [...this.progressState.keys()]) {
      if (key.startsWith(`${bindingId}:`)) this.progressState.delete(key);
    }
    const current = this.progressCards.get(bindingId);
    if (current) {
      current.sections.clear();
      current.lastUpdatedAt = Date.now();
      this.progressCards.set(bindingId, current);
    }
  }

  private clearProgressCard(bindingId: string): void {
    const current = this.progressCards.get(bindingId);
    if (current) {
      current.sections.clear();
      current.lastUpdatedAt = Date.now();
      this.progressCards.set(bindingId, current);
    }
  }

  private listTaskSummaries(kind: TaskListKind, limit: number, projectId?: string | null): Array<{
    bindingId: string;
    title: string;
    status: string;
    projectName: string;
    model: string | null;
    reasoningEffort: string | null;
  }> {
    const queryLimit = projectId ? Math.max(limit * 10, 100) : limit;
    const bindings =
      kind === "recent"
        ? this.repo.listBindings(queryLimit)
        : this.repo.listBindingsByStatuses(taskListStatuses(kind), queryLimit);
    return bindings.filter((binding) => !projectId || binding.projectId === projectId).slice(0, limit).map((binding) => {
      const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
      return {
        bindingId: binding.id,
        title: binding.title ?? "Codex 任务",
        status: binding.status,
        projectName: project?.name ?? "未归类项目",
        model: resolveBindingModel(binding, project, this.config),
        reasoningEffort: resolveBindingReasoningEffort(binding, project, this.config)
      };
    });
  }

  private async getModelOptions(): Promise<CodexModelSummary[]> {
    try {
      const models = await this.codex.listModels(20);
      return models.length > 0 ? models : fallbackModelOptions(this.config);
    } catch (error) {
      this.logger.warn("codex model list failed, fallback to defaults", { error: String(error) });
      return fallbackModelOptions(this.config);
    }
  }

  private localTaskDetailUrl(bindingId: string): string | null {
    const httpStartedByConfig =
      this.config.server.mode === "enabled" ||
      (this.config.server.mode === "auto" &&
        (this.config.feishu.messageTransport === "http_callback" || this.config.feishu.cardActionTransport === "http_callback"));
    if (!httpStartedByConfig || !this.config.server.host) return null;
    const host = this.config.server.host === "0.0.0.0" || this.config.server.host === "::" ? "127.0.0.1" : this.config.server.host;
    return `http://${host}:${this.config.server.port}/task/${encodeURIComponent(bindingId)}?token=${encodeURIComponent(this.config.server.adminToken)}`;
  }
}

const summarizeTitle = (text: string): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 40 ? `${compact.slice(0, 40)}...` : compact || "Codex 任务";
};

const normalizeMessageText = (message: FeishuIncomingMessage): string => {
  const text = message.text.trim();
  if (text) return text;
  return defaultPromptForAttachments(message.attachments);
};

const defaultPromptForAttachments = (attachments: FeishuMessageAttachment[] | null | undefined): string => {
  const imageCount = (attachments ?? []).filter((attachment) => attachment.kind === "image").length;
  if (imageCount <= 0) return "";
  return imageCount === 1 ? "请查看这张图片。" : `请查看这 ${imageCount} 张图片。`;
};

const sanitizeMessageAttachments = (
  attachments: FeishuMessageAttachment[] | null | undefined
): FeishuMessageAttachment[] =>
  (attachments ?? [])
    .filter((attachment) => attachment.kind === "image" && attachment.key.trim())
    .map((attachment) => ({
      kind: "image",
      key: attachment.key,
      messageId: attachment.messageId ?? null,
      localPath: attachment.localPath ?? null,
      mimeType: attachment.mimeType ?? null,
      sizeBytes: attachment.sizeBytes ?? null
    }));

const describeFeishuAttachments = (
  attachments: FeishuMessageAttachment[] | null | undefined
): Array<Record<string, unknown>> =>
  sanitizeMessageAttachments(attachments).map((attachment) => ({
    kind: attachment.kind,
    key: attachment.key,
    messageId: attachment.messageId ?? null,
    localPath: attachment.localPath ?? null,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null
  }));

const buildTaskChatName = (config: BridgeConfig, key: string, title: string, status: TaskStatus = "running"): string => {
  const statusPrefix = taskStatusPrefix(status);
  return truncatePlain(`${statusPrefix}${title}`, 60);
};

const buildTopicTitle = (title: string, status: TaskStatus): string =>
  status === "running" ? title : `${taskStatusPrefix(status)}${title}`;

const buildCodexThreadTitle = (title: string, status: TaskStatus): string =>
  status === "running" ? title : `${taskStatusPrefix(status)}${title}`;

const taskStatusPrefix = (status: TaskStatus): string => {
  if (status === "completed" || status === "archived") return "[完成] ";
  if (status === "failed") return "[失败] ";
  if (status === "interrupted") return "[中断] ";
  if (status === "waiting_for_approval") return "[确认] ";
  if (status === "running") return "[运行中] ";
  return "";
};

const firstRealFeishuMessageId = (...values: Array<string | null | undefined>): string | null => {
  for (const value of values) {
    if (value && /^om_[A-Za-z0-9_-]+$/.test(value)) return value;
  }
  return null;
};

const firstRealFeishuThreadId = (...values: Array<string | null | undefined>): string | null => {
  for (const value of values) {
    if (value && /^omt_[A-Za-z0-9_-]+$/.test(value)) return value;
  }
  return null;
};

const normalizeTurnStatus = (status: unknown): TaskStatus => {
  if (status === "completed") return "completed";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  if (status === "failed") return "failed";
  if (status === "running" || status === "active" || status === "inProgress" || status === "in_progress") return "running";
  return "idle";
};

const extractTurnId = (result: Record<string, unknown>): string | null => {
  const turn = result.turn;
  if (!turn || typeof turn !== "object") return null;
  const id = (turn as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
};

const latestTurnIdFromThread = (thread: CodexThreadSummary): string | null => {
  const turns = Array.isArray(thread.raw.turns) ? thread.raw.turns : [];
  const latest = turns[turns.length - 1];
  if (!latest || typeof latest !== "object") return null;
  const object = latest as Record<string, unknown>;
  return asString(object.id) ?? asString(object.turnId);
};

const projectModel = (project: Project | null, config: BridgeConfig): string =>
  project?.defaultModel ?? config.codex.defaultModel;

const projectReasoningEffort = (project: Project | null, config: BridgeConfig): string =>
  project?.defaultReasoningEffort ?? config.codex.defaultReasoningEffort;

const resolveBindingModel = (binding: SessionBinding, project: Project | null, config: BridgeConfig): string =>
  binding.selectedModel ?? projectModel(project, config);

const resolveBindingReasoningEffort = (binding: SessionBinding, project: Project | null, config: BridgeConfig): string =>
  binding.selectedReasoningEffort ?? projectReasoningEffort(project, config);

const resolveProjectNotificationLevel = (project: Project | null): NotificationLevel =>
  normalizeNotificationLevel(project?.notificationPolicy);

const normalizeNotificationLevel = (value: string | null | undefined): NotificationLevel => {
  if (value === "all" || value === "important" || value === "errors" || value === "muted") return value;
  return "important";
};

const taskListStatuses = (kind: TaskListKind): TaskStatus[] => {
  switch (kind) {
    case "running":
      return ["running", "waiting_for_approval"];
    case "completed":
      return ["completed"];
    case "failed":
      return ["failed", "interrupted"];
    case "archived":
      return ["archived"];
    default:
      return [];
  }
};

const fallbackModelOptions = (config: BridgeConfig): CodexModelSummary[] => [
  {
    id: config.codex.defaultModel,
    model: config.codex.defaultModel,
    displayName: config.codex.defaultModel,
    defaultReasoningEffort: config.codex.defaultReasoningEffort,
    supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    isDefault: true
  }
];

const prioritizeModels = (models: CodexModelSummary[], currentModel: string): string[] => {
  const ordered = [...models]
    .sort((left, right) => {
      if (left.model === currentModel) return -1;
      if (right.model === currentModel) return 1;
      if (left.isDefault && !right.isDefault) return -1;
      if (!left.isDefault && right.isDefault) return 1;
      return left.model.localeCompare(right.model);
    })
    .map((model) => model.model);
  return [...new Set([currentModel, ...ordered])].slice(0, 8);
};

const prioritizeReasoningOptions = (
  models: CodexModelSummary[],
  currentModel: string,
  currentReasoningEffort: string
): string[] => {
  const current = models.find((model) => model.model === currentModel);
  const supported = current?.supportedReasoningEfforts ?? ["minimal", "low", "medium", "high", "xhigh"];
  return [...new Set([currentReasoningEffort, ...supported])].slice(0, 8);
};

const taskStatusText = (status: TaskStatus): string =>
  ({
    draft: "草稿",
    waiting_for_prompt: "等待任务描述",
    running: "运行中",
    waiting_for_approval: "等待确认",
    idle: "可继续",
    completed: "任务完成",
    failed: "任务失败",
    interrupted: "已中断",
    archived: "已归档"
  })[status] ?? status;

const formatTurnTerminalSummary = (status: TaskStatus, turn: Record<string, unknown>): string => {
  const errorSummary = extractTurnErrorSummary(turn);
  if (errorSummary) return `任务状态：${taskStatusText(status)}。原因：${truncatePlain(singleLine(errorSummary), 180)}。发送 /logs 查看任务记录。`;
  return `任务状态：${taskStatusText(status)}。发送 /logs 查看任务记录。`;
};

const extractTurnErrorSummary = (turn: Record<string, unknown>): string | null => {
  for (const key of ["error", "lastError", "failure", "failureReason", "message"]) {
    const summary = extractErrorLikeText(turn[key]);
    if (summary) return summary;
  }
  return null;
};

const extractErrorLikeText = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  for (const key of ["message", "reason", "error", "details", "detail", "body"]) {
    const nested = extractErrorLikeText(object[key]);
    if (nested) return nested;
  }
  return null;
};

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 20)}\n...(已截断)` : text);

const truncatePlain = (text: string, max: number): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
};

const splitFeishuText = (text: string, maxLength: number): string[] => {
  const limit = Math.max(500, maxLength);
  if (text.length <= limit) return [text];
  const bodyLimit = Math.max(400, limit - 24);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const remaining = text.slice(offset);
    if (remaining.length <= bodyLimit) {
      chunks.push(remaining);
      break;
    }
    const boundary = bestTextBoundary(remaining, bodyLimit);
    chunks.push(remaining.slice(0, boundary).trimEnd());
    offset += boundary;
    while (text[offset] === "\n") offset += 1;
  }
  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
};

const bestTextBoundary = (text: string, limit: number): number => {
  const candidates = [
    text.lastIndexOf("\n\n", limit),
    text.lastIndexOf("\n", limit),
    text.lastIndexOf("。", limit),
    text.lastIndexOf("；", limit),
    text.lastIndexOf(". ", limit)
  ].filter((index) => index >= Math.floor(limit * 0.55));
  if (candidates.length > 0) return Math.max(...candidates) + 1;
  return limit;
};

type PresentedServerRequest = {
  title: string;
  body: string;
  commands: string[];
  buttons: Array<{
    label: string;
    action: string;
    payload: Record<string, unknown>;
  }>;
  form?: {
    submitLabel?: string;
    fields: Array<{
      name: string;
      label: string;
      kind: "text" | "textarea" | "select" | "multi_select" | "boolean" | "number";
      required?: boolean;
      secret?: boolean;
      placeholder?: string;
      value?: string;
      options?: Array<{ label: string; value: string }>;
    }>;
    submitPayload?: Record<string, unknown>;
  };
};

const isTerminalStatus = (status: TaskStatus): boolean =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "archived";

const isCommandText = (text: string): boolean =>
  text.startsWith("/") ||
  ["项目列表", "查看进度", "查看日志", "处理记录", "查看队列", "通知历史", "发送测试通知", "未归类任务", "设置"].includes(text);

const normalizeCommand = (value: string): string => {
  const lowered = value.trim().toLowerCase().replace(/^\/+/, "");
  const aliases: Record<string, string> = {
    "项目列表": "projects",
    "未归类任务": "unclassified",
    project: "projects",
    projects: "projects",
    unclassified: "unclassified",
    "创建为新项目": "create-project",
    "create-project": "create-project",
    createproject: "create-project",
    "pick-project": "pick-project",
    pickproject: "pick-project",
    "归入已有项目": "pick-project",
    "查看进度": "status",
    status: "status",
    "详情": "detail",
    detail: "detail",
    "本次影响": "impact",
    impact: "impact",
    "搜索": "search",
    search: "search",
    settings: "settings",
    "设置": "settings",
    "查看日志": "logs",
    "处理记录": "logs",
    logs: "logs",
    log: "logs",
    "查看队列": "queue",
    queue: "queue",
    claim: "claim",
    recent: "recent",
    running: "running",
    completed: "completed",
    failed: "failed",
    "通知历史": "notify history",
    "发送测试通知": "notify test",
    notify: "notify",
    "run-tests": "run-tests",
    runtests: "run-tests",
    test: "run-tests",
    stop: "stop",
    retry: "retry",
    "analyze-failure": "analyze-failure",
    analyze: "analyze-failure",
    archive: "archive",
    approval: "approval",
    approve: "approval"
  };
  return aliases[value.trim()] ?? aliases[lowered] ?? lowered;
};

const splitCommand = (text: string): string[] => {
  const rawParts = text.trim().split(/\s+/).filter(Boolean);
  if (rawParts.length === 0) return [];
  const first = normalizeCommand(rawParts[0] ?? "");
  const normalizedWhole = normalizeCommand(text);
  if (rawParts.length === 1 && normalizedWhole.includes(" ")) return normalizedWhole.split(/\s+/).filter(Boolean);
  return [first, ...rawParts.slice(1).map((part) => part.trim().toLowerCase().replace(/^\/+/, ""))];
};

const requireArgument = (value: string | undefined, usage: string): string => {
  if (value && value.trim()) return value.trim();
  throw new Error(`缺少参数，请使用 ${usage}`);
};

const requireCurrentBindingId = (binding: SessionBinding | null, command: string): string => {
  if (binding) return binding.id;
  throw new Error(`/${command} 需要在已绑定的任务会话里发送。`);
};

const shouldAckCommand = (action: string): boolean =>
  new Set(["queue_cancel", "task_stop", "task_archive", "approval_once", "approval_for_task", "approval_deny"]).has(action);

const stableSummaryKey = (text: string | null): string => {
  if (!text) return "none";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const normalizeThreadFromDetail = (threadId: string, detail: Record<string, unknown>): CodexThreadSummary => {
  const rawThread = detail.thread && typeof detail.thread === "object" ? (detail.thread as Record<string, unknown>) : detail;
  const hasActiveTurn = Boolean(activeTurnIdFromThreadDetail(detail));
  const rawStatus = rawThread.status && typeof rawThread.status === "object" ? (rawThread.status as { type?: unknown }).type : null;
  return {
    id: String(rawThread.id ?? threadId),
    title: asString(rawThread.name),
    preview: asString(rawThread.preview),
    cwd: asString(rawThread.cwd),
    status: rawStatus === "active" || hasActiveTurn ? "running" : "idle",
    updatedAt: typeof rawThread.updatedAt === "number" ? rawThread.updatedAt : null,
    source: rawThread.source ?? null,
    agentNickname: asString(rawThread.agentNickname),
    agentRole: asString(rawThread.agentRole),
    raw: rawThread
  };
};

const isActiveCodexTurnStatus = (status: unknown): boolean =>
  status === "running" || status === "active" || status === "inProgress" || status === "in_progress";

const isSubAgentThread = (thread: Pick<CodexThreadSummary, "source" | "agentNickname" | "agentRole">): boolean => {
  if (thread.agentNickname || thread.agentRole) return true;
  return isSubAgentSource(thread.source);
};

const isSubAgentSource = (source: unknown): boolean => {
  if (typeof source === "string") {
    const normalized = source.toLowerCase();
    return normalized.startsWith("subagent") || normalized.startsWith("sub_agent");
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const object = source as Record<string, unknown>;
  if ("subAgent" in object || "subagent" in object) return true;
  const kind = asString(object.kind) ?? asString(object.type);
  return kind ? isSubAgentSource(kind) : false;
};

type CodexOnlyCompletionState = {
  status: "completed" | "failed" | "interrupted";
  turnId: string;
  updatedAt: number | null;
  report: ThreadReport | null;
};

type LatestTerminalTurn = {
  id: string;
  status: "completed" | "failed" | "interrupted";
  updatedAt: number | null;
  report: ThreadReport | null;
  raw: Record<string, unknown>;
};

const normalizeThreadCompletionState = (
  summary: CodexThreadSummary,
  detail: Record<string, unknown> | null
): CodexOnlyCompletionState | null => {
  const latestTerminalTurn = latestTerminalTurnFromThreadDetail(detail);
  if (latestTerminalTurn) {
    return {
      status: latestTerminalTurn.status,
      turnId: latestTerminalTurn.id,
      updatedAt: latestTerminalTurn.updatedAt ?? summary.updatedAt,
      report: latestTerminalTurn.report
    };
  }
  return null;
};

const latestTerminalTurnFromThreadDetail = (detail: Record<string, unknown> | null): LatestTerminalTurn | null => {
  const rawThread = detail && detail.thread && typeof detail.thread === "object"
    ? (detail.thread as Record<string, unknown>)
    : detail;
  if (!rawThread || typeof rawThread !== "object") return null;
  const turns = rawThread && typeof rawThread === "object" && Array.isArray(rawThread.turns) ? rawThread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn || typeof turn !== "object") continue;
    const object = turn as Record<string, unknown>;
    if (isActiveCodexTurnStatus(object.status)) return null;
    const status = normalizeCodexOnlyTurnStatus(object.status);
    if (!status) continue;
    const turnId = asString(object.id) ?? asString(object.turnId) ?? `turn_${index}`;
    return {
      status,
      id: turnId,
      updatedAt: numberTimestamp(object.completedAt) ?? numberTimestamp(object.updatedAt) ?? numberTimestamp(rawThread.updatedAt),
      report: mergeThreadReports(detail ? extractThreadReport(detail) : null, extractTurnReport(object)),
      raw: object
    };
  }
  return null;
};

const normalizeCodexOnlyTurnStatus = (status: unknown): LatestTerminalTurn["status"] | null => {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  return null;
};

const numberTimestamp = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
};

const isRecentCodexOnlyCompletion = (updatedAt: number | null, lookbackMs: number): boolean => {
  if (!updatedAt) return false;
  return Date.now() - updatedAt <= lookbackMs;
};

const codexOnlyCompletionDedupeKey = (
  threadId: string,
  turnId: string,
  status: "completed" | "failed" | "interrupted"
): string => `codex-only:${threadId}:${turnId}:${status}`;

const codexOnlyCompletionNotificationType = (status: "completed" | "failed" | "interrupted"): NotificationType => {
  if (status === "completed") return "task_completed";
  if (status === "interrupted") return "task_interrupted";
  return "task_failed";
};

const summarizeThreadDetail = (detail: Record<string, unknown>): string => {
  const rawThread = detail.thread && typeof detail.thread === "object" ? (detail.thread as Record<string, unknown>) : detail;
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const turnObject = lastTurn && typeof lastTurn === "object" ? (lastTurn as Record<string, unknown>) : null;
  const items = Array.isArray(turnObject?.items) ? (turnObject?.items as unknown[]) : [];
  const report = extractThreadReport(detail);
  const commandCount = items
    .filter((item) => item && typeof item === "object")
    .map((item) => item as Record<string, unknown>)
    .filter((item) => item.type === "commandExecution").length;
  const status = typeof turnObject?.status === "string" ? turnObject.status : null;
  const lines = [
    turns.length > 0 ? `历史轮次：${turns.length}` : "历史轮次：0",
    status ? `最近一轮：${status}` : null,
    commandCount > 0 ? `最近执行步骤：${commandCount} 个` : null,
    report?.reasoningSummary ? `处理摘要：${report.reasoningSummary}` : null,
    report?.finalResult ? `最近结论：${report.finalResult}` : "最近结论：暂无"
  ].filter(Boolean);
  return lines.join("\n");
};

type ThreadReport = {
  reasoningSummary: string | null;
  finalResult: string | null;
};

type SubAgentLike = {
  threadId: string;
  nickname: string | null;
  role: string | null;
  tool: string | null;
  status: string;
  model: string | null;
  reasoningEffort: string | null;
  message: string | null;
  updatedAt: string | null;
};

const emptyThreadReport = (): ThreadReport => ({
  reasoningSummary: null,
  finalResult: null
});

const mergeThreadReports = (...reports: Array<ThreadReport | null>): ThreadReport | null => {
  const finalResult = firstPresent(reports.map((report) => report?.finalResult ?? null));
  const reasoningSummary = firstPresent(reports.map((report) => report?.reasoningSummary ?? null));
  if (!finalResult && !reasoningSummary) return null;
  return { reasoningSummary, finalResult };
};

const compactSubAgentsForBinding = (...groups: SubAgentLike[][]): SubAgentLike[] => {
  const byThread = new Map<string, SubAgentLike>();
  for (const group of groups) {
    for (const agent of group) {
      if (!agent.threadId) continue;
      const previous = byThread.get(agent.threadId);
      byThread.set(agent.threadId, previous ? mergeSubAgentLike(previous, agent) : agent);
    }
  }
  return [...byThread.values()];
};

const mergeSubAgentLike = (previous: SubAgentLike, next: SubAgentLike): SubAgentLike => ({
  threadId: next.threadId,
  nickname: next.nickname ?? previous.nickname,
  role: next.role ?? previous.role,
  tool: next.tool ?? previous.tool,
  status: next.status !== "unknown" ? next.status : previous.status,
  model: next.model ?? previous.model,
  reasoningEffort: next.reasoningEffort ?? previous.reasoningEffort,
  message: next.message ?? previous.message,
  updatedAt: next.updatedAt ?? previous.updatedAt
});

const extractThreadReport = (detail: Record<string, unknown>): ThreadReport | null => {
  const rawThread = detail.thread && typeof detail.thread === "object" ? (detail.thread as Record<string, unknown>) : detail;
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const reasoning: string[] = [];
  const finalMessages: string[] = [];
  const plans: string[] = [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (!turn || typeof turn !== "object") continue;
    const items = Array.isArray((turn as Record<string, unknown>).items) ? ((turn as Record<string, unknown>).items as unknown[]) : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (!item || typeof item !== "object") continue;
      const object = item as Record<string, unknown>;
      const type = asString(object.type);
      if (type === "agentMessage") {
        const text = extractTextFromUnknown(object);
        if (text) finalMessages.push(text);
        continue;
      }
      if (type === "reasoning") {
        const summary = extractTextArray(object.summary);
        const content = extractTextArray(object.content);
        if (summary) reasoning.push(summary);
        else if (content) reasoning.push(content);
        continue;
      }
      if (type === "plan") {
        const text = extractTextFromUnknown(object);
        if (text) plans.push(text);
      }
    }
    if (finalMessages.length > 0) break;
  }
  const finalResult = firstSanitized(finalMessages, 200000);
  const reasoningSummary = firstSanitized(reasoning) ?? firstSanitized(plans);
  if (!finalResult && !reasoningSummary) return null;
  return { reasoningSummary, finalResult };
};

const extractTurnReport = (turn: Record<string, unknown>): ThreadReport | null => {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return extractReportFromItems(items);
};

const extractReportFromItems = (items: unknown[]): ThreadReport | null => {
  const reasoning: string[] = [];
  const finalMessages: string[] = [];
  const plans: string[] = [];
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (!item || typeof item !== "object") continue;
    const object = item as Record<string, unknown>;
    const type = asString(object.type);
    if (type === "agentMessage") {
      const text = extractTextFromUnknown(object);
      if (text) finalMessages.push(text);
      continue;
    }
    if (type === "reasoning") {
      const summary = extractTextArray(object.summary);
      const content = extractTextArray(object.content);
      if (summary) reasoning.push(summary);
      else if (content) reasoning.push(content);
      continue;
    }
    if (type === "plan") {
      const text = extractTextFromUnknown(object);
      if (text) plans.push(text);
    }
  }
  const finalResult = firstSanitized(finalMessages, 200000);
  const reasoningSummary = firstSanitized(reasoning) ?? firstSanitized(plans);
  if (!finalResult && !reasoningSummary) return null;
  return { reasoningSummary, finalResult };
};

const extractEventReport = (events: Array<{ codexTurnId: string | null; eventType: string; eventPayload: Record<string, unknown>; seq: number }>, turnId: string): ThreadReport | null => {
  const currentTurnEvents = events.filter((event) => !event.codexTurnId || event.codexTurnId === turnId);
  const completedAgent = latestSanitizedEventText(currentTurnEvents, "codex.agent_message", 200000);
  const agentDelta = firstSanitized([joinDeltaEvents(currentTurnEvents, "codex.agent_delta")].filter(Boolean) as string[], 200000);
  const reasoningCompleted =
    latestSanitizedEventText(currentTurnEvents, "codex.reasoning_summary") ??
    latestSanitizedEventText(currentTurnEvents, "codex.reasoning");
  const reasoningDelta = firstSanitized(
    [
      joinDeltaEvents(currentTurnEvents, "codex.reasoning_summary_delta"),
      joinDeltaEvents(currentTurnEvents, "codex.reasoning_delta")
    ].filter(Boolean) as string[]
  );
  const planCompleted = latestSanitizedEventText(currentTurnEvents, "codex.plan");
  const planDelta = firstSanitized([joinDeltaEvents(currentTurnEvents, "codex.plan_delta")].filter(Boolean) as string[]);
  const finalResult = completedAgent ?? agentDelta;
  const reasoningSummary = reasoningCompleted ?? reasoningDelta ?? planCompleted ?? planDelta;
  if (!finalResult && !reasoningSummary) return null;
  return { reasoningSummary, finalResult };
};

const buildCompletedItemEvent = (item: Record<string, unknown>): { eventType: string; text: string } | null => {
  const type = asString(item.type);
  if (type === "agentMessage") {
    const text = extractTextFromUnknown(item);
    return text ? { eventType: "codex.agent_message", text: truncate(text, 2000) } : null;
  }
  if (type === "plan") {
    const text = extractTextFromUnknown(item);
    return text ? { eventType: "codex.plan", text: truncate(text, 2000) } : null;
  }
  if (type === "reasoning") {
    const summary = extractTextArray(item.summary);
    const content = extractTextArray(item.content);
    const text = summary ?? content;
    if (!text) return null;
    return { eventType: summary ? "codex.reasoning_summary" : "codex.reasoning", text: truncate(text, 2000) };
  }
  return null;
};

type ItemProgressEvent = {
  eventType: string;
  label: string;
  itemId: string | null;
  itemType: string;
  text: string;
  payload?: Record<string, unknown>;
};

const buildItemProgressEvent = (
  item: Record<string, unknown>,
  phase: "started" | "completed"
): ItemProgressEvent | null => {
  const type = asString(item.type);
  const itemId = asString(item.id);
  if (!type) return null;
  if (type === "commandExecution") {
    const command = asString(item.command);
    const status = asString(item.status);
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
    const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
    const cwd = asString(item.cwd);
    const actionText = formatCommandActions(item.commandActions);
    const lines = [
      phase === "started" ? "开始执行命令。" : `命令执行${exitCode === 0 || status === "completed" ? "完成" : "结束"}。`,
      command ? `命令：${truncatePlain(command, 180)}` : null,
      cwd ? `目录：${truncatePlain(cwd, 160)}` : null,
      actionText ? `动作：${actionText}` : null,
      phase === "completed" && exitCode != null ? `结果：exit ${exitCode}` : null,
      phase === "completed" && durationMs != null ? `耗时：${formatDurationMs(durationMs)}` : null
    ].filter(Boolean);
    return {
      eventType: "codex.command_execution",
      label: "执行命令",
      itemId,
      itemType: type,
      text: lines.join("\n"),
      payload: { command, status, exitCode, durationMs, cwd }
    };
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const text = formatFileChangeSummary(changes, phase);
    if (!text) return null;
    return {
      eventType: "codex.file_change",
      label: "文件变更",
      itemId,
      itemType: type,
      text,
      payload: { status: asString(item.status), changesCount: changes.length }
    };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const toolName = formatToolName(item, type);
    const status = asString(item.status);
    const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
    const error = extractToolError(item);
    const lines = [
      phase === "started" ? "开始调用工具。" : "工具调用结束。",
      toolName ? `工具：${toolName}` : null,
      status ? `状态：${status}` : null,
      error ? `异常：${truncatePlain(error, 220)}` : null,
      phase === "completed" && durationMs != null ? `耗时：${formatDurationMs(durationMs)}` : null
    ].filter(Boolean);
    return {
      eventType: "codex.tool_progress",
      label: "工具进度",
      itemId,
      itemType: type,
      text: lines.join("\n"),
      payload: { status, toolName, durationMs, error }
    };
  }
  if (type === "collabAgentToolCall") {
    const text = formatCollabToolProgress(item, phase);
    if (!text) return null;
    return {
      eventType: "codex.subagent",
      label: "子 Agent",
      itemId,
      itemType: type,
      text,
      payload: { status: asString(item.status), tool: asString(item.tool) }
    };
  }
  if (type === "webSearch") {
    const query = asString(item.query);
    const action = item.action && typeof item.action === "object" ? (item.action as Record<string, unknown>) : {};
    const actionText = formatWebSearchAction(action);
    return {
      eventType: "codex.tool_progress",
      label: "资料检索",
      itemId,
      itemType: type,
      text: [phase === "started" ? "开始检索资料。" : "资料检索完成。", query ? `查询：${truncatePlain(query, 220)}` : actionText].filter(Boolean).join("\n"),
      payload: { query, action: actionText }
    };
  }
  if (type === "imageView" || type === "imageGeneration") {
    const text = formatImageProgress(item, type, phase);
    if (!text) return null;
    return {
      eventType: "codex.tool_progress",
      label: "图片处理",
      itemId,
      itemType: type,
      text
    };
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode" || type === "contextCompaction") {
    const text = formatStateItemProgress(item, type, phase);
    if (!text) return null;
    return {
      eventType: "codex.tool_progress",
      label: "处理状态",
      itemId,
      itemType: type,
      text
    };
  }
  return null;
};

const buildRawResponseItemEvent = (item: Record<string, unknown>): (ItemProgressEvent & { itemId: string | null }) | null => {
  const type = asString(item.type);
  const itemId = asString(item.id) ?? asString(item.call_id) ?? asString(item.callId);
  if (type === "message") {
    const text = extractTextFromUnknown(item.content);
    return text
      ? {
          eventType: "codex.agent_message",
          label: "阶段性回复",
          itemId,
          itemType: type,
          text: truncate(text, 2000)
        }
      : null;
  }
  if (type === "reasoning") {
    const summary = extractTextArray(item.summary);
    const content = extractTextArray(item.content);
    const text = summary ?? content;
    return text
      ? {
          eventType: summary ? "codex.reasoning_summary" : "codex.reasoning",
          label: "处理摘要",
          itemId,
          itemType: type,
          text: truncate(text, 2000)
        }
      : null;
  }
  if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call" || type === "web_search_call") {
    const name = asString(item.name) ?? asString(item.execution) ?? type;
    const status = asString(item.status);
    return {
      eventType: "codex.tool_progress",
      label: type === "web_search_call" || type === "tool_search_call" ? "资料检索" : "工具进度",
      itemId,
      itemType: type,
      text: [`${rawResponseTypeText(type)}。`, name ? `名称：${truncatePlain(name, 160)}` : null, status ? `状态：${status}` : null].filter(Boolean).join("\n")
    };
  }
  if (type === "local_shell_call") {
    const action = item.action && typeof item.action === "object" ? (item.action as Record<string, unknown>) : {};
    const command = asString(action.command);
    const status = asString(item.status);
    return {
      eventType: "codex.command_execution",
      label: "执行命令",
      itemId,
      itemType: type,
      text: ["命令执行状态更新。", command ? `命令：${truncatePlain(command, 180)}` : null, status ? `状态：${status}` : null].filter(Boolean).join("\n")
    };
  }
  return null;
};

const formatFileChangeSummary = (changes: unknown[], phase: "started" | "completed" | "updated"): string | null => {
  const parsed = changes
    .map((change) => (change && typeof change === "object" ? (change as Record<string, unknown>) : null))
    .filter((change): change is Record<string, unknown> => Boolean(change));
  if (parsed.length === 0) return null;
  const counts = new Map<string, number>();
  const files = parsed.slice(0, 6).map((change) => {
    const kind = formatPatchKind(change.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const path = asString(change.path) ?? "未知文件";
    return `- ${kind}：${truncatePlain(path, 180)}`;
  });
  for (const change of parsed.slice(6)) {
    const kind = formatPatchKind(change.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const countText = [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join("，");
  const prefix =
    phase === "started"
      ? "开始修改文件。"
      : phase === "completed"
        ? "文件修改完成。"
        : "文件修改内容已更新。";
  const hidden = parsed.length > files.length ? `\n... 还有 ${parsed.length - files.length} 个文件` : "";
  return [`${prefix}${countText ? `（${countText}）` : ""}`, files.join("\n") + hidden].filter(Boolean).join("\n");
};

const formatPatchKind = (kind: unknown): string => {
  if (typeof kind === "string") return patchKindText(kind);
  if (kind && typeof kind === "object") {
    const type = asString((kind as Record<string, unknown>).type);
    const movePath = asString((kind as Record<string, unknown>).move_path);
    return movePath ? `${patchKindText(type)} -> ${truncatePlain(movePath, 100)}` : patchKindText(type);
  }
  return "修改";
};

const patchKindText = (type: string | null): string =>
  ({
    add: "新增",
    delete: "删除",
    update: "修改"
  })[type ?? ""] ?? "修改";

const formatCommandActions = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const actions = value
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => {
      const type = asString(entry.type);
      const path = asString(entry.path);
      const query = asString(entry.query);
      const name = asString(entry.name);
      if (type === "read") return `读取 ${name ?? path ?? "文件"}`;
      if (type === "listFiles") return `查看文件 ${path ?? ""}`.trim();
      if (type === "search") return `搜索 ${query ?? path ?? ""}`.trim();
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
  return actions.length > 0 ? actions.slice(0, 3).join("；") : null;
};

const formatToolName = (item: Record<string, unknown>, type: string): string | null => {
  if (type === "mcpToolCall") {
    const server = asString(item.server);
    const tool = asString(item.tool);
    return [server, tool].filter(Boolean).join(".") || null;
  }
  const namespace = asString(item.namespace);
  const tool = asString(item.tool);
  return [namespace, tool].filter(Boolean).join(".") || null;
};

const extractToolError = (item: Record<string, unknown>): string | null => {
  const error = item.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") return asString((error as Record<string, unknown>).message);
  return null;
};

const formatCollabToolProgress = (item: Record<string, unknown>, phase: "started" | "completed"): string | null => {
  const tool = asString(item.tool);
  const status = asString(item.status);
  const model = asString(item.model);
  const reasoningEffort = asString(item.reasoningEffort);
  const receiverCount = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0;
  const lines = [
    phase === "started" ? "子 Agent 调用开始。" : "子 Agent 调用更新。",
    tool ? `动作：${tool}` : null,
    status ? `状态：${status}` : null,
    receiverCount > 0 ? `数量：${receiverCount}` : null,
    model ? `模型：${model}` : null,
    reasoningEffort ? `思考：${reasoningEffort}` : null
  ].filter(Boolean);
  return lines.length > 1 ? lines.join("\n") : null;
};

const formatWebSearchAction = (action: Record<string, unknown>): string | null => {
  const type = asString(action.type);
  const query = asString(action.query);
  const url = asString(action.url);
  const pattern = asString(action.pattern);
  if (type === "search") return query ? `查询：${truncatePlain(query, 220)}` : "执行搜索。";
  if (type === "openPage" || type === "open_page") return url ? `打开页面：${truncatePlain(url, 220)}` : "打开页面。";
  if (type === "findInPage" || type === "find_in_page") return pattern ? `页内查找：${truncatePlain(pattern, 160)}` : "页内查找。";
  return null;
};

const formatImageProgress = (item: Record<string, unknown>, type: string, phase: "started" | "completed"): string | null => {
  if (type === "imageView") {
    const path = asString(item.path);
    return [phase === "started" ? "开始查看图片。" : "图片查看完成。", path ? `文件：${truncatePlain(path, 180)}` : null].filter(Boolean).join("\n");
  }
  const status = asString(item.status);
  const savedPath = asString(item.savedPath);
  return [
    phase === "started" ? "开始生成图片。" : "图片生成更新。",
    status ? `状态：${status}` : null,
    savedPath ? `文件：${truncatePlain(savedPath, 180)}` : null
  ].filter(Boolean).join("\n");
};

const formatStateItemProgress = (item: Record<string, unknown>, type: string, phase: "started" | "completed"): string | null => {
  const review = asString(item.review);
  if (type === "enteredReviewMode") return review ? `进入评审模式：${truncatePlain(review, 220)}` : "进入评审模式。";
  if (type === "exitedReviewMode") return review ? `退出评审模式：${truncatePlain(review, 220)}` : "退出评审模式。";
  if (type === "contextCompaction") return phase === "completed" ? "上下文压缩完成。" : "开始压缩上下文。";
  return null;
};

const rawResponseTypeText = (type: string): string =>
  ({
    function_call: "开始调用函数",
    custom_tool_call: "开始调用工具",
    tool_search_call: "开始检索资料",
    web_search_call: "开始网页搜索"
  })[type] ?? "模型响应更新";

const formatDurationMs = (durationMs: number): string => {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
};

const formatThreadReport = (
  binding: SessionBinding,
  report: ThreadReport,
  status: TaskStatus,
  events: TaskEvent[],
  projectName: string | null,
  subAgents = extractSubAgentsFromEvents(events)
) => {
  const reasoningSummary = report.reasoningSummary ? sanitizeAssistantMarkdown(report.reasoningSummary, 1800) : null;
  const fullFinalResult = report.finalResult ? sanitizeAssistantMarkdown(report.finalResult, 200000) : null;
  const finalResult = report.finalResult ? sanitizeAssistantMarkdown(report.finalResult, 8600) : null;
  const highlights = deriveHighlights(reasoningSummary, finalResult, 3);
  const changeItems = deriveChangeItems(events, reasoningSummary, finalResult, 3);
  const verificationItems = deriveVerificationItems(events, reasoningSummary, finalResult, 3);
  const nextSteps = deriveNextSteps(finalResult, 3);
  return {
    title: binding.title ?? "Codex 任务",
    status,
    projectName: projectName ?? "Playground",
    reasoningSummary,
    finalResult,
    subAgents,
    highlights,
    changeItems,
    verificationItems,
    nextSteps,
    fullFinalResult,
    finalResultTruncated: Boolean(finalResult && fullFinalResult && finalResult !== fullFinalResult),
    updatedAt: new Date().toISOString()
  };
};

const formatFullFinalResult = (report: ThreadReport): string => {
  const lines = [
    "完整最终结论",
    report.finalResult ? sanitizeAssistantMarkdown(report.finalResult, 200000) : "未提取到最终回复文本，请发送 /logs 查看本地任务记录。"
  ];
  return lines.join("\n\n");
};

const firstSanitized = (items: string[], maxLength = 6000): string | null => {
  for (const item of items) {
    const sanitized = sanitizeAssistantMarkdown(item, maxLength);
    if (sanitized && sanitized !== "有输出，原始内容已保留在本地记录中。") return sanitized;
  }
  return null;
};

const firstPresent = (items: Array<string | null>): string | null => {
  for (const item of items) {
    if (item && item.trim()) return item.trim();
  }
  return null;
};

const latestSanitizedEventText = (
  events: Array<{ eventType: string; eventPayload: Record<string, unknown>; seq: number }>,
  eventType: string,
  maxLength = 6000
): string | null => {
  const matched = [...events]
    .filter((event) => event.eventType === eventType)
    .sort((left, right) => right.seq - left.seq);
  for (const event of matched) {
    const text = asString(event.eventPayload.text);
    if (!text) continue;
    const sanitized = sanitizeAssistantMarkdown(text, maxLength);
    if (sanitized && sanitized !== "有输出，原始内容已保留在本地记录中。") return sanitized;
  }
  return null;
};

const firstEventPayloadText = (events: TaskEvent[], eventType: string, field: string): string | null => {
  for (const event of events) {
    if (event.eventType !== eventType) continue;
    const text = asString(event.eventPayload[field]);
    if (!text) continue;
    return text.trim();
  }
  return null;
};

const latestEventPayloadText = (events: TaskEvent[], eventTypes: string[], field: string): string | null => {
  const wanted = new Set(eventTypes);
  const matched = [...events].filter((event) => wanted.has(event.eventType)).sort((left, right) => right.seq - left.seq);
  for (const event of matched) {
    const text = asString(event.eventPayload[field]);
    if (!text) continue;
    return text.trim();
  }
  return null;
};

const latestProcessText = (events: TaskEvent[], eventTypes: string[]): string | null => {
  for (const eventType of eventTypes) {
    if (eventType.endsWith("_delta")) {
      const joined = joinDeltaEvents(events, eventType);
      const sanitized = sanitizeProcessText(joined ?? "", 2200);
      if (sanitized && sanitized !== "有输出，原始内容已保留在本地记录中。") return sanitized;
      continue;
    }
    const matched = [...events].filter((event) => event.eventType === eventType).sort((left, right) => right.seq - left.seq);
    for (const event of matched) {
      const text = asString(event.eventPayload.text);
      const sanitized = sanitizeProcessText(text ?? "", 2200);
      if (sanitized && sanitized !== "有输出，原始内容已保留在本地记录中。") return sanitized;
    }
  }
  return null;
};

const joinDeltaEvents = (
  events: Array<{ eventType: string; eventPayload: Record<string, unknown>; seq: number }>,
  eventType: string
): string | null => {
  const grouped = new Map<string, Array<{ seq: number; text: string }>>();
  for (const event of events) {
    if (event.eventType !== eventType) continue;
    const text = asString(event.eventPayload.text);
    if (!text) continue;
    const itemId = asString(event.eventPayload.itemId) ?? "default";
    const group = grouped.get(itemId) ?? [];
    group.push({ seq: event.seq, text });
    grouped.set(itemId, group);
  }
  const candidates = [...grouped.values()]
    .map((group) => group.sort((left, right) => left.seq - right.seq).map((entry) => entry.text).join(""))
    .filter((text) => text.trim().length > 0);
  return candidates.length > 0 ? candidates[candidates.length - 1]!.trim() : null;
};

const extractTextArray = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const text = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") return extractTextFromUnknown(entry as Record<string, unknown>);
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text.trim() || null;
};

const extractTextFromUnknown = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return extractTextArray(value);
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const key of ["text", "content", "message", "delta", "summary"]) {
    const raw = object[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    const arrayText = extractTextArray(raw);
    if (arrayText) return arrayText;
  }
  return null;
};

const sanitizeAssistantSummary = (text: string, maxLength = 6000): string => {
  const compact = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(compact || "有输出，原始内容已保留在本地记录中。", maxLength);
};

// Preserve Codex-style Markdown for Feishu report cards while removing noisy shell-only lines.
const sanitizeAssistantMarkdown = (text: string, maxLength = 6000): string => {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""));
  const normalized = lines
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return truncate(normalized || "有输出，原始内容已保留在本地记录中。", maxLength);
};

const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const formatPlanProgress = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const lines = value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const object = item as Record<string, unknown>;
      const step = asString(object.step);
      if (!step) return null;
      const status = asString(object.status);
      const prefix =
        status === "completed" ? "[完成]" :
        status === "in_progress" || status === "inProgress" ? "[进行中]" :
        "[待处理]";
      return `${index + 1}. ${prefix} ${step}`;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : null;
};

const sanitizeProgressText = (text: string): string => {
  const sanitized = sanitizeAssistantSummary(text, 900);
  return sanitized.length > 900 ? truncatePlain(sanitized, 900) : sanitized;
};

const sanitizeProcessText = (text: string, maxLength = 1800): string => {
  if (!text.trim()) return "";
  const sanitized = sanitizeAssistantSummary(text, maxLength);
  if (!sanitized || sanitized === "有输出，原始内容已保留在本地记录中。") return "";
  return sanitized.length > maxLength ? truncatePlain(sanitized, maxLength) : sanitized;
};

const deriveHighlights = (reasoningSummary: string | null, finalResult: string | null, limit: number): string[] => {
  const source = [finalResult, reasoningSummary].filter(Boolean).join("\n");
  if (!source.trim()) return [];
  return splitIntoBulletCandidates(source)
    .slice(0, limit)
    .map((line) => truncatePlain(line, 120));
};

const deriveNextSteps = (finalResult: string | null, limit: number): string[] => {
  if (!finalResult) return [];
  const lines = splitIntoBulletCandidates(finalResult).filter((line) =>
    /(建议|后续|下一步|可以|需要|应当|推荐|继续)/.test(line)
  );
  return lines.slice(0, limit).map((line) => truncatePlain(line, 120));
};

const deriveChangeItems = (events: TaskEvent[], reasoningSummary: string | null, finalResult: string | null, limit: number): string[] => {
  const eventItems = deriveItemsFromEvents(
    events,
    ["codex.plan", "codex.plan_updated", "codex.plan_delta", "codex.agent_message", "codex.agent_delta"],
    /(修改|新增|调整|修复|更新|重构|处理了|实现了)/
  );
  if (eventItems.length > 0) return eventItems.slice(0, limit).map((line) => truncatePlain(line, 120));
  const source = [reasoningSummary, finalResult].filter(Boolean).join("\n");
  if (!source) return [];
  return splitIntoBulletCandidates(source)
    .filter((line) => /(修改|新增|调整|修复|更新|重构|处理了|实现了)/.test(line))
    .slice(0, limit)
    .map((line) => truncatePlain(line, 120));
};

const deriveVerificationItems = (events: TaskEvent[], reasoningSummary: string | null, finalResult: string | null, limit: number): string[] => {
  const eventItems = deriveItemsFromEvents(
    events,
    ["codex.agent_message", "codex.agent_delta", "codex.plan", "codex.plan_updated", "codex.tool_progress"],
    /(测试|验证|通过|失败|检查|确认|运行)/
  );
  if (eventItems.length > 0) return eventItems.slice(0, limit).map((line) => truncatePlain(line, 120));
  const source = [finalResult, reasoningSummary].filter(Boolean).join("\n");
  if (!source) return [];
  return splitIntoBulletCandidates(source)
    .filter((line) => /(测试|验证|通过|失败|检查|确认|运行)/.test(line))
    .slice(0, limit)
    .map((line) => truncatePlain(line, 120));
};

const splitIntoBulletCandidates = (value: string): string[] =>
  value
    .split(/[\r\n。；;]+/)
    .map((line) => line.replace(/^\s*[-*•\d.]+\s*/, "").trim())
    .filter((line) => line.length >= 6);

const deriveItemsFromEvents = (events: TaskEvent[], eventTypes: string[], matcher: RegExp): string[] => {
  const wanted = new Set(eventTypes);
  const results: string[] = [];
  for (const event of events) {
    if (!wanted.has(event.eventType)) continue;
    const text = asString(event.eventPayload.text);
    if (!text) continue;
    for (const line of splitIntoBulletCandidates(text)) {
      if (!matcher.test(line)) continue;
      if (!results.includes(line)) results.push(line);
    }
  }
  return results;
};

const inferProjectName = (cwd: string, fallback: string): string => {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const leaf = segments[segments.length - 1];
  return leaf && leaf.trim().length > 0 ? leaf.trim() : fallback;
};

const resolveWorkspacePath = (value: string): string => {
  const trimmed = value.trim();
  const withHome = trimmed.startsWith("~/") || trimmed.startsWith("~\\")
    ? resolve(homedir(), trimmed.slice(2))
    : trimmed;
  return resolve(withHome);
};

const normalizeWorkspacePath = (value: string): string =>
  value.trim().replace(/[\\/]+/g, "/").replace(/\/+$/g, "").toLowerCase();

const readCodexAppWorkspaceRoots = (statePath: string): Array<{ rootPath: string; source: string }> => {
  if (!existsSync(statePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    const state = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const persisted = state["electron-persisted-atom-state"];
    const object = persisted && typeof persisted === "object" ? (persisted as Record<string, unknown>) : {};
    const ordered = [
      ...workspaceRootsFromStateValue(state["project-order"], "codex_app_project_order"),
      ...workspaceRootsFromStateValue(state["electron-saved-workspace-roots"], "codex_app_saved_workspace"),
      ...workspaceRootsFromStateValue(state["active-workspace-roots"], "codex_app_active_workspace"),
      ...workspaceRootsFromStateValue(object["project-order"], "codex_app_project_order"),
      ...workspaceRootsFromStateValue(object["electron-saved-workspace-roots"], "codex_app_saved_workspace"),
      ...workspaceRootsFromStateValue(object["active-workspace-roots"], "codex_app_active_workspace")
    ];
    const seen = new Set<string>();
    return ordered.filter((entry) => {
      const normalized = normalizeWorkspacePath(resolveWorkspacePath(entry.rootPath));
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  } catch {
    return [];
  }
};

const workspaceRootsFromStateValue = (value: unknown, source: string): Array<{ rootPath: string; source: string }> => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((rootPath) => ({ rootPath, source }));
};

const presentStoredServerRequest = (request: ActionRequest, options: { detail?: boolean } = {}): PresentedServerRequest => {
  const payload = parseStoredServerRequestPayload(request.payload);
  if (!payload) {
    return {
      title: "桌面请求",
      body: "请求记录已损坏，无法展示。",
      commands: [`/request detail ${request.actionId}`],
      buttons: []
    };
  }
  return buildStoredServerRequestPresentation(payload, options.detail === true);
};

const parseStoredServerRequestPayload = (value: Record<string, unknown>): StoredServerRequestPayload | null => {
  const requestId = asString(value.requestId) ?? asString(value.id);
  const method = asString(value.method);
  const threadId = asString(value.threadId);
  const turnId = asString(value.turnId);
  const itemId = asString(value.itemId);
  const bindingId = asString(value.bindingId);
  const params = value.params && typeof value.params === "object" ? (value.params as Record<string, unknown>) : null;
  if (!requestId || !method || !threadId || !bindingId || !params) return null;
  return { requestId, method, threadId, turnId, itemId, bindingId, params };
};

const buildStoredServerRequestPresentation = (payload: StoredServerRequestPayload, detail: boolean): PresentedServerRequest => {
  switch (payload.method) {
    case "execCommandApproval":
      return buildExecCommandApprovalPresentation(payload, detail);
    case "applyPatchApproval":
      return buildApplyPatchApprovalPresentation(payload, detail);
    case "item/permissions/requestApproval":
      return buildPermissionsRequestPresentation(payload, detail);
    case "item/tool/requestUserInput":
      return buildToolUserInputPresentation(payload, detail);
    case "mcpServer/elicitation/request":
      return buildMcpElicitationPresentation(payload, detail);
    case "item/tool/call":
      return buildDynamicToolCallPresentation(payload, detail);
    default:
      return buildUnknownServerRequestPresentation(payload, detail);
  }
};

const buildUnknownServerRequestPresentation = (payload: StoredServerRequestPayload, detail: boolean): PresentedServerRequest => ({
  title: serverRequestTitleText(payload.method),
  body: [
    `**类型**  ${serverRequestTitleText(payload.method)}`,
    `**线程**  ${payload.threadId}`,
    payload.turnId ? `**轮次**  ${payload.turnId}` : null,
    `**请求**  ${payload.requestId}`,
    detail ? `**参数**\n\n${safeJsonForCard(payload.params, 1800)}` : null
  ]
    .filter(Boolean)
    .join("\n\n"),
  commands: [`/request detail ${payload.requestId}`],
  buttons: [buttonDescriptor("详情", "server_request_detail", { requestId: payload.requestId })]
});

const buildExecCommandApprovalPresentation = (payload: StoredServerRequestPayload, detail: boolean): PresentedServerRequest => {
  const params = payload.params as Record<string, unknown>;
  const command = Array.isArray(params.command) ? params.command.map((item) => String(item)).join(" ") : asString(params.command) ?? "";
  const commandActions = formatCommandActions(params.commandActions) ?? formatParsedCommands(params.parsedCmd) ?? null;
  const buttons = [
    buttonDescriptor("允许一次", "server_request_resolve", { requestId: payload.requestId, resolution: "accept_once" }),
    buttonDescriptor("本轮允许", "server_request_resolve", { requestId: payload.requestId, resolution: "accept_session" }),
    buttonDescriptor("拒绝", "server_request_resolve", { requestId: payload.requestId, resolution: "deny" }),
    buttonDescriptor("中止", "server_request_resolve", { requestId: payload.requestId, resolution: "abort" })
  ];
  if (params.proposedExecpolicyAmendment) {
    buttons.splice(2, 0, buttonDescriptor("按提议放行", "server_request_resolve", { requestId: payload.requestId, resolution: "accept_execpolicy" }));
  }
  if (Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length > 0) {
    buttons.splice(3, 0, buttonDescriptor("网络策略放行", "server_request_resolve", { requestId: payload.requestId, resolution: "accept_network_policy" }));
  }
  return {
    title: "命令执行审批",
    body: [
      `**类型**  命令执行审批`,
      `**线程**  ${payload.threadId}`,
      payload.turnId ? `**轮次**  ${payload.turnId}` : null,
      `**请求**  ${payload.requestId}`,
      command ? `**命令**\n\n${truncatePlain(command, 1200)}` : null,
      params.cwd ? `**目录**  ${truncatePlain(String(params.cwd), 300)}` : null,
      params.reason ? `**原因**  ${truncatePlain(String(params.reason), 1200)}` : null,
      commandActions ? `**动作**\n\n${commandActions}` : null,
      detail ? `**原始参数**\n\n${safeJsonForCard(params, 2600)}` : null
    ]
      .filter(Boolean)
      .join("\n\n"),
    commands: [`/request detail ${payload.requestId}`, `/request allow ${payload.requestId}`, `/request session ${payload.requestId}`, `/request deny ${payload.requestId}`, `/request abort ${payload.requestId}`],
    buttons
  };
};

const buildApplyPatchApprovalPresentation = (payload: StoredServerRequestPayload, detail: boolean): PresentedServerRequest => {
  const params = payload.params as Record<string, unknown>;
  const fileChanges = fileChangesFromMap(params.fileChanges);
  return {
    title: "补丁应用审批",
    body: [
      `**类型**  补丁应用审批`,
      `**线程**  ${payload.threadId}`,
      payload.turnId ? `**轮次**  ${payload.turnId}` : null,
      `**请求**  ${payload.requestId}`,
      params.reason ? `**原因**  ${truncatePlain(String(params.reason), 1200)}` : null,
      params.grantRoot ? `**授权根目录**  ${truncatePlain(String(params.grantRoot), 300)}` : null,
      fileChanges ? `**文件变更**\n\n${fileChanges}` : null,
      detail ? `**原始参数**\n\n${safeJsonForCard(params, 2600)}` : null
    ]
      .filter(Boolean)
      .join("\n\n"),
    commands: [`/request detail ${payload.requestId}`, `/request allow ${payload.requestId}`, `/request session ${payload.requestId}`, `/request deny ${payload.requestId}`, `/request abort ${payload.requestId}`],
    buttons: [
      buttonDescriptor("允许一次", "server_request_resolve", { requestId: payload.requestId, resolution: "accept_once" }),
      buttonDescriptor("本轮允许", "server_request_resolve", { requestId: payload.requestId, resolution: "accept_session" }),
      buttonDescriptor("拒绝", "server_request_resolve", { requestId: payload.requestId, resolution: "deny" }),
      buttonDescriptor("中止", "server_request_resolve", { requestId: payload.requestId, resolution: "abort" })
    ]
  };
};

const buildPermissionsRequestPresentation = (payload: StoredServerRequestPayload, detail: boolean): PresentedServerRequest => {
  const params = payload.params as Record<string, unknown>;
  const permissions = params.permissions && typeof params.permissions === "object" ? (params.permissions as Record<string, unknown>) : {};
  return {
    title: "额外权限请求",
    body: [
      `**类型**  额外权限请求`,
      `**线程**  ${payload.threadId}`,
      payload.turnId ? `**轮次**  ${payload.turnId}` : null,
      `**请求**  ${payload.requestId}`,
      params.reason ? `**原因**  ${truncatePlain(String(params.reason), 1200)}` : null,
      permissions.fileSystem ? `**文件系统**\n\n${safeJsonForCard(permissions.fileSystem, 1200)}` : null,
      permissions.network ? `**网络**\n\n${safeJsonForCard(permissions.network, 1200)}` : null,
      detail ? `**原始参数**\n\n${safeJsonForCard(params, 2600)}` : null
    ]
      .filter(Boolean)
      .join("\n\n"),
    commands: [`/request detail ${payload.requestId}`, `/request allow ${payload.requestId}`, `/request session ${payload.requestId}`, `/request deny ${payload.requestId}`],
    buttons: [
      buttonDescriptor("允许一次", "server_request_resolve", { requestId: payload.requestId, resolution: "permissions_turn" }),
      buttonDescriptor("本轮允许", "server_request_resolve", { requestId: payload.requestId, resolution: "permissions_session" }),
      buttonDescriptor("拒绝", "server_request_resolve", { requestId: payload.requestId, resolution: "deny" })
    ]
  };
};

const buildToolUserInputPresentation = (payload: StoredServerRequestPayload, detail: boolean): PresentedServerRequest => {
  const params = payload.params as Record<string, unknown>;
  const questions = Array.isArray(params.questions)
    ? params.questions
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const buttons: PresentedServerRequest["buttons"] = [];
  if (questions.length === 1) {
    const question = questions[0]!;
    const questionId = asString(question.id) ?? "question";
    const options = Array.isArray(question.options)
      ? question.options
          .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
          .filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    for (const option of options.slice(0, 4)) {
      const label = asString(option.label) ?? asString(option.description) ?? "选项";
      buttons.push(buttonDescriptor(label, "server_request_resolve", { requestId: payload.requestId, resolution: "select_option", questionId, answer: label }));
    }
  }
  return {
    title: "用户输入请求",
    body: [
      `**类型**  用户输入请求`,
      `**线程**  ${payload.threadId}`,
      payload.turnId ? `**轮次**  ${payload.turnId}` : null,
      `**请求**  ${payload.requestId}`,
      questions.length > 0
        ? `**问题**\n\n${questions
            .map((question, index) => {
              const header = asString(question.header) ?? `问题 ${index + 1}`;
              const text = asString(question.question) ?? "";
              const options = Array.isArray(question.options)
                ? question.options
                    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
                    .filter((item): item is Record<string, unknown> => Boolean(item))
                    .map((option) => `${asString(option.label) ?? "选项"}${asString(option.description) ? `：${asString(option.description)}` : ""}`)
                    .join("\n")
                : "";
              return [header, text, options].filter(Boolean).join("\n");
            })
            .join("\n\n")}`
        : null,
      detail ? `**原始参数**\n\n${safeJsonForCard(params, 2600)}` : null
    ]
      .filter(Boolean)
      .join("\n\n"),
    commands: [`/request detail ${payload.requestId}`, `/request input ${payload.requestId} <json>`],
    buttons,
    form: questions.length > 0
      ? {
          submitLabel: "提交回答",
          submitPayload: { requestId: payload.requestId },
          fields: buildToolUserInputFields(questions)
        }
      : undefined
  };
};

const buildMcpElicitationPresentation = (payload: StoredServerRequestPayload, detail: boolean): PresentedServerRequest => {
  const params = payload.params as Record<string, unknown>;
  const buttons: PresentedServerRequest["buttons"] = [
    buttonDescriptor("拒绝", "server_request_resolve", { requestId: payload.requestId, resolution: "deny" }),
    buttonDescriptor("取消", "server_request_resolve", { requestId: payload.requestId, resolution: "cancel" })
  ];
  if (params.mode === "url" || mcpElicitationCanAcceptWithoutContent(params.requestedSchema)) {
    buttons.unshift(buttonDescriptor("接受", "server_request_resolve", { requestId: payload.requestId, resolution: "accept_empty" }));
  }
  return {
    title: "MCP 请求",
    body: [
      `**类型**  MCP 请求`,
      `**线程**  ${payload.threadId}`,
      payload.turnId ? `**轮次**  ${payload.turnId}` : null,
      `**服务**  ${truncatePlain(String(params.serverName ?? "未知"), 300)}`,
      params.message ? `**消息**\n\n${truncatePlain(String(params.message), 1200)}` : null,
      params.mode === "url" ? `**地址**  ${truncatePlain(String(params.url ?? ""), 1200)}` : null,
      params.mode === "form" ? `**表单**\n\n${summarizeMcpSchema(params.requestedSchema)}` : null,
      detail ? `**原始参数**\n\n${safeJsonForCard(params, 2600)}` : null
    ]
      .filter(Boolean)
      .join("\n\n"),
    commands: [`/request detail ${payload.requestId}`, `/request input ${payload.requestId} <json>`, `/request deny ${payload.requestId}`],
    buttons,
    form:
      params.mode === "form"
        ? {
            submitLabel: "提交表单",
            submitPayload: { requestId: payload.requestId },
            fields: buildMcpElicitationFields(params.requestedSchema)
          }
        : undefined
  };
};

const buildDynamicToolCallPresentation = (payload: StoredServerRequestPayload, detail: boolean): PresentedServerRequest => {
  const params = payload.params as Record<string, unknown>;
  const toolName =
    [asString(params.namespace), asString(params.tool)].filter(Boolean).join(".") ||
    asString(params.tool) ||
    "unknown tool";
  return {
    title: "工具调用请求",
    body: [
      `**类型**  工具调用请求`,
      `**线程**  ${payload.threadId}`,
      payload.turnId ? `**轮次**  ${payload.turnId}` : null,
      `**工具**  ${truncatePlain(toolName, 300)}`,
      params.arguments ? `**参数**\n\n${safeJsonForCard(params.arguments, 1800)}` : null,
      detail ? `**原始参数**\n\n${safeJsonForCard(params, 2600)}` : null
    ]
      .filter(Boolean)
      .join("\n\n"),
    commands: [`/request detail ${payload.requestId}`, `/request input ${payload.requestId} <json>`],
    buttons: [
      buttonDescriptor("成功", "server_request_resolve", { requestId: payload.requestId, resolution: "tool_success_empty" }),
      buttonDescriptor("失败", "server_request_resolve", { requestId: payload.requestId, resolution: "tool_failure_empty" })
    ]
  };
};

const buildStoredServerRequestResponse = (
  request: ActionRequest,
  actionPayload: Record<string, unknown>,
  formValue: Record<string, unknown> | null = null
): Record<string, unknown> => {
  const payload = parseStoredServerRequestPayload(request.payload);
  if (!payload) throw new Error("请求记录已损坏");
  const rawJson = asString(actionPayload.responseJson);
  if (rawJson) return parseJsonForServerRequest(rawJson);
  const resolution = asString(actionPayload.resolution) ?? "accept_once";
  switch (payload.method) {
    case "execCommandApproval":
      return buildExecCommandApprovalResponse(payload, actionPayload, resolution);
    case "applyPatchApproval":
      return buildApplyPatchApprovalResponse(actionPayload, resolution);
    case "item/permissions/requestApproval":
      return buildPermissionsRequestResponse(payload, actionPayload, resolution);
    case "item/tool/requestUserInput":
      return buildToolUserInputResponse(payload, actionPayload, formValue);
    case "mcpServer/elicitation/request":
      return buildMcpElicitationResponse(payload, actionPayload, formValue, resolution);
    case "item/tool/call":
      return buildDynamicToolCallResponse(actionPayload, resolution);
    default:
      throw new Error(`不支持的请求类型：${payload.method}`);
  }
};

const buildExecCommandApprovalResponse = (payload: StoredServerRequestPayload, actionPayload: Record<string, unknown>, resolution: string): Record<string, unknown> => {
  const params = payload.params as Record<string, unknown>;
  if (resolution === "accept_execpolicy" && params.proposedExecpolicyAmendment) {
    return { decision: { approved_execpolicy_amendment: { proposed_execpolicy_amendment: params.proposedExecpolicyAmendment } } };
  }
  if (resolution === "accept_network_policy" && Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length > 0) {
    return { decision: { network_policy_amendment: { network_policy_amendment: params.proposedNetworkPolicyAmendments[0] } } };
  }
  if (resolution === "accept_session") return { decision: "approved_for_session" };
  if (resolution === "deny") return { decision: "denied" };
  if (resolution === "abort") return { decision: "abort" };
  if (resolution === "accept_once") return { decision: "approved" };
  return buildResponseFromActionPayload(actionPayload, { decision: "abort" });
};

const buildApplyPatchApprovalResponse = (actionPayload: Record<string, unknown>, resolution: string): Record<string, unknown> => {
  if (resolution === "accept_session") return { decision: "approved_for_session" };
  if (resolution === "deny") return { decision: "denied" };
  if (resolution === "abort") return { decision: "abort" };
  if (resolution === "accept_once") return { decision: "approved" };
  return buildResponseFromActionPayload(actionPayload, { decision: "abort" });
};

const buildPermissionsRequestResponse = (payload: StoredServerRequestPayload, actionPayload: Record<string, unknown>, resolution: string): Record<string, unknown> => {
  const params = payload.params as Record<string, unknown>;
  const requested = params.permissions && typeof params.permissions === "object" ? (params.permissions as Record<string, unknown>) : {};
  const base = {
    permissions: resolution === "deny" ? { fileSystem: null, network: null } : requested,
    scope: resolution === "permissions_session" ? "session" : "turn",
    strictAutoReview: null
  };
  return { ...base, ...normalizeResponsePatch(actionPayload) };
};

const buildToolUserInputResponse = (
  payload: StoredServerRequestPayload,
  actionPayload: Record<string, unknown>,
  formValue: Record<string, unknown> | null
): Record<string, unknown> => {
  const questionId = asString(actionPayload.questionId) ?? "";
  const answer = asString(actionPayload.answer) ?? "";
  if (questionId && answer) {
    return { answers: { [questionId]: { answers: [answer] } } };
  }
  const answers = buildToolUserInputAnswers(payload.params, formValue);
  if (Object.keys(answers).length > 0) {
    return { answers };
  }
  return buildResponseFromActionPayload(actionPayload, { answers: {} });
};

const buildMcpElicitationResponse = (
  payload: StoredServerRequestPayload,
  actionPayload: Record<string, unknown>,
  formValue: Record<string, unknown> | null,
  resolution: string
): Record<string, unknown> => {
  const params = payload.params as Record<string, unknown>;
  if (resolution === "deny") return { action: "decline", content: null, _meta: params._meta ?? null };
  if (resolution === "cancel") return { action: "cancel", content: null, _meta: params._meta ?? null };
  if (resolution === "accept_empty") return { action: "accept", content: null, _meta: params._meta ?? null };
  if (resolution === "submit_form") {
    return {
      action: "accept",
      content: buildMcpElicitationFormContent(params.requestedSchema, formValue),
      _meta: params._meta ?? null
    };
  }
  return buildResponseFromActionPayload(actionPayload, { action: "cancel", content: null, _meta: params._meta ?? null });
};

const buildDynamicToolCallResponse = (actionPayload: Record<string, unknown>, resolution: string): Record<string, unknown> => {
  if (resolution === "tool_success_empty") return { success: true, contentItems: [] };
  if (resolution === "tool_failure_empty") return { success: false, contentItems: [] };
  return buildResponseFromActionPayload(actionPayload, { success: false, contentItems: [] });
};

const buildResponseFromActionPayload = (actionPayload: Record<string, unknown>, fallback: Record<string, unknown>): Record<string, unknown> => {
  const response = actionPayload.response;
  return response && typeof response === "object" ? (response as Record<string, unknown>) : fallback;
};

const normalizeResponsePatch = (value: Record<string, unknown>): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if (value.scope === "session" || value.scope === "turn") patch.scope = value.scope;
  if (typeof value.strictAutoReview === "boolean" || value.strictAutoReview === null) patch.strictAutoReview = value.strictAutoReview;
  return patch;
};

const buildToolUserInputFields = (
  questions: Record<string, unknown>[]
): NonNullable<PresentedServerRequest["form"]>["fields"] => {
  const fields: NonNullable<PresentedServerRequest["form"]>["fields"] = [];
  for (const [index, question] of questions.entries()) {
    const questionId = asString(question.id) ?? `question_${index + 1}`;
    const header = asString(question.header) ?? `问题 ${index + 1}`;
    const prompt = asString(question.question) ?? header;
    const isOther = question.isOther === true;
    const isSecret = question.isSecret === true;
    const options = Array.isArray(question.options)
      ? question.options
          .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .map((option) => ({
            label: asString(option.label) ?? "选项",
            value: asString(option.label) ?? "选项"
          }))
      : [];
    if (options.length > 0) {
      fields.push({
        name: questionId,
        label: `${header}｜${prompt}`,
        kind: "select",
        required: true,
        secret: false,
        placeholder: "请选择",
        options
      });
      if (isOther) {
        fields.push({
          name: `${questionId}__other`,
          label: `${header}｜补充输入`,
          kind: isSecret ? "textarea" : "text",
          required: false,
          secret: isSecret,
          placeholder: "需要其他答案时填写"
        });
      }
      continue;
    }
    fields.push({
      name: questionId,
      label: `${header}｜${prompt}`,
      kind: isSecret ? "textarea" : "text",
      required: true,
      secret: isSecret,
      placeholder: prompt
    });
  }
  return fields;
};

const buildToolUserInputAnswers = (
  params: Record<string, unknown>,
  formValue: Record<string, unknown> | null
): Record<string, { answers: string[] }> => {
  if (!formValue) return {};
  const questions = Array.isArray(params.questions)
    ? params.questions
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const questionId = asString(question.id);
    if (!questionId) continue;
    const values = [
      ...normalizeFormAnswerValue(formValue[questionId]),
      ...normalizeFormAnswerValue(formValue[`${questionId}__other`])
    ].map((entry) => entry.trim()).filter(Boolean);
    if (values.length > 0) {
      answers[questionId] = { answers: values };
    }
  }
  return answers;
};

const normalizeFormAnswerValue = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeFormAnswerValue(entry));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return [
      ...normalizeFormAnswerValue(object.value),
      ...normalizeFormAnswerValue(object.values),
      ...normalizeFormAnswerValue(object.option),
      ...normalizeFormAnswerValue(object.option_value),
      ...normalizeFormAnswerValue(object.text),
      ...normalizeFormAnswerValue(object.input_content)
    ];
  }
  return [];
};

const buildMcpElicitationFormContent = (
  schema: unknown,
  formValue: Record<string, unknown> | null
): Record<string, unknown> | null => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return formValue ? { ...formValue } : null;
  const object = schema as Record<string, unknown>;
  const properties = object.properties && typeof object.properties === "object" ? (object.properties as Record<string, unknown>) : {};
  const content: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(properties)) {
    const field = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const resolved = normalizeMcpFieldValue(field, formValue?.[name]);
    if (resolved !== undefined) {
      content[name] = resolved;
    }
  }
  return Object.keys(content).length > 0 ? content : formValue ? { ...formValue } : null;
};

const normalizeMcpFieldValue = (schema: Record<string, unknown>, raw: unknown): unknown => {
  const type = asString(schema.type);
  if (type === "boolean") {
    const text = normalizeFormAnswerValue(raw)[0]?.toLowerCase();
    if (text === "true" || text === "1" || text === "yes" || text === "是") return true;
    if (text === "false" || text === "0" || text === "no" || text === "否") return false;
    return undefined;
  }
  if (type === "number" || type === "integer") {
    const text = normalizeFormAnswerValue(raw)[0];
    if (!text) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === "array") {
    const values = normalizeFormAnswerValue(raw)
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim())
      .filter(Boolean);
    return values.length > 0 ? values : undefined;
  }
  const values = normalizeFormAnswerValue(raw);
  return values.length > 0 ? values[0] : undefined;
};

const parseJsonForServerRequest = (value: string): Record<string, unknown> => {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求 JSON 必须是对象");
  }
  return parsed as Record<string, unknown>;
};

const safeJsonForCard = (value: unknown, maxLength: number): string => {
  try {
    return truncatePlain(JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? String(entry) : entry), 2) ?? "{}", maxLength);
  } catch {
    return truncatePlain(String(value), maxLength);
  }
};

const buttonDescriptor = (label: string, action: string, payload: Record<string, unknown>): PresentedServerRequest["buttons"][number] => ({
  label,
  action,
  payload
});

const fileChangesFromMap = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([path, change]) => {
      const object = change && typeof change === "object" ? (change as Record<string, unknown>) : null;
      if (!object) return null;
      return { path, kind: asString(object.type) ?? "update" };
    })
    .filter((entry): entry is { path: string; kind: string } => Boolean(entry));
  if (entries.length === 0) return null;
  return formatFileChangeSummary(entries.map((entry) => ({ path: entry.path, kind: entry.kind })), "completed");
};

const formatParsedCommands = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const lines = value
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => {
      const type = asString(entry.type);
      const path = asString(entry.path);
      const query = asString(entry.query);
      const name = asString(entry.name);
      if (type === "read") return `读取 ${name ?? path ?? "文件"}`;
      if (type === "list_files") return `查看文件 ${path ?? ""}`.trim();
      if (type === "search") return `搜索 ${query ?? path ?? ""}`.trim();
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
  return lines.length > 0 ? lines.slice(0, 4).join("\n") : null;
};

const mcpElicitationCanAcceptWithoutContent = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return true;
  const object = schema as Record<string, unknown>;
  const properties = object.properties && typeof object.properties === "object" ? Object.keys(object.properties as Record<string, unknown>) : [];
  const required = Array.isArray(object.required) ? object.required.filter((entry): entry is string => typeof entry === "string") : [];
  return properties.length === 0 || required.length === 0;
};

const summarizeMcpSchema = (schema: unknown): string => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "未提供结构化表单。";
  const object = schema as Record<string, unknown>;
  const properties = object.properties && typeof object.properties === "object" ? Object.entries(object.properties as Record<string, unknown>) : [];
  const required = Array.isArray(object.required) ? object.required.filter((entry): entry is string => typeof entry === "string") : [];
  const lines = properties.slice(0, 8).map(([name, entry]) => {
    const field = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const type = asString(field.type) ?? "unknown";
    const title = asString(field.title);
    return `- ${name}${title ? `（${title}）` : ""}：${type}${required.includes(name) ? "，必填" : ""}`;
  });
  return lines.length > 0 ? lines.join("\n") : "表单没有可展示字段。";
};

const buildMcpElicitationFields = (
  schema: unknown
): NonNullable<PresentedServerRequest["form"]>["fields"] => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const object = schema as Record<string, unknown>;
  const properties = object.properties && typeof object.properties === "object" ? Object.entries(object.properties as Record<string, unknown>) : [];
  const required = Array.isArray(object.required) ? object.required.filter((entry): entry is string => typeof entry === "string") : [];
  return properties.slice(0, 12).map(([name, entry]) => buildMcpElicitationField(name, entry, required.includes(name))).filter((item): item is NonNullable<PresentedServerRequest["form"]>["fields"][number] => Boolean(item));
};

const buildMcpElicitationField = (
  name: string,
  entry: unknown,
  required: boolean
): NonNullable<PresentedServerRequest["form"]>["fields"][number] | null => {
  const field = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const title = asString(field.title) ?? name;
  const description = asString(field.description) ?? title;
  const type = asString(field.type);
  if (type === "boolean") {
    return {
      name,
      label: title,
      kind: "boolean",
      required,
      placeholder: description,
      value: typeof field.default === "boolean" ? String(field.default) : undefined
    };
  }
  if (type === "number" || type === "integer") {
    return {
      name,
      label: title,
      kind: "number",
      required,
      placeholder: description,
      value: field.default == null ? undefined : String(field.default)
    };
  }
  if (type === "array") {
    const options = mcpEnumOptions((field.items && typeof field.items === "object") ? field.items as Record<string, unknown> : {});
    return {
      name,
      label: title,
      kind: "multi_select",
      required,
      placeholder: description,
      value: Array.isArray(field.default) ? field.default.join(",") : undefined,
      options
    };
  }
  const options = mcpEnumOptions(field);
  if (options.length > 0) {
    return {
      name,
      label: title,
      kind: "select",
      required,
      placeholder: description,
      value: asString(field.default) ?? undefined,
      options
    };
  }
  return {
    name,
    label: title,
    kind: field.format === "multiline" ? "textarea" : "text",
    required,
    placeholder: description,
    value: asString(field.default) ?? undefined
  };
};

const mcpEnumOptions = (field: Record<string, unknown>): Array<{ label: string; value: string }> => {
  if (Array.isArray(field.oneOf)) {
    return field.oneOf
      .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ({
        label: asString(entry.title) ?? asString(entry.const) ?? "选项",
        value: asString(entry.const) ?? asString(entry.title) ?? "选项"
      }));
  }
  if (Array.isArray(field.enum)) {
    return field.enum
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => ({ label: entry, value: entry }));
  }
  if (field.items && typeof field.items === "object") {
    const items = field.items as Record<string, unknown>;
    if (Array.isArray(items.anyOf)) {
      return items.anyOf
        .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => ({
          label: asString(entry.title) ?? asString(entry.const) ?? "选项",
          value: asString(entry.const) ?? asString(entry.title) ?? "选项"
        }));
    }
    if (Array.isArray(items.enum)) {
      return items.enum
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => ({ label: entry, value: entry }));
    }
  }
  return [];
};

const serverRequestTitleText = (method: string): string =>
  ({
    execCommandApproval: "命令执行审批",
    applyPatchApproval: "补丁应用审批",
    "item/permissions/requestApproval": "额外权限请求",
    "item/tool/requestUserInput": "用户输入请求",
    "mcpServer/elicitation/request": "MCP 请求",
    "item/tool/call": "工具调用请求"
  })[method] ?? method;

const isSupportedDeferredServerRequestMethod = (method: string): boolean =>
  [
    "execCommandApproval",
    "applyPatchApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "item/tool/call"
  ].includes(method);
