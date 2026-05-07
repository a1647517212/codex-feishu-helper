import type { BridgeConfig } from "../config.js";
import { newId } from "../core/ids.js";
import { asString } from "../core/json.js";
import type { FeishuCardAction, FeishuIncomingMessage, PendingApproval, Project, SessionBinding, TaskStatus } from "../core/types.js";
import type { Repository } from "../db/repo.js";
import { commandApprovalDecision, fileApprovalDecision, classifyCommandRisk } from "../domain/approval.js";
import { CardRenderer } from "../domain/cards.js";
import { ProjectionBuilder } from "../domain/projection.js";
import { SecurityPolicy } from "../domain/security.js";
import type { CodexClient, CodexThreadSummary } from "../codex/client.js";
import type { FeishuSender } from "../feishu/client.js";
import type { Logger } from "../logger.js";
import { DiagnosticsService } from "./diagnostics.js";

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

export class TaskService {
  private readonly cards: CardRenderer;
  private readonly projection: ProjectionBuilder;
  private readonly security: SecurityPolicy;
  private readonly progressState = new Map<string, { text: string; lastSentLength: number; lastSentAt: number }>();

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

  async bootstrapProjectsFromConfig(): Promise<void> {
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
    await this.reconcilePersistedBindings();
  }

  async reconcilePersistedBindings(): Promise<void> {
    for (const binding of this.repo.listBindings(this.config.bridge.threadListLimit)) {
      if (binding.status === "waiting_for_prompt" || binding.codexThreadId.startsWith("draft_")) {
        continue;
      }
      try {
        const detail = await this.codex.readThread(binding.codexThreadId, false);
        const thread = normalizeThreadFromDetail(binding.codexThreadId, detail);
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

  async showConsole(chatId: string, rootMessageId?: string | null): Promise<void> {
    const running = this.repo.count("session_bindings", "status = 'running'");
    const approvals = this.repo.count("pending_approvals", "status = 'pending'");
    const queued = this.repo.count("message_queue", "status = 'queued'");
    const card = this.cards.consoleCard({ running, approvals, queued, completedToday: 0 });
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
    const text = message.text.trim();
    const incoming = this.repo.beginIncomingMessage({
      messageId: message.messageId,
      chatId: message.chatId,
      userId: message.userId,
      text
    });
    if (incoming.duplicate) {
      this.logger.warn("duplicate feishu message ignored", {
        messageId: message.messageId,
        chatId: message.chatId,
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
    if (await this.tryHandleMessageCommand(message, text)) {
      return;
    }
    const rootMessageId = message.rootMessageId ?? message.messageId;
    const binding =
      (message.threadId ? this.repo.findBindingByFeishuThreadId(message.chatId, message.threadId) : null) ??
      (message.parentMessageId ? this.repo.findBindingByTaskCardMessageId(message.chatId, message.parentMessageId) : null) ??
      this.repo.findBindingByTopic(message.chatId, rootMessageId) ??
      this.repo.findBindingByChatId(message.chatId);
    if (binding) {
      if (binding.status === "waiting_for_prompt") {
        await this.startNewTaskFromPrompt(binding, message);
        return;
      }
      await this.continueBindingFromFeishu(binding, message);
      return;
    }
    await this.createNewTaskFromFeishu(message);
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
    if (!params.skipCardRefresh) {
      await this.updateTaskCard(binding.id);
    }
    return binding;
  }

  private async createNewTaskFromFeishu(message: FeishuIncomingMessage): Promise<void> {
    const project = this.repo.listProjects()[0] ?? null;
    const title = summarizeTitle(message.text);
    const container = await this.ensureTaskContainer({
      chatId: project?.feishuChatId ?? message.chatId,
      title,
      card: project ? this.cards.waitingForPromptCard(project) : this.cards.newTaskDraftCard()
    }, message);
    if (container.kind === "dedicated_chat") {
      await this.feishu.sendText(container.chatId, `任务：${title}\n\n后续补充、/status、/logs、/archive 都在这个会话里发送。`);
      await this.repo.beginIncomingMessage({
        messageId: `system:${container.chatId}:${message.messageId}`,
        chatId: container.chatId,
        userId: message.userId,
        text: message.text
      });
    }
    const thread = await this.codex.startThread({
      cwd: project?.rootPath ?? null,
      model: projectModel(project, this.config),
      reasoningEffort: projectReasoningEffort(project, this.config)
    });
    const binding = this.repo.createOrUpdateBinding({
      projectId: project?.id ?? null,
      codexThreadId: thread.id,
      feishuChatId: container.chatId,
      feishuTopicRootMessageId: container.rootMessageId,
      feishuThreadId: container.threadId,
      feishuTaskCardMessageId: container.cardMessageId,
      feishuContainerKind: container.kind,
      feishuControlChatId: container.controlChatId,
      title,
      cwd: thread.cwd ?? project?.rootPath ?? null,
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
    const turn = await this.codex.startTurn(binding.codexThreadId, message.text, {
      cwd: binding.cwd,
      model: projectModel(project, this.config),
      reasoningEffort: projectReasoningEffort(project, this.config)
    });
    this.repo.updateBindingStatus(binding.id, "running", extractTurnId(turn));
    await this.updateTaskTitle(binding.id, "running", title);
    await this.updateTaskCard(binding.id);
  }

  private async startNewTaskFromPrompt(binding: SessionBinding, message: FeishuIncomingMessage): Promise<void> {
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const thread = await this.codex.startThread({
      cwd: project?.rootPath ?? binding.cwd ?? null,
      model: projectModel(project, this.config),
      reasoningEffort: projectReasoningEffort(project, this.config)
    });
    const title = summarizeTitle(message.text);
    const turn = await this.codex.startTurn(thread.id, message.text, {
      cwd: thread.cwd ?? project?.rootPath ?? binding.cwd ?? null,
      model: projectModel(project, this.config),
      reasoningEffort: projectReasoningEffort(project, this.config)
    });
    this.repo.activateDraftBinding({
      bindingId: binding.id,
      codexThreadId: thread.id,
      projectId: project?.id ?? null,
      title,
      cwd: thread.cwd ?? project?.rootPath ?? binding.cwd ?? null,
      status: "running",
      lastTurnId: extractTurnId(turn)
    });
    this.repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: thread.id,
      eventType: "task.created_from_feishu",
      eventPayload: { text: message.text, fromDraft: true },
      feishuMessageId: message.messageId
    });
    await this.updateTaskTitle(binding.id, "running", title);
    await this.updateTaskCard(binding.id);
  }

  private async continueBindingFromFeishu(binding: SessionBinding, message: FeishuIncomingMessage): Promise<void> {
    if (binding.status === "running") {
      try {
        await this.codex.steerTurn(binding.codexThreadId, message.text);
        this.repo.insertEvent({
          sessionBindingId: binding.id,
          codexThreadId: binding.codexThreadId,
          eventType: "turn.steer_requested_from_feishu",
          eventPayload: { text: message.text },
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
        text: message.text,
        createdByFeishuUserId: message.userId
      });
      await this.sendTextToTarget(
        this.targetForBinding(binding, message.chatId),
        `已收到，当前任务完成后继续处理。\n\n排队：第 ${queued.position} 条`
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
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    await this.codex.startTurn(binding.codexThreadId, message.text, {
      cwd: binding.cwd,
      model: projectModel(project, this.config),
      reasoningEffort: projectReasoningEffort(project, this.config)
    });
  }

  private async dispatchCardAction(action: FeishuCardAction): Promise<Record<string, unknown>> {
    switch (action.action) {
      case "doctor":
        await this.sendDoctorCard(action.chatId || this.config.feishu.defaultChatId || "", action.rootMessageId);
        return { ok: true, action: "doctor" };
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
      case "project_running":
        await this.listClaimableSessions(
          action.chatId || this.config.feishu.defaultChatId || "",
          action.rootMessageId,
          asString(action.payload.projectId)
        );
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
      case "task_status":
      case "task_logs":
        await this.sendTaskEvents(action, action.action === "task_logs" ? "任务日志" : "任务进度");
        return { ok: true };
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
    return null;
  }

  private async sendNewTaskDraft(action: FeishuCardAction): Promise<void> {
    const projectId = asString(action.payload.projectId);
    const project = projectId ? this.repo.getProject(projectId) : this.repo.listProjects()[0] ?? null;
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

  private async claimThreadById(action: FeishuCardAction): Promise<Record<string, unknown>> {
    const threadId = String(action.payload.codexThreadId ?? "");
    if (!threadId) throw new Error("缺少 Codex 任务 ID");
    const existing = this.repo.findBindingByThreadId(threadId);
    if (existing) {
      await this.feishu.sendCard(
        action.chatId || existing.feishuChatId,
        this.cards.taskStatusCard(this.projection.buildTaskStatus(existing.id)),
        action.rootMessageId
      );
      return { ok: true, text: "这个任务已经可以在飞书继续，已回显当前状态。" };
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
    const projects = this.repo.listProjects();
    await this.feishu.sendCard(chatId, this.cards.projectListCard(projects), action.rootMessageId);
    for (const project of projects.slice(0, 3)) {
      await this.feishu.sendCard(chatId, this.cards.projectCard(this.buildProjectCardInput(project)), action.rootMessageId);
    }
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
    await this.sendCardToTarget(this.targetForBinding(binding, action.chatId), this.cards.taskStatusCard(this.projection.buildTaskStatus(binding.id)));
    return {
      ok: true,
      text: binding.feishuContainerKind === "dedicated_chat"
        ? "已在这个任务独立会话里回发最新状态，可直接在那个会话继续。"
        : "已在这个任务绑定的话题里回发最新状态，可直接在那条回复链继续。"
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

  private async sendTaskEvents(action: FeishuCardAction, title: string): Promise<void> {
    const binding = this.requireBinding(action);
    await this.sendCardToTarget(
      this.targetForBinding(binding, action.chatId),
      this.cards.eventListCard(title, this.repo.listEventsForBinding(binding.id, 20))
    );
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

  /**
   * Returns the canonical Feishu reply target for a bound task so later status,
   * approval and queue messages stay inside the same reply thread.
   */
  private targetForBinding(binding: SessionBinding, chatId?: string | null): FeishuReplyTarget {
    if (binding.feishuContainerKind === "dedicated_chat") {
      return {
        chatId: binding.feishuChatId,
        rootMessageId: null,
        threadId: null
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
    return this.targetForAction(action);
  }

  private async sendTextToTarget(target: FeishuReplyTarget, text: string): Promise<void> {
    if (target.threadId) {
      await this.feishu.replyTextInThread(target.rootMessageId ?? target.threadId, text);
      return;
    }
    await this.feishu.sendText(target.chatId, text, target.rootMessageId);
  }

  private async sendCardToTarget(target: FeishuReplyTarget, card: ReturnType<CardRenderer["taskStatusCard"]>): Promise<void> {
    if (target.threadId) {
      await this.feishu.replyCardInThread(target.rootMessageId ?? target.threadId, card);
      return;
    }
    await this.feishu.sendCard(target.chatId, card, target.rootMessageId);
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
      feishuThreadId: binding.feishuThreadId,
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
      const detail = await this.codex.readThread(threadId, true).catch(() => null);
      const report =
        status === "completed"
          ? mergeThreadReports(
              detail ? extractThreadReport(detail) : null,
              extractTurnReport(turn),
              extractEventReport(this.repo.listEventsForBinding(binding.id, 200), turnId)
            ) ?? emptyThreadReport()
          : null;
      const finalResult = report?.finalResult ?? null;
      const reasoningSummary = report?.reasoningSummary ?? null;
      const summaryText =
        status === "completed"
          ? finalResult
            ? truncate(singleLine(finalResult), 180)
            : "已完成。需要细节时发送 /logs 查看任务记录。"
          : `任务状态：${taskStatusText(status)}。发送 /logs 查看任务记录。`;
      const event = this.repo.insertEvent({
        sessionBindingId: binding.id,
        codexThreadId: threadId,
        codexTurnId: turnId,
        eventType: status === "completed" ? "task.completed" : `task.${status}`,
        eventPayload: {
          text: summaryText,
          reasoningSummary,
          finalResult,
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
        this.repo.enqueueOutbox({
          sessionBindingId: binding.id,
          eventSeq: event.seq,
          notificationType: "task_completed",
          feishuChatId: binding.feishuChatId,
          feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
          feishuThreadId: binding.feishuThreadId,
          payload: { text: formatThreadReport(report) },
          dedupeKey: `turn:${threadId}:${turnId}:result`
        });
      }
      await this.deliverNextQueuedMessage(binding.id);
    }
    if (method === "item/completed") {
      const item = params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : {};
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
    if (!delta.trim() || looksLikeCommandLine(delta.trim())) return;
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
    this.repo.enqueueOutbox({
      sessionBindingId: binding.id,
      eventSeq,
      notificationType: "task_progress",
      feishuChatId: binding.feishuChatId,
      feishuTopicRootMessageId: binding.feishuTopicRootMessageId,
      feishuThreadId: binding.feishuThreadId,
      payload: { text: `进行中：${label}\n\n${visible}` },
      dedupeKey: `progress:${binding.id}:${turnId ?? "no-turn"}:${itemId ?? label}:${label}:${eventSeq}`
    });
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
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    await this.codex.startTurn(binding.codexThreadId, next.text, {
      cwd: binding.cwd,
      model: projectModel(project, this.config),
      reasoningEffort: projectReasoningEffort(project, this.config)
    });
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
      return;
    }
    await this.updateTopicTitle(bindingId, buildTopicTitle(title, status));
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
      completedCount
    };
  }
}

const summarizeTitle = (text: string): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 40 ? `${compact.slice(0, 40)}...` : compact || "Codex 任务";
};

const buildTaskChatName = (config: BridgeConfig, key: string, title: string, status: TaskStatus = "running"): string => {
  const prefix = config.feishu.taskChatNamePrefix || "C";
  const index = key.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase() || "TASK";
  const statusPrefix = taskStatusPrefix(status);
  return truncatePlain(`${statusPrefix}${prefix}-${index} ${title}`, 60);
};

const buildTopicTitle = (title: string, status: TaskStatus): string =>
  status === "running" ? title : `${taskStatusPrefix(status)}${title}`;

const taskStatusPrefix = (status: TaskStatus): string => {
  if (status === "completed" || status === "archived") return "[完成] ";
  if (status === "failed") return "[失败] ";
  if (status === "interrupted") return "[中断] ";
  if (status === "waiting_for_approval") return "[确认] ";
  if (status === "running") return "[运行中] ";
  return "";
};

const normalizeTurnStatus = (status: unknown): TaskStatus => {
  if (status === "completed") return "completed";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  if (status === "failed") return "failed";
  return "idle";
};

const extractTurnId = (result: Record<string, unknown>): string | null => {
  const turn = result.turn;
  if (!turn || typeof turn !== "object") return null;
  const id = (turn as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
};

const projectModel = (project: Project | null, config: BridgeConfig): string =>
  project?.defaultModel ?? config.codex.defaultModel;

const projectReasoningEffort = (project: Project | null, config: BridgeConfig): string =>
  project?.defaultReasoningEffort ?? config.codex.defaultReasoningEffort;

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

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 20)}\n...(已截断)` : text);

const truncatePlain = (text: string, max: number): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
};

const isTerminalStatus = (status: TaskStatus): boolean =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "archived";

const isCommandText = (text: string): boolean =>
  text.startsWith("/") ||
  ["项目列表", "查看进度", "查看日志", "查看队列", "通知历史", "发送测试通知", "未归类任务"].includes(text);

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
    "查看日志": "logs",
    logs: "logs",
    log: "logs",
    "查看队列": "queue",
    queue: "queue",
    claim: "claim",
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
  const finalResult = firstSanitized(finalMessages);
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
  const finalResult = firstSanitized(finalMessages);
  const reasoningSummary = firstSanitized(reasoning) ?? firstSanitized(plans);
  if (!finalResult && !reasoningSummary) return null;
  return { reasoningSummary, finalResult };
};

const extractEventReport = (events: Array<{ codexTurnId: string | null; eventType: string; eventPayload: Record<string, unknown>; seq: number }>, turnId: string): ThreadReport | null => {
  const currentTurnEvents = events.filter((event) => !event.codexTurnId || event.codexTurnId === turnId);
  const completedAgent = latestSanitizedEventText(currentTurnEvents, "codex.agent_message");
  const agentDelta = firstSanitized([joinDeltaEvents(currentTurnEvents, "codex.agent_delta")].filter(Boolean) as string[]);
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

const formatThreadReport = (report: ThreadReport): string => {
  const lines = [
    "处理完成",
    report.reasoningSummary ? `处理摘要：\n${report.reasoningSummary}` : "处理摘要：未提取到可展示的步骤摘要。",
    report.finalResult ? `最终结论：\n${report.finalResult}` : "最终结论：未提取到最终回复文本，请发送 /logs 查看本地任务记录。"
  ];
  return lines.join("\n\n");
};

const firstSanitized = (items: string[]): string | null => {
  for (const item of items) {
    const sanitized = sanitizeAssistantSummary(item);
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
  eventType: string
): string | null => {
  const matched = [...events]
    .filter((event) => event.eventType === eventType)
    .sort((left, right) => right.seq - left.seq);
  for (const event of matched) {
    const text = asString(event.eventPayload.text);
    if (!text) continue;
    const sanitized = sanitizeAssistantSummary(text);
    if (sanitized && sanitized !== "有输出，原始内容已保留在本地记录中。") return sanitized;
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
  const withoutCodeBlocks = text.replace(/```[\s\S]*?```/g, "[代码块已省略]");
  const compact = withoutCodeBlocks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !looksLikeCommandLine(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(compact || "有输出，原始内容已保留在本地记录中。", maxLength);
};

const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const looksLikeCommandLine = (line: string): boolean =>
  /(?:powershell|pwsh|cmd\.exe|node|npm|pnpm|yarn|python|git|rg|Get-Content|Get-ChildItem|Select-String)/i.test(line) ||
  line.length > 180;

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

const inferProjectName = (cwd: string, fallback: string): string => {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const leaf = segments[segments.length - 1];
  return leaf && leaf.trim().length > 0 ? leaf.trim() : fallback;
};
