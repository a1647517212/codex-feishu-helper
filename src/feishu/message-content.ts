import { asString } from "../core/json.js";
import type { FeishuMessageAttachment } from "../core/types.js";

export type ParsedFeishuMessageContent = {
  text: string;
  attachments: FeishuMessageAttachment[];
};

export const parseFeishuMessageContent = (message: Record<string, unknown>): ParsedFeishuMessageContent => {
  const content = asString(message.content);
  const messageType = asString(message.message_type) ?? asString(message.msg_type);
  const messageId = asString(message.message_id);
  const parsed = parseContentJson(content);
  return {
    text: extractText(content, parsed),
    attachments: extractAttachments(parsed, messageType, messageId)
  };
};

const parseContentJson = (content: string | null): Record<string, unknown> => {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const extractText = (content: string | null, parsed: Record<string, unknown>): string => {
  const text = asString(parsed.text) ?? asString(parsed.content);
  if (text) return text;
  return Object.keys(parsed).length === 0 ? content ?? "" : "";
};

const extractAttachments = (
  parsed: Record<string, unknown>,
  messageType: string | null,
  messageId: string | null
): FeishuMessageAttachment[] => {
  const keys = new Set<string>();
  const imageKey = asString(parsed.image_key) ?? asString(parsed.imageKey);
  if (imageKey) keys.add(imageKey);
  if (messageType === "image") {
    const key = asString(parsed.file_key) ?? asString(parsed.fileKey);
    if (key) keys.add(key);
  }
  return [...keys].map((key) => ({
    kind: "image",
    key,
    messageId
  }));
};
