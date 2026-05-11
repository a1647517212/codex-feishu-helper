import { execFile } from "node:child_process";
import { hostname, platform } from "node:os";
import { promisify } from "node:util";
import type { BridgeConfig } from "../config.js";
import type { DiagnosticSnapshot, FeishuChatDiagnostic } from "../core/types.js";
import type { CodexClient } from "../codex/client.js";
import type { Repository } from "../db/repo.js";
import type { FeishuChatInfoProvider } from "../feishu/client.js";

const execFileAsync = promisify(execFile);

export class DiagnosticsService {
  private readonly startedAt = Date.now();
  private lastError: string | null = null;
  private lastFeishuMessageAt: string | null = null;
  private lastFeishuMessageId: string | null = null;
  private lastFeishuCardActionAt: string | null = null;
  private lastFeishuCardAction: string | null = null;
  private lastFeishuCardActionId: string | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly repo: Repository,
    private readonly codex: CodexClient,
    private readonly feishu?: FeishuChatInfoProvider
  ) {}

  recordError(error: unknown): void {
    this.lastError = String(error);
  }

  recordFeishuMessage(messageId: string): void {
    this.lastFeishuMessageAt = new Date().toISOString();
    this.lastFeishuMessageId = messageId;
  }

  recordFeishuCardAction(action: string, actionId: string): void {
    this.lastFeishuCardActionAt = new Date().toISOString();
    this.lastFeishuCardAction = action;
    this.lastFeishuCardActionId = actionId;
  }

  async snapshot(): Promise<DiagnosticSnapshot> {
    const devices = this.repo.listBridgeDevices(5);
    const currentDevice = devices.find((device) => device.id === this.config.machine.id) ?? null;
    const trustedSubjects = this.repo.listTrustedFeishuSubjects(5);
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      machineName: this.config.machine.name || hostname(),
      platform: platform(),
      nodeVersion: process.version,
      codexCommand: this.config.codex.command,
      codexConnectionMode: this.config.codex.connectionMode,
      codexConnectionKind: this.codex.connectionKind,
      codexDesktopIpc: this.codex.desktopIpcSnapshot,
      codexAvailable: await this.isCodexAvailable(),
      appServerStatus: this.codex.status,
      feishuConfigured: Boolean(this.config.feishu.appId && this.config.feishu.appSecret && this.config.feishu.defaultChatId),
      feishuMessageTransport: this.config.feishu.messageTransport,
      feishuCardActionTransport: this.config.feishu.cardActionTransport,
      feishuInteractionMode: this.config.feishu.interactionMode,
      feishuDefaultChatId: this.config.feishu.defaultChatId ?? null,
      feishuDefaultChatDiagnostic: await this.defaultChatDiagnostic(),
      feishuTaskContainerMode: this.config.feishu.taskContainerMode,
      databasePath: this.config.storage.databasePath,
      projectsCount: this.repo.count("projects"),
      sessionBindingsCount: this.repo.count("session_bindings"),
      runningTasksCount: this.repo.count("session_bindings", "status = 'running'"),
      pendingOutboxCount: this.repo.count("notification_outbox", "status = 'pending'"),
      pendingApprovalsCount: this.repo.count("pending_approvals", "status = 'pending'"),
      notificationPreferenceCount: this.repo.count("notification_preferences"),
      trustedSubjectsCount: this.repo.count("trusted_feishu_subjects"),
      bridgeDevicesCount: this.repo.count("bridge_devices"),
      currentDevice,
      trustedSubjects,
      lastFeishuMessageAt: this.lastFeishuMessageAt,
      lastFeishuMessageId: this.lastFeishuMessageId,
      lastFeishuCardActionAt: this.lastFeishuCardActionAt,
      lastFeishuCardAction: this.lastFeishuCardAction,
      lastFeishuCardActionId: this.lastFeishuCardActionId,
      lastError: this.lastError
    };
  }

  private async isCodexAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codex.command, ["--version"], {
        windowsHide: true,
        shell: process.platform === "win32",
        timeout: 10000
      });
      return true;
    } catch {
      return false;
    }
  }

  private async defaultChatDiagnostic(): Promise<FeishuChatDiagnostic | null> {
    const chatId = this.config.feishu.defaultChatId;
    if (!chatId || !this.feishu) return null;
    try {
      const chat = await this.feishu.getChatInfo(chatId);
      const fullTopicMode = chat.chatMode === "topic" || chat.groupMessageType === "thread";
      const topicReplySupported = chat.chatMode === "group" || chat.chatMode === "topic" || chat.groupMessageType === "thread";
      return {
        ok: true,
        chatId,
        name: chat.name,
        chatMode: chat.chatMode,
        groupMessageType: chat.groupMessageType,
        topicReplySupported,
        fullTopicMode,
        recommendation: chatRecommendation(chat.chatMode, chat.groupMessageType, this.config.feishu.taskContainerMode),
        requiredScopes: this.config.feishu.taskContainerMode === "dedicated_chat"
          ? ["im:chat:readonly", "im:chat:create", "im:chat:update"]
          : ["im:chat:readonly"],
        error: null
      };
    } catch (error) {
      this.lastError = String(error);
      return {
        ok: false,
        chatId,
        name: null,
        chatMode: null,
        groupMessageType: null,
        topicReplySupported: null,
        fullTopicMode: null,
        recommendation: "无法读取默认群信息。请确认机器人仍在群里，并为应用开通 im:chat:readonly 或 im:chat:read / im:chat 权限。",
        requiredScopes: ["im:chat:readonly", "im:chat:read", "im:chat"],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

const chatRecommendation = (chatMode: string | null, groupMessageType: string | null, containerMode: string): string => {
  if (containerMode === "dedicated_chat") {
    return "当前默认群作为主控群使用；新任务默认创建独立任务会话，不依赖群内话题列表。";
  }
  if (chatMode === "topic" || groupMessageType === "thread") {
    return "当前群已经是话题消息形式；新的任务回复会在话题流中展示。";
  }
  if (chatMode === "group" && (!groupMessageType || groupMessageType === "chat")) {
    return "当前群是普通会话消息形式。桥接已用 reply_in_thread 创建任务话题，但主界面仍会像普通群回复；如需所有任务按话题流展示，需要把群的 group_message_type 改为 thread。";
  }
  if (chatMode === "p2p") {
    return "当前默认会话是单聊，不适合承载多人任务话题；建议配置一个群聊 chat_id。";
  }
  return "未能判断当前群的话题展示形态；请用 feishu-chat doctor 或 /doctor 查看原始群属性。";
};
