import * as Lark from "@larksuiteoapi/node-sdk";
import type { BridgeConfig } from "../config.js";
import type { DiagnosticsService } from "../bridge/diagnostics.js";
import type { TaskService } from "../bridge/task-service.js";
import type { FeishuCardAction } from "../core/types.js";
import type { Logger } from "../logger.js";
import { asString } from "../core/json.js";

export class FeishuLongConnectionServer {
  private wsClient: Lark.WSClient | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly taskService: TaskService,
    private readonly diagnostics: DiagnosticsService,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    if (this.wsClient) return;
    if (
      this.config.feishu.messageTransport !== "long_connection" &&
      this.config.feishu.cardActionTransport !== "long_connection"
    ) {
      return;
    }
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error("Feishu appId/appSecret are required for long connection transport.");
    }
    const dispatcher = new Lark.EventDispatcher({
      verificationToken: this.config.feishu.verificationToken,
      encryptKey: this.config.feishu.encryptKey,
      loggerLevel: Lark.LoggerLevel.warn
    });
    if (this.config.feishu.messageTransport === "long_connection") {
      dispatcher.register({
        "im.message.receive_v1": async (data) => {
          await this.handleMessageEvent(data as Record<string, unknown>);
        }
      });
    }
    if (this.config.feishu.cardActionTransport === "long_connection") {
      dispatcher.register({
        "card.action.trigger": async (data: unknown) => this.handleCardActionEvent(data as Record<string, unknown>)
      });
    }
    this.wsClient = new Lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      onReady: () => this.logger.info("feishu long connection ready"),
      onError: (error) => this.logger.error("feishu long connection failed", { error: String(error) }),
      onReconnecting: () => this.logger.warn("feishu long connection reconnecting"),
      onReconnected: () => this.logger.info("feishu long connection reconnected")
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wsClient = null;
  }

  private async handleMessageEvent(data: Record<string, unknown>): Promise<void> {
    const sender = getObject(data.sender);
    const senderId = getObject(sender.sender_id);
    const message = getObject(data.message);
    const text = extractText(asString(message.content));
    if (!text.trim()) return;
    this.logger.info("feishu message received", {
      messageId: asString(message.message_id),
      chatId: asString(message.chat_id),
      userId: asString(senderId.open_id) ?? asString(senderId.user_id) ?? asString(senderId.union_id),
      textLength: text.length
    });
    this.diagnostics.recordFeishuMessage(String(message.message_id ?? ""));
    await this.taskService.handleMessage({
      messageId: String(message.message_id ?? ""),
      chatId: String(message.chat_id ?? ""),
      rootMessageId: asString(message.root_id) ?? asString(message.parent_id),
      threadId: asString(message.thread_id),
      userId: String(senderId.open_id ?? senderId.user_id ?? senderId.union_id ?? ""),
      text,
      createTime: asString(message.create_time) ?? undefined
    });
  }

  private async handleCardActionEvent(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = normalizeCardAction(data);
    if (!action) {
      this.logger.warn("feishu card action ignored", { reason: "missing action, operator, or chat context" });
      return {
        toast: {
          type: "error",
          content: "卡片动作缺少必要上下文"
        }
      };
    }
    this.logger.info("feishu card action received", {
      action: action.action,
      actionId: action.actionId,
      chatId: action.chatId,
      rootMessageId: action.rootMessageId
    });
    this.diagnostics.recordFeishuCardAction(action.action, action.actionId);
    void this.taskService.processCardActionDeferred(action);
    return {
      toast: {
        type: "success",
        content: "已收到，正在处理"
      }
    };
  }
}

const getObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeCardAction = (data: Record<string, unknown>): FeishuCardAction | null => {
  const normalized = Lark.normalizeCardAction(data as Lark.RawCardActionEvent);
  if (normalized) {
    const value = getObject(normalized.action.value);
    const actionId = asString(value.actionId) ?? asString(value.action_id) ?? cardActionFallbackId(normalized);
    const action = asString(value.action) ?? asString(normalized.action.name) ?? normalized.action.tag;
    return {
      actionId,
      action,
      userId: normalized.operator.openId,
      chatId: normalized.chatId,
      rootMessageId: asString(value.rootMessageId) ?? normalized.messageId,
      payload: value
    };
  }
  return normalizeLegacyCardAction(data);
};

const normalizeLegacyCardAction = (data: Record<string, unknown>): FeishuCardAction | null => {
  const event = getObject(data.event);
  const context = getObject(data.context ?? event.context);
  const operator = getObject(data.operator ?? event.operator);
  const rawAction = getObject(data.action ?? event.action);
  const value = getObject(rawAction.value);
  const openMessageId = asString(context.open_message_id) ?? asString(event.open_message_id);
  const chatId = asString(value.chatId) ?? asString(value.chat_id) ?? asString(context.open_chat_id) ?? asString(event.open_chat_id);
  const userId = asString(operator.open_id) ?? asString(operator.user_id) ?? asString(operator.union_id);
  const action = asString(value.action) ?? asString(rawAction.name) ?? asString(rawAction.tag);
  if (!chatId || !userId || !action) return null;
  return {
    actionId: asString(value.actionId) ?? asString(value.action_id) ?? openMessageId ?? `act_${Date.now()}`,
    action,
    userId,
    chatId,
    rootMessageId: asString(value.rootMessageId) ?? openMessageId,
    payload: value
  };
};

const cardActionFallbackId = (event: Lark.CardActionEvent): string => {
  const value = JSON.stringify(event.action.value ?? {});
  return `card_${event.messageId}_${event.operator.openId}_${event.action.tag}_${value}`;
};

const extractText = (content: string | null): string => {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return String(parsed.text ?? parsed.content ?? "");
  } catch {
    return content;
  }
};
