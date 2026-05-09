import type { BridgeConfig } from "../config.js";
import type { NotificationLevel, NotificationOutboxItem, Project, SessionBinding } from "../core/types.js";
import type { Repository } from "../db/repo.js";
import type { FeishuSender } from "../feishu/client.js";
import type { Logger } from "../logger.js";

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly repo: Repository,
    private readonly feishu: FeishuSender,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((error) => this.logger.error("outbox flush failed", { error: String(error) }));
    }, 5000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<void> {
    const items = this.repo.listDueOutbox(20);
    for (const item of items) {
      await this.deliver(item);
    }
  }

  private async deliver(item: NotificationOutboxItem): Promise<void> {
    try {
      if (!this.shouldDeliver(item)) {
        this.repo.updateOutbox(item.id, "sent", item.attempts + 1, null, null);
        return;
      }
      const card = item.payload.card as Record<string, unknown> | undefined;
      const cards = Array.isArray(item.payload.cards)
        ? item.payload.cards.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
        : [];
      const text = typeof item.payload.text === "string" ? item.payload.text : null;
      const binding = item.sessionBindingId ? this.repo.findBindingById(item.sessionBindingId) : null;
      const target = resolveDeliveryTarget(item, binding);
      this.logger.info("outbox delivery target resolved", {
        id: item.id,
        notificationType: item.notificationType,
        sessionBindingId: item.sessionBindingId,
        chatId: target.chatId,
        rootMessageId: target.rootMessageId,
        threadId: target.threadId,
        mode: deliveryTargetMode(target)
      });
      if (card) {
        const sent = await this.sendCard(target, card);
        if (
          item.notificationType === "task_status" &&
          item.sessionBindingId &&
          binding &&
          !binding.feishuTaskCardMessageId &&
          sent.messageId
        ) {
          this.repo.updateBindingTaskCardMessageId(item.sessionBindingId, sent.messageId);
        }
      }
      if (cards.length > 0) {
        for (const entry of cards) {
          await this.sendCard(target, entry);
        }
      }
      if (text) {
        const chunks = splitFeishuText(text, this.config.bridge.maxFeishuTextLength);
        for (const chunk of chunks) {
          if (target.threadId) {
            await this.feishu.replyTextInThread(target.rootMessageId ?? target.threadId, chunk);
          } else {
            await this.feishu.sendText(target.chatId, chunk, target.rootMessageId);
          }
        }
      }
      if (cards.length === 0 && !card && !text) {
        throw new Error("outbox payload must include card or text");
      }
      this.repo.updateOutbox(item.id, "sent", item.attempts + 1, null, null);
    } catch (error) {
      const attempts = item.attempts + 1;
      const dead = attempts >= this.config.bridge.outboxMaxAttempts;
      const delayMs = this.config.bridge.outboxRetryBaseMs * Math.min(60, 2 ** Math.min(attempts, 6));
      this.repo.updateOutbox(
        item.id,
        dead ? "dead" : "pending",
        attempts,
        String(error),
        dead ? null : new Date(Date.now() + delayMs).toISOString()
      );
      this.logger.warn("outbox delivery failed", { id: item.id, attempts, error: String(error) });
    }
  }

  private async sendCard(target: FeishuDeliveryTarget, card: Record<string, unknown>) {
    if (target.threadId) {
      return this.feishu.replyCardInThread(target.rootMessageId ?? target.threadId, card);
    }
    return this.feishu.sendCard(target.chatId, card, target.rootMessageId);
  }

  private shouldDeliver(item: NotificationOutboxItem): boolean {
    if (item.notificationType === "console" || item.notificationType === "task_status") return true;
    if (item.notificationType === "approval_required") return true;
    const binding = item.sessionBindingId ? this.repo.findBindingById(item.sessionBindingId) : null;
    const project = binding?.projectId ? this.repo.getProject(binding.projectId) : null;
    const level = this.resolveNotificationLevel(binding, project);
    const severity = notificationSeverity(item.notificationType);
    if (level === "all") return true;
    if (level === "important") return severity === "important" || severity === "error";
    if (level === "errors") return severity === "error";
    return false;
  }

  private resolveNotificationLevel(binding: SessionBinding | null, project: Project | null): NotificationLevel {
    if (binding) {
      const sessionPreference = this.repo.getNotificationPreference("session", binding.id, null)?.level;
      if (sessionPreference) return sessionPreference;
    }
    if (project) {
      const projectPreference = this.repo.getNotificationPreference("project", project.id, null)?.level;
      if (projectPreference) return projectPreference;
      if (project.notificationPolicy === "all" || project.notificationPolicy === "important" || project.notificationPolicy === "errors" || project.notificationPolicy === "muted") {
        return project.notificationPolicy;
      }
    }
    return this.repo.getNotificationPreference("global", "bridge", null)?.level ?? "important";
  }
}

const notificationSeverity = (type: NotificationOutboxItem["notificationType"]): "info" | "important" | "error" => {
  if (type === "task_failed" || type === "task_interrupted" || type === "bridge_unavailable") return "error";
  if (type === "task_completed" || type === "project_unclassified" || type === "diagnostic") return "important";
  return "info";
};

type FeishuDeliveryTarget = {
  chatId: string;
  rootMessageId: string | null;
  threadId: string | null;
};

const resolveDeliveryTarget = (
  item: NotificationOutboxItem,
  binding: SessionBinding | null
): FeishuDeliveryTarget => {
  const chatId = binding?.feishuChatId ?? item.feishuChatId;
  if (binding?.feishuContainerKind === "dedicated_chat") {
    return {
      chatId,
      rootMessageId:
        firstRealFeishuMessageId(
          binding.feishuTaskCardMessageId,
          item.feishuTopicRootMessageId,
          binding.feishuTopicRootMessageId
        ) ?? null,
      threadId: firstRealFeishuThreadId(item.feishuThreadId, binding.feishuThreadId) ?? null
    };
  }
  return {
    chatId,
    rootMessageId: item.feishuTopicRootMessageId,
    threadId: item.feishuThreadId
  };
};

const firstRealFeishuMessageId = (...values: Array<string | null | undefined>): string | null => {
  for (const value of values) {
    if (value && isRealFeishuMessageId(value)) return value;
  }
  return null;
};

const firstRealFeishuThreadId = (...values: Array<string | null | undefined>): string | null => {
  for (const value of values) {
    if (value && isRealFeishuThreadId(value)) return value;
  }
  return null;
};

const isRealFeishuMessageId = (value: string): boolean => /^om_[A-Za-z0-9_-]+$/.test(value);

const isRealFeishuThreadId = (value: string): boolean => /^omt_[A-Za-z0-9_-]+$/.test(value);

const deliveryTargetMode = (target: FeishuDeliveryTarget): "thread_reply" | "message_reply" | "top_level" => {
  if (target.threadId) return "thread_reply";
  if (target.rootMessageId) return "message_reply";
  return "top_level";
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
    const boundary = bestBoundary(remaining, bodyLimit);
    chunks.push(remaining.slice(0, boundary).trimEnd());
    offset += boundary;
    while (text[offset] === "\n") offset += 1;
  }
  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
};

const bestBoundary = (text: string, limit: number): number => {
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
