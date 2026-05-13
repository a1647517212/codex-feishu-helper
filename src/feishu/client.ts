import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { FeishuCard } from "../domain/cards.js";
import type { FeishuMessageAttachment } from "../core/types.js";

export interface SentMessage {
  messageId: string;
  rootId: string | null;
  parentId: string | null;
  threadId: string | null;
  raw: Record<string, unknown>;
}

export interface FeishuChatInfo {
  chatId: string;
  name: string | null;
  chatMode: string | null;
  groupMessageType: string | null;
  chatType: string | null;
  chatStatus: string | null;
  external: boolean | null;
  raw: Record<string, unknown>;
}

export interface FeishuCreatedChat {
  chatId: string;
  name: string | null;
  raw: Record<string, unknown>;
}

export interface DownloadedFeishuResource {
  path: string;
  mimeType: string | null;
  sizeBytes: number;
}

export interface FeishuSender {
  sendText(chatId: string, text: string, rootMessageId?: string | null): Promise<SentMessage>;
  sendCard(chatId: string, card: FeishuCard, rootMessageId?: string | null): Promise<SentMessage>;
  replyTextInThread(messageId: string, text: string): Promise<SentMessage>;
  replyCardInThread(messageId: string, card: FeishuCard): Promise<SentMessage>;
  updateText(messageId: string, text: string): Promise<void>;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
  createTaskChat(input: {
    name: string;
    ownerId?: string | null;
    userIds?: string[];
    chatType?: "private" | "public";
    description?: string | null;
    setBotManager?: boolean;
  }): Promise<FeishuCreatedChat>;
  updateChatName(chatId: string, name: string, description?: string | null): Promise<void>;
  downloadMessageResource?(input: {
    messageId: string;
    fileKey: string;
    resourceType: "image";
    attachment?: FeishuMessageAttachment;
  }): Promise<DownloadedFeishuResource>;
}

export interface FeishuChatInfoProvider {
  getChatInfo(chatId: string): Promise<FeishuChatInfo>;
}

export class FeishuClient implements FeishuSender {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly requestTimeoutMs = 15000;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {}

  async sendText(chatId: string, textValue: string, rootMessageId?: string | null): Promise<SentMessage> {
    if (rootMessageId) {
      return this.replyMessage(rootMessageId, "text", { text: textValue });
    }
    return this.createMessage(chatId, "text", { text: textValue });
  }

  async sendCard(chatId: string, card: FeishuCard, rootMessageId?: string | null): Promise<SentMessage> {
    if (rootMessageId) {
      return this.replyMessage(rootMessageId, "interactive", card);
    }
    return this.createMessage(chatId, "interactive", card);
  }

  async replyTextInThread(messageId: string, text: string): Promise<SentMessage> {
    return this.replyMessage(messageId, "text", { text }, true);
  }

  async replyCardInThread(messageId: string, card: FeishuCard): Promise<SentMessage> {
    return this.replyMessage(messageId, "interactive", card, true);
  }

  async updateText(messageId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.fetchWithTimeout(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        msg_type: "text",
        content: JSON.stringify({ text })
      })
    }, "update text");
    await this.assertOk(response, "update text");
  }

  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.fetchWithTimeout(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        msg_type: "interactive",
        content: JSON.stringify(card)
      })
    }, "update card");
    await this.assertOk(response, "update card");
  }

  async createTaskChat(input: {
    name: string;
    ownerId?: string | null;
    userIds?: string[];
    chatType?: "private" | "public";
    description?: string | null;
    setBotManager?: boolean;
  }): Promise<FeishuCreatedChat> {
    const token = await this.getTenantAccessToken();
    const params = new URLSearchParams({
      user_id_type: "open_id",
      uuid: `feishu-codex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    });
    if (input.setBotManager) params.set("set_bot_manager", "true");
    const body: Record<string, unknown> = {
      name: truncateChatName(input.name),
      chat_mode: "group",
      chat_type: input.chatType ?? "private",
      group_message_type: "chat",
      edit_permission: "only_owner",
      add_member_permission: "only_owner",
      share_card_permission: "not_allowed",
      membership_approval: "no_approval_required",
      join_message_visibility: "not_anyone",
      leave_message_visibility: "not_anyone",
      description: input.description ?? "Codex task chat"
    };
    if (input.ownerId) body.owner_id = input.ownerId;
    if (input.userIds && input.userIds.length > 0) body.user_id_list = [...new Set(input.userIds)].slice(0, 50);
    const response = await this.fetchWithTimeout(`https://open.feishu.cn/open-apis/im/v1/chats?${params.toString()}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body)
    }, "create task chat");
    const result = await this.assertOk(response, "create task chat");
    const data = getObject(result.data);
    return {
      chatId: String(data.chat_id ?? ""),
      name: asOptionalString(data.name),
      raw: result
    };
  }

  async updateChatName(chatId: string, name: string, description?: string | null): Promise<void> {
    const token = await this.getTenantAccessToken();
    const body: Record<string, unknown> = { name: truncateChatName(name) };
    if (description != null) body.description = description;
    const response = await this.fetchWithTimeout(
      `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(body)
      },
      "update chat name"
    );
    await this.assertOk(response, "update chat name");
  }

  async getChatInfo(chatId: string): Promise<FeishuChatInfo> {
    const token = await this.getTenantAccessToken();
    const response = await this.fetchWithTimeout(
      `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` }
      },
      "get chat info"
    );
    const body = await this.assertOk(response, "get chat info");
    const data = getObject(body.data);
    return {
      chatId,
      name: asOptionalString(data.name),
      chatMode: asOptionalString(data.chat_mode),
      groupMessageType: asOptionalString(data.group_message_type),
      chatType: asOptionalString(data.chat_type),
      chatStatus: asOptionalString(data.chat_status),
      external: typeof data.external === "boolean" ? data.external : null,
      raw: data
    };
  }

  async setGroupMessageType(chatId: string, groupMessageType: "chat" | "thread"): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.fetchWithTimeout(`https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({ group_message_type: groupMessageType })
    }, "update chat group message type");
    await this.assertOk(response, "update chat group message type");
  }

  async downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    resourceType: "image";
    attachment?: FeishuMessageAttachment;
  }): Promise<DownloadedFeishuResource> {
    const token = await this.getTenantAccessToken();
    const params = new URLSearchParams({ type: input.resourceType });
    const response = await this.fetchWithTimeout(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}/resources/${encodeURIComponent(input.fileKey)}?${params.toString()}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` }
      },
      "download message resource"
    );
    if (!response.ok) {
      const body = await safeResponseText(response);
      this.logger.warn("Feishu download message resource failed", { status: response.status, body });
      throw new Error(`Feishu download message resource failed: HTTP ${response.status} ${body}`);
    }
    const mimeType = response.headers.get("content-type");
    if (looksLikeJson(mimeType)) {
      const body = await safeResponseText(response);
      this.logger.warn("Feishu download message resource returned JSON", { status: response.status, body });
      throw new Error(`Feishu download message resource failed: ${body || "unexpected JSON response"}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const extension = imageExtension(mimeType) ?? imageExtension(input.attachment?.mimeType ?? null) ?? ".img";
    const directory = join(this.config.storage.homeDir, "attachments", sanitizePathSegment(input.messageId));
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${sanitizePathSegment(input.fileKey)}${extension}`);
    await writeFile(path, bytes);
    this.logger.info("Feishu download message resource saved", {
      messageId: input.messageId,
      fileKey: input.fileKey,
      path,
      mimeType,
      sizeBytes: bytes.byteLength
    });
    return {
      path,
      mimeType,
      sizeBytes: bytes.byteLength
    };
  }

  private async createMessage(chatId: string, msgType: "text" | "interactive", content: unknown): Promise<SentMessage> {
    const token = await this.getTenantAccessToken();
    const response = await this.fetchWithTimeout("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content)
      })
    }, "create message");
    const body = await this.assertOk(response, "create message");
    return extractMessage(body);
  }

  private async replyMessage(
    messageId: string,
    msgType: "text" | "interactive",
    content: unknown,
    replyInThread = false
  ): Promise<SentMessage> {
    const token = await this.getTenantAccessToken();
    const response = await this.fetchWithTimeout(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          msg_type: msgType,
          content: JSON.stringify(content),
          reply_in_thread: replyInThread
        })
      },
      "reply message"
    );
    const body = await this.assertOk(response, "reply message");
    return extractMessage(body);
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error("Feishu appId/appSecret are required for sending messages.");
    }
    const response = await this.fetchWithTimeout("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    }, "get tenant token");
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok || body.code !== 0) {
      throw new Error(`Failed to get Feishu tenant token: ${JSON.stringify(body)}`);
    }
    const token = String(body.tenant_access_token ?? "");
    const expire = Number(body.expire ?? 7200);
    this.token = { value: token, expiresAt: now + expire * 1000 };
    return token;
  }

  private async assertOk(response: Response, operation: string): Promise<Record<string, unknown>> {
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok || body.code !== 0) {
      this.logger.warn(`Feishu ${operation} failed`, { status: response.status, body });
      throw new Error(`Feishu ${operation} failed: ${JSON.stringify(body)}`);
    }
    return body;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, operation: string): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`Feishu ${operation} timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }
}

const extractMessage = (body: Record<string, unknown>): SentMessage => {
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
  return {
    messageId: String(data.message_id ?? data.messageId ?? ""),
    rootId: typeof data.root_id === "string" ? data.root_id : null,
    parentId: typeof data.parent_id === "string" ? data.parent_id : null,
    threadId: typeof data.thread_id === "string" ? data.thread_id : null,
    raw: body
  };
};

const safeResponseText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

const imageExtension = (mimeType: string | null): string | null => {
  const compact = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  if (compact === "image/png") return ".png";
  if (compact === "image/jpeg" || compact === "image/jpg") return ".jpg";
  if (compact === "image/webp") return ".webp";
  if (compact === "image/gif") return ".gif";
  if (compact === "image/bmp") return ".bmp";
  return null;
};

const looksLikeJson = (mimeType: string | null): boolean =>
  (mimeType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

const sanitizePathSegment = (value: string): string => {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/g, "_").slice(0, 120);
  return sanitized || "resource";
};

const getObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asOptionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const truncateChatName = (value: string): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 60) return compact || "Codex 任务";
  return compact.slice(0, 57).trimEnd() + "...";
};
