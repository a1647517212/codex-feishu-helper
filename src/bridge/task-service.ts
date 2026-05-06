import type { BridgeConfig } from "../config.js";
import { newId } from "../core/ids.js";
import { asString } from "../core/json.js";
import type { FeishuCardAction, FeishuIncomingMessage, PendingApproval, SessionBinding, TaskStatus } from "../core/types.js";
import type { Repository } from "../db/repo.js";
import { commandApprovalDecision, fileApprovalDecision, classifyCommandRisk } from "../domain/approval.js";
import { CardRenderer } from "../domain/cards.js";
import { GitInspector } from "../domain/git.js";
import { ProjectionBuilder } from "../domain/projection.js";
import { SecurityPolicy } from "../domain/security.js";
import type { CodexClient, CodexThreadSummary } from "../codex/client.js";
import type { FeishuSender } from "../feishu/client.js";
import type { Logger } from "../logger.js";

export class TaskService {
  private readonly cards = new CardRenderer();
  private readonly projection: ProjectionBuilder;
  private readonly git = new GitInspector();
  private readonly security: SecurityPolicy;

  constructor(
    private readonly config: BridgeConfig,
    private readonly repo: Repository,
    private readonly codex: CodexClient,
    private readonly feishu: FeishuSender,
    private readonly logger: Logger
  ) {
    this.projection = new ProjectionBuilder(repo);
    this.security = new SecurityPolicy(config);
    this.codex.on("notification", (message) => this.handleCodexNotification(message).catch((error) => this.logger.error("codex notification handling failed", { error: String(error), message })));
    this.codex.on("serverRequest", (message) => this.handleCodexServerRequest(message).catch((error) => this.logger.error("codex server request handling failed", { error: String(error), message })));
  }

  async bootstrapProjectsFromConfig(): Promise<void> {
    for (const project of this.config.projects) {
      this.repo.upsertProject({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        feishuChatId: project.feishuChatId,
        defaultModel: project.defaultModel,
        approvalPolicy: project.approvalPolicy,
        sandboxPolicy: project.sandboxPolicy
      });
    }
    await this.reconcilePersistedBindings();
  }

  async reconcilePersistedBindings(): Promise<void> {
    for (const binding of this.repo.listBindings(this.config.bridge.threadListLimit)) {
      try {
        const detail = await this.codex.readThread(binding.codexThreadId, false);
        const thread = normalizeThreadFromDetail(binding.codexThreadId, detail);
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

  async showConsole(chatId: string, rootMessageId?: string | null): Promise<void> {
    const running = this.repo.count("session_bindings", "status = 'running'");
    const approvals = this.repo.count("pending_approvals", "status = 'pending'");
    const queued = this.repo.count("message_queue", "status = 'queued'");
    const card = this.cards.consoleCard({ running, approvals, queued, completedToday: 0 });
    await this.feishu.sendCard(chatId, card, rootMessageId);
  }

  async listClaimableSessions(chatId: string, rootMessageId?: string | null): Promise<void> {
    const threads = await this.codex.listThreads(this.config.bridge.threadListLimit);
    if (threads.length === 0) {
      await this.feishu.sendText(chatId, "没有发现可接管的本机 Codex 任务。", rootMessageId);
      return;
    }
    await this.feishu.sendCard(
      chatId,
      this.cards.claimableSessionsCard(
        threads.map((thread) => ({
          id: thread.id,
          title: thread.title ?? thread.preview ?? thread.id,
          status: thread.status,
          cwd: thread.cwd
        }))
      ),
      rootMessageId
    );
  }

  async handleMessage(message: FeishuIncomingMessage): Promise<void> {
    this.security.assertFeishuMessageAllowed(message);
    const text = message.text.trim();
    if (text === "/codex" || text === "codex") {
      await this.showConsole(message.chatId, message.rootMessageId ?? message.messageId);
      return;
    }
    if (text === "/doctor" || text === "诊断") {
      await this.feishu.sendText(message.chatId, "诊断请访问 /doctor 或点击控制台诊断按钮。", message.rootMessageId ?? message.messageId);
      return;
    }
    if (text === "/tasks" || text === "接管电脑任务") {
      await this.listClaimableSessions(message.chatId, message.rootMessageId ?? message.messageId);
      return;
    }
    const rootMessageId = message.rootMessageId ?? message.messageId;
    const binding = this.repo.findBindingByTopic(message.chatId, rootMessageId);
    if (binding) {
      await this.continueBindingFromFeishu(binding, message);
      return;
    }
    await this.createNewTaskFromFeishu(message, rootMessageId);
  }

  async handleCardAction(action: FeishuCardAction): Promise<Record<string, unknown>> {
    this.security.assertFeishuAllowed(action.userId, action.chatId || this.config.feishu.defaultChatId || "");
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

  async claimThread(params: {
    thread: CodexThreadSummary;
    chatId: string;
    rootMessageId: string;
    userId: string;
  }): Promise<SessionBinding> {
    const project = this.repo.findProjectForPath(params.thread.cwd);
    const gitSummary = await this.git.summarize(params.thread.cwd);
    const binding = this.repo.createOrUpdateBinding({
      projectId: project?.id ?? null,
      codexThreadId: params.thread.id,
      feishuChatId: params.chatId,
      feishuTopicRootMessageId: params.rootMessageId,
      title: params.thread.title ?? params.thread.preview ?? "Codex 任务",
      cwd: params.thread.cwd,
      gitRepoRoot: gitSummary.repoRoot,
      branchName: gitSummary.branchName,
      status: params.thread.status,
      createdByFeishuUserId: params.userId,
      createdFrom: "codex_app_claimed"
    });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "session.claimed",
      eventPayload: { title: binding.title, cwd: binding.cwd }
    });
    await this.updateTaskCard(binding.id);
    return binding;
  }

  private async createNewTaskFromFeishu(message: FeishuIncomingMessage, rootMessageId: string): Promise<void> {
    const project = this.repo.listProjects()[0] ?? null;
    const thread = await this.codex.startThread({
      cwd: project?.rootPath ?? null,
      model: project?.defaultModel ?? this.config.codex.defaultModel
    });
    const gitSummary = await this.git.summarize(thread.cwd ?? project?.rootPath);
    const title = summarizeTitle(message.text);
    const binding = this.repo.createOrUpdateBinding({
      projectId: project?.id ?? null,
      codexThreadId: thread.id,
      feishuChatId: message.chatId,
      feishuTopicRootMessageId: rootMessageId,
      feishuThreadId: message.threadId,
      title,
      cwd: thread.cwd ?? project?.rootPath ?? null,
      gitRepoRoot: gitSummary.repoRoot,
      branchName: gitSummary.branchName,
      status: "running",
      createdByFeishuUserId: message.userId,
      createdFrom: "feishu_new_task"
    });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.created_from_feishu",
      eventPayload: { text: message.text },
      feishuMessageId: message.messageId
    });
    await this.codex.startTurn(binding.codexThreadId, message.text, {
      cwd: binding.cwd,
      model: project?.defaultModel ?? this.config.codex.defaultModel
    });
    await this.updateTaskCard(binding.id);
  }

  private async continueBindingFromFeishu(binding: SessionBinding, message: FeishuIncomingMessage): Promise<void> {
    if (binding.status === "running" || binding.status === "waiting_for_approval") {
      const queued = this.repo.enqueueMessage({
        sessionBindingId: binding.id,
        feishuMessageId: message.messageId,
        text: message.text,
        createdByFeishuUserId: message.userId
      });
      await this.feishu.sendText(
        message.chatId,
        `已收到，当前任务完成后继续处理。\n\n排队：第 ${queued.position} 条`,
        message.rootMessageId ?? binding.feishuTopicRootMessageId
      );
      await this.updateTaskCard(binding.id);
      return;
    }
    this.repo.updateBindingStatus(binding.id, "running");
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "turn.requested_from_feishu",
      eventPayload: { text: message.text },
      feishuMessageId: message.messageId
    });
    await this.codex.resumeThread(binding.codexThreadId);
    await this.codex.startTurn(binding.codexThreadId, message.text, { cwd: binding.cwd });
    await this.updateTaskCard(binding.id);
  }

  private async dispatchCardAction(action: FeishuCardAction): Promise<Record<string, unknown>> {
    switch (action.action) {
      case "doctor":
        return { ok: true, action: "doctor" };
      case "new_task":
        await this.sendNewTaskDraft(action);
        return { ok: true };
      case "claim_sessions":
        await this.listClaimableSessions(action.chatId || this.config.feishu.defaultChatId || "", action.rootMessageId);
        return { ok: true };
      case "claim_thread":
        await this.claimThreadById(action);
        return { ok: true };
      case "project_list":
        await this.sendProjectList(action);
        return { ok: true };
      case "send_test_notification":
        await this.sendTestNotification(action);
        return { ok: true };
      case "notification_history":
        await this.sendNotificationHistory(action);
        return { ok: true };
      case "task_status":
      case "task_logs":
        await this.sendTaskEvents(action, action.action === "task_logs" ? "任务日志" : "任务进度");
        return { ok: true };
      case "task_diff":
        await this.sendTaskDiff(action);
        return { ok: true };
      case "task_continue":
      case "task_append_hint":
        return { ok: true, text: "请直接在本话题回复要追加的要求。" };
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
      default:
        return { ok: true, ignored: action.action };
    }
  }

  private async sendNewTaskDraft(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.feishu.sendCard(chatId, this.cards.newTaskDraftCard(), action.rootMessageId);
  }

  private async claimThreadById(action: FeishuCardAction): Promise<void> {
    const threadId = String(action.payload.codexThreadId ?? "");
    if (!threadId) throw new Error("缺少 Codex 任务 ID");
    const detail = await this.codex.readThread(threadId, false);
    const thread = normalizeThreadFromDetail(threadId, detail);
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    const rootMessageId = action.rootMessageId || String(action.payload.rootMessageId ?? "") || newId("feishu_topic");
    await this.claimThread({
      thread,
      chatId,
      rootMessageId,
      userId: action.userId
    });
  }

  private async sendProjectList(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.feishu.sendCard(chatId, this.cards.projectListCard(this.repo.listProjects()), action.rootMessageId);
  }

  private async sendTestNotification(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.feishu.sendText(chatId, "测试通知：Bridge 可以向飞书发送消息。", action.rootMessageId);
  }

  private async sendNotificationHistory(action: FeishuCardAction): Promise<void> {
    const chatId = action.chatId || this.config.feishu.defaultChatId || "";
    await this.feishu.sendCard(chatId, this.cards.notificationHistoryCard(this.repo.listRecentOutbox(20)), action.rootMessageId);
  }

  private async sendTaskEvents(action: FeishuCardAction, title: string): Promise<void> {
    const binding = this.requireBinding(action);
    await this.feishu.sendCard(
      action.chatId || binding.feishuChatId,
      this.cards.eventListCard(title, this.repo.listEventsForBinding(binding.id, 20)),
      action.rootMessageId ?? binding.feishuTopicRootMessageId
    );
  }

  private async sendTaskDiff(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    const summary = binding.cwd ? await this.git.diffSummary(binding.cwd) : "当前任务没有可用工作目录。";
    await this.feishu.sendText(action.chatId || binding.feishuChatId, summary, action.rootMessageId ?? binding.feishuTopicRootMessageId);
  }

  private async sendApprovalList(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    await this.feishu.sendCard(
      action.chatId || binding.feishuChatId,
      this.cards.approvalListCard(this.repo.listPendingApprovals(binding.id)),
      action.rootMessageId ?? binding.feishuTopicRootMessageId
    );
  }

  private async sendApprovalDetail(action: FeishuCardAction): Promise<void> {
    const approvalId = String(action.payload.approvalId ?? "");
    const approval = this.repo.findApprovalById(approvalId);
    if (!approval) throw new Error("审批不存在");
    const binding = this.repo.findBindingById(approval.sessionBindingId);
    await this.feishu.sendCard(
      action.chatId || binding?.feishuChatId || this.config.feishu.defaultChatId || "",
      this.cards.approvalDetailCard(approval),
      action.rootMessageId ?? binding?.feishuTopicRootMessageId
    );
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
    await this.updateTaskCard(binding.id);
  }

  private async sendQueueCard(action: FeishuCardAction): Promise<void> {
    const binding = this.requireBinding(action);
    await this.feishu.sendCard(
      action.chatId || binding.feishuChatId,
      this.cards.queueCard(binding.id, this.repo.listQueuedMessages(binding.id)),
      action.rootMessageId ?? binding.feishuTopicRootMessageId
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
    await this.codex.interruptTurn(binding.codexThreadId);
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
    if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
      await this.codex.respondToServerRequest(String(message.id ?? ""), { decision: "cancel" });
      return;
    }
    const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
    const threadId = String(params.threadId ?? "");
    const binding = this.repo.findBindingByThreadId(threadId);
    if (!binding) return;
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
      payload: { card: this.cards.approvalCard(approval) },
      dedupeKey: `approval:${approval.codexThreadId}:${approval.requestId}`
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
      this.repo.updateBindingStatus(binding.id, "running", turnId);
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
      this.repo.updateBindingStatus(binding.id, status, turnId);
      const gitSummary = await this.git.summarize(binding.cwd);
      const event = this.repo.insertEvent({
        sessionBindingId: binding.id,
        codexThreadId: threadId,
        codexTurnId: turnId,
        eventType: status === "completed" ? "task.completed" : `task.${status}`,
        eventPayload: {
          text: status === "completed" ? "任务完成" : `任务状态：${status}`,
          turn,
          changedFiles: gitSummary.changedFiles
        }
      });
      this.repo.insertEvent({
        sessionBindingId: binding.id,
        codexThreadId: threadId,
        codexTurnId: turnId,
        eventType: "git.changed_files",
        eventPayload: { count: gitSummary.changedFiles, statusText: gitSummary.statusText }
      });
      this.repo.enqueueOutbox({
        sessionBindingId: binding.id,
        eventSeq: event.seq,
        notificationType: status === "completed" ? "task_completed" : "task_failed",
        feishuChatId: binding.feishuChatId,
        feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
        payload: { card: this.cards.taskStatusCard(this.projection.buildTaskStatus(binding.id)) },
        dedupeKey: `turn:${threadId}:${turnId}:completed`
      });
      await this.deliverNextQueuedMessage(binding.id);
      await this.updateTaskCard(binding.id);
    }
    if (method === "item/agentMessage/delta") {
      const delta = asString(params.delta);
      if (delta) {
        this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: threadId,
          codexTurnId: asString(params.turnId),
          eventType: "codex.agent_delta",
          eventPayload: { text: truncate(delta, this.config.bridge.maxFeishuTextLength) }
        });
      }
    }
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
    this.repo.updateBindingStatus(binding.id, "running");
    await this.codex.resumeThread(binding.codexThreadId);
    await this.codex.startTurn(binding.codexThreadId, next.text, { cwd: binding.cwd });
  }

  private async updateTaskCard(bindingId: string): Promise<void> {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) return;
    const projection = this.projection.buildTaskStatus(bindingId);
    this.repo.enqueueOutbox({
      sessionBindingId: binding.id,
      notificationType: "task_status",
      feishuChatId: binding.feishuChatId,
      feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
      payload: { card: this.cards.taskStatusCard(projection) },
      dedupeKey: `task-status:${binding.id}:${projection.status}:${projection.updatedAt}:${projection.queuedMessages}:${projection.pendingApprovals}`
    });
  }
}

const summarizeTitle = (text: string): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 40 ? `${compact.slice(0, 40)}...` : compact || "Codex 任务";
};

const normalizeTurnStatus = (status: unknown): TaskStatus => {
  if (status === "completed") return "completed";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  if (status === "failed") return "failed";
  return "idle";
};

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 20)}\n...(已截断)` : text);

const normalizeThreadFromDetail = (threadId: string, detail: Record<string, unknown>): CodexThreadSummary => {
  const rawThread = detail.thread && typeof detail.thread === "object" ? (detail.thread as Record<string, unknown>) : detail;
  return {
    id: String(rawThread.id ?? threadId),
    title: asString(rawThread.name),
    preview: asString(rawThread.preview),
    cwd: asString(rawThread.cwd),
    status: rawThread.status && typeof rawThread.status === "object" && (rawThread.status as { type?: unknown }).type === "active" ? "running" : "idle",
    updatedAt: typeof rawThread.updatedAt === "number" ? rawThread.updatedAt : null,
    raw: rawThread
  };
};
