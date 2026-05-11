import type { BridgeConfig } from "../config.js";
import { asString } from "../core/json.js";
import type { FeishuCardAction, FeishuIncomingMessage } from "../core/types.js";
import { parseFeishuMessageContent } from "./message-content.js";

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
    const { text, attachments } = parseFeishuMessageContent(message);
    if (!text.trim() && attachments.length === 0) return { type: "ignored", reason: "empty text" };
    const senderId = sender.sender_id && typeof sender.sender_id === "object" ? (sender.sender_id as Record<string, unknown>) : {};
    return {
      type: "message",
      message: {
        messageId: String(message.message_id ?? ""),
        chatId: String(message.chat_id ?? ""),
        rootMessageId: asString(message.root_id) ?? asString(message.parent_id),
        parentMessageId: asString(message.parent_id),
        threadId: asString(message.thread_id),
        userId: String(senderId.open_id ?? senderId.user_id ?? senderId.union_id ?? ""),
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        createTime: asString(message.create_time) ?? undefined
      }
    };
  }

  private parseCardAction(payload: Record<string, unknown>): FeishuCardAction | null {
    const event = payload.event && typeof payload.event === "object" ? (payload.event as Record<string, unknown>) : null;
    const action =
      payload.action && typeof payload.action === "object"
        ? (payload.action as Record<string, unknown>)
        : event?.action && typeof event.action === "object"
          ? (event.action as Record<string, unknown>)
          : null;
    if (!action) return null;
    const value = action.value && typeof action.value === "object" ? (action.value as Record<string, unknown>) : {};
    const user = payload.user && typeof payload.user === "object" ? (payload.user as Record<string, unknown>) : {};
    const operator = event?.operator && typeof event.operator === "object" ? (event.operator as Record<string, unknown>) : {};
    const openId = asString(user.open_id) ?? asString(operator.open_id) ?? asString(operator.user_id) ?? "";
    const context =
      payload.context && typeof payload.context === "object"
        ? (payload.context as Record<string, unknown>)
        : event?.context && typeof event.context === "object"
          ? (event.context as Record<string, unknown>)
          : {};
    const openMessageId = asString(context.open_message_id) ?? asString(event?.open_message_id);
    return {
      actionId: String(value.actionId ?? value.action_id ?? openMessageId ?? `act_${Date.now()}`),
      action: String(value.action ?? action.name ?? action.tag ?? ""),
      userId: openId,
      chatId: String(value.chatId ?? value.chat_id ?? context.open_chat_id ?? ""),
      rootMessageId: asString(value.rootMessageId) ?? openMessageId,
      payload: value,
      formValue: extractCardFormValue(payload, event)
    };
  }
}

const extractCardFormValue = (
  payload: Record<string, unknown>,
  event: Record<string, unknown> | null
): Record<string, unknown> | null => {
  const candidates = [
    payload.form_value,
    payload.formValue,
    payload.formData,
    payload.form_data,
    event?.form_value,
    event?.formValue,
    event?.form_data,
    event?.formData
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
};
