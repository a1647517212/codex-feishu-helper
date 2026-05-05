import type { BridgeConfig } from "../config.js";
import type { NotificationOutboxItem } from "../core/types.js";
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
      const card = item.payload.card as Record<string, unknown> | undefined;
      const text = typeof item.payload.text === "string" ? item.payload.text : null;
      if (card) {
        await this.feishu.sendCard(item.feishuChatId, card, item.feishuTopicRootMessageId);
      } else if (text) {
        await this.feishu.sendText(item.feishuChatId, text, item.feishuTopicRootMessageId);
      } else {
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
}
