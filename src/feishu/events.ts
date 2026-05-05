import type { BridgeConfig } from "../config.js";
import { asString } from "../core/json.js";
import type { FeishuCardAction, FeishuIncomingMessage } from "../core/types.js";

export type ParsedFeishuPayload =
  | { type: "url_verification"; challenge: string }
  | { type: "message"; message: FeishuIncomingMessage }
  | { type: "card_action"; action: FeishuCardAction }
  | { type: "ignored"; reason: string };

export class FeishuEventParser {
  constructor(private readonly config: BridgeConfig) {}

  parse(payload: Record<string, unknown>): ParsedFeishuPayload {
    if (payload.type === "url_verification") {
      return { type: "url_verification", challenge: String(payload.challenge ?? "") };
    }
    if (this.config.feishu.verificationToken && payload.token && payload.token !== this.config.feishu.verificationToken) {
      return { type: "ignored", reason: "verification token mismatch" };
    }
    if (payload.type === "card.action.trigger" || payload.header) {
      const parsed = this.parseCardAction(payload);
      if (parsed) return { type: "card_action", action: parsed };
    }
    const event = payload.event && typeof payload.event === "object" ? (payload.event as Record<string, unknown>) : null;
    if (!event) return { type: "ignored", reason: "no event object" };
    const eventType = String(payload.header && typeof payload.header === "object" ? (payload.header as Record<string, unknown>).event_type ?? "" : "");
    if (!eventType.includes("message")) return { type: "ignored", reason: `unsupported event: ${eventType}` };
    const message = event.message && typeof event.message === "object" ? (event.message as Record<string, unknown>) : null;
    const sender = event.sender && typeof event.sender === "object" ? (event.sender as Record<string, unknown>) : null;
    if (!message || !sender) return { type: "ignored", reason: "missing message or sender" };
    const text = extractText(message);
    if (!text.trim()) return { type: "ignored", reason: "empty text" };
    const senderId = sender.sender_id && typeof sender.sender_id === "object" ? (sender.sender_id as Record<string, unknown>) : {};
    return {
      type: "message",
      message: {
        messageId: String(message.message_id ?? ""),
        chatId: String(message.chat_id ?? ""),
        rootMessageId: asString(message.root_id) ?? asString(message.parent_id),
        threadId: asString(message.thread_id),
        userId: String(senderId.open_id ?? senderId.user_id ?? senderId.union_id ?? ""),
        text,
        createTime: asString(message.create_time) ?? undefined
      }
    };
  }

  private parseCardAction(payload: Record<string, unknown>): FeishuCardAction | null {
    const action =
      payload.action && typeof payload.action === "object" ? (payload.action as Record<string, unknown>) : null;
    const event = payload.event && typeof payload.event === "object" ? (payload.event as Record<string, unknown>) : null;
    const container = action ?? event;
    if (!container) return null;
    const value = container.value && typeof container.value === "object" ? (container.value as Record<string, unknown>) : {};
    const user = payload.user && typeof payload.user === "object" ? (payload.user as Record<string, unknown>) : {};
    const operator = event?.operator && typeof event.operator === "object" ? (event.operator as Record<string, unknown>) : {};
    const openId = asString(user.open_id) ?? asString(operator.open_id) ?? asString(operator.user_id) ?? "";
    const context = payload.context && typeof payload.context === "object" ? (payload.context as Record<string, unknown>) : {};
    const openMessageId = asString(context.open_message_id) ?? asString(event?.open_message_id);
    return {
      actionId: String(value.actionId ?? value.action_id ?? openMessageId ?? `act_${Date.now()}`),
      action: String(value.action ?? container.tag ?? ""),
      userId: openId,
      chatId: String(value.chatId ?? value.chat_id ?? context.open_chat_id ?? ""),
      rootMessageId: asString(value.rootMessageId) ?? openMessageId,
      payload: value
    };
  }
}

const extractText = (message: Record<string, unknown>): string => {
  const content = asString(message.content);
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return String(parsed.text ?? parsed.content ?? "");
  } catch {
    return content;
  }
};
