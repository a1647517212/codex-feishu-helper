import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { FeishuCard } from "../domain/cards.js";

export interface SentMessage {
  messageId: string;
  raw: Record<string, unknown>;
}

export interface FeishuSender {
  sendText(chatId: string, text: string, rootMessageId?: string | null): Promise<SentMessage>;
  sendCard(chatId: string, card: FeishuCard, rootMessageId?: string | null): Promise<SentMessage>;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
}

export class FeishuClient implements FeishuSender {
  private token: { value: string; expiresAt: number } | null = null;

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

  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        msg_type: "interactive",
        content: JSON.stringify(card)
      })
    });
    await this.assertOk(response, "update card");
  }

  private async createMessage(chatId: string, msgType: "text" | "interactive", content: unknown): Promise<SentMessage> {
    const token = await this.getTenantAccessToken();
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
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
    });
    const body = await this.assertOk(response, "create message");
    return extractMessage(body);
  }

  private async replyMessage(messageId: string, msgType: "text" | "interactive", content: unknown): Promise<SentMessage> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          msg_type: msgType,
          content: JSON.stringify(content)
        })
      }
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
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    });
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
}

const extractMessage = (body: Record<string, unknown>): SentMessage => {
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
  return {
    messageId: String(data.message_id ?? data.messageId ?? ""),
    raw: body
  };
};
