import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeDatabase } from "../src/db/database.js";
import { Repository } from "../src/db/repo.js";
import { Logger } from "../src/logger.js";
import type { BridgeConfig } from "../src/config.js";
import type { FeishuCard } from "../src/domain/cards.js";
import type { FeishuSender, SentMessage } from "../src/feishu/client.js";

export const makeTempRepo = (): {
  dir: string;
  db: BridgeDatabase;
  repo: Repository;
  cleanup: () => void;
} => {
  const dir = mkdtempSync(join(tmpdir(), "codex-feishu-test-"));
  const db = new BridgeDatabase(join(dir, "bridge.db"));
  db.migrate();
  return {
    dir,
    db,
    repo: new Repository(db),
    cleanup: () => {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
        if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(code)) throw error;
      }
    }
  };
};

export const makeConfig = (dir: string): BridgeConfig => ({
  configPath: join(dir, "config.json"),
  machine: { id: "test-machine", name: "Test Machine" },
  server: { host: "127.0.0.1", port: 0, adminToken: "test-token" },
  codex: {
    command: "codex",
    args: ["app-server"],
    experimentalApi: true,
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "xhigh",
    defaultSandboxMode: "danger-full-access",
    defaultApprovalPolicy: "never",
    autoArchiveOnCompletion: true,
    serviceName: "feishu_codex_bridge_test"
  },
  feishu: {
    appId: "app",
    appSecret: "secret",
    defaultChatId: "chat_1",
    verificationToken: undefined,
    encryptKey: undefined,
    transport: "long_connection",
    messageTransport: "long_connection",
    cardActionTransport: "long_connection",
    interactionMode: "message_command",
    taskContainerMode: "dedicated_chat",
    taskChatNamePrefix: "C",
    taskChatType: "private",
    taskChatFallbackToTopic: true,
    taskChatSetBotManager: true,
    allowedUserIds: ["user_1"],
    allowedChatIds: ["chat_1"]
  },
  storage: {
    homeDir: dir,
    databasePath: join(dir, "bridge.db"),
    logPath: join(dir, "bridge.log")
  },
  bridge: {
    maxFeishuTextLength: 3500,
    queueMergeWindowMs: 300000,
    outboxRetryBaseMs: 10,
    outboxMaxAttempts: 3,
    threadListLimit: 20
  },
  projects: []
});

export class MockFeishu implements FeishuSender {
  sent: Array<{
    type: "text" | "card";
    mode?: "thread";
    chatId: string;
    root?: string | null;
    payload: unknown;
  }> = [];
  createdChats: Array<{ chatId: string; name: string; input: Record<string, unknown> }> = [];
  updatedChatNames: Array<{ chatId: string; name: string }> = [];
  failNext = false;

  async sendText(chatId: string, text: string, rootMessageId?: string | null): Promise<SentMessage> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock send failure");
    }
    this.sent.push({ type: "text", chatId, root: rootMessageId, payload: text });
    return { messageId: `msg_${this.sent.length}`, rootId: null, parentId: null, threadId: null, raw: {} };
  }

  async sendCard(chatId: string, card: FeishuCard, rootMessageId?: string | null): Promise<SentMessage> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock send failure");
    }
    this.sent.push({ type: "card", chatId, root: rootMessageId, payload: card });
    return { messageId: `msg_${this.sent.length}`, rootId: null, parentId: null, threadId: null, raw: {} };
  }

  async replyTextInThread(messageId: string, text: string): Promise<SentMessage> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock send failure");
    }
    this.sent.push({ type: "text", mode: "thread", chatId: "thread", root: messageId, payload: text });
    const index = this.sent.length;
    return {
      messageId: `msg_${index}`,
      rootId: messageId,
      parentId: messageId,
      threadId: `omt_${index}`,
      raw: {}
    };
  }

  async replyCardInThread(messageId: string, card: FeishuCard): Promise<SentMessage> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock send failure");
    }
    this.sent.push({ type: "card", mode: "thread", chatId: "thread", root: messageId, payload: card });
    const index = this.sent.length;
    return {
      messageId: `msg_${index}`,
      rootId: messageId,
      parentId: messageId,
      threadId: `omt_${index}`,
      raw: {}
    };
  }

  async updateText(messageId: string, text: string): Promise<void> {
    this.sent.push({ type: "text", chatId: "update", root: messageId, payload: text });
  }

  async updateCard(): Promise<void> {}

  async createTaskChat(input: Record<string, unknown>) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock create chat failure");
    }
    const chatId = `task_chat_${this.createdChats.length + 1}`;
    const name = String(input.name ?? chatId);
    this.createdChats.push({ chatId, name, input });
    return { chatId, name, raw: {} };
  }

  async updateChatName(chatId: string, name: string): Promise<void> {
    this.updatedChatNames.push({ chatId, name });
  }

  async getChatInfo() {
    return {
      chatId: "chat_1",
      name: "Test Chat",
      chatMode: "group",
      groupMessageType: "thread",
      chatType: "private",
      chatStatus: "normal",
      external: false,
      raw: {}
    };
  }
}

export class MockCodex {
  status = "connected" as const;
  notifications: Record<string, Array<(message: Record<string, unknown>) => void>> = {};
  requests: Record<string, Array<(message: Record<string, unknown>) => void>> = {};
  turns: Array<{ threadId: string; text: string }> = [];
  startedThreads: Array<Record<string, unknown>> = [];
  startedTurns: Array<Record<string, unknown>> = [];
  steerRequests: Array<{ threadId: string; text: string }> = [];
  responses: Array<{ requestId: string | number; result: Record<string, unknown> }> = [];
  interrupted: string[] = [];
  archived: string[] = [];
  threads: any[] = [];
  listCalls: Array<{ limit?: number; pageSize?: number; maxPages?: number }> = [];
  readFailures = new Map<string, Error>();
  failSteer = false;

  on(event: "notification" | "serverRequest" | "error", handler: (message: any) => void): void {
    const bag = event === "serverRequest" ? this.requests : this.notifications;
    bag[event] ??= [];
    bag[event].push(handler);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async listThreads(limit?: number, options?: { pageSize?: number; maxPages?: number }): Promise<any[]> {
    this.listCalls.push({ limit, ...options });
    return this.threads;
  }

  async readThread(threadId: string): Promise<Record<string, unknown>> {
    const failure = this.readFailures.get(threadId);
    if (failure) throw failure;
    const thread =
      this.threads.find((candidate) => candidate.id === threadId) ?? {
        id: threadId,
        name: "Imported task",
        preview: "Imported task",
        cwd: null,
        status: { type: "idle" },
        updatedAt: Date.now()
      };
    return { thread };
  }

  async startThread(params: Record<string, unknown> = {}): Promise<any> {
    this.startedThreads.push(params);
    return { id: "thr_new", title: null, preview: null, cwd: (params.cwd as string | null | undefined) ?? null, status: "idle", updatedAt: null, raw: {} };
  }

  async resumeThread(threadId: string): Promise<any> {
    return { id: threadId, title: null, preview: null, cwd: null, status: "idle", updatedAt: null, raw: {} };
  }

  async startTurn(threadId: string, text: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.turns.push({ threadId, text });
    this.startedTurns.push({ threadId, text, ...options });
    return { turn: { id: `turn_${this.turns.length}` } };
  }

  async steerTurn(threadId: string, text: string): Promise<Record<string, unknown>> {
    if (this.failSteer) throw new Error("mock steer failure");
    this.steerRequests.push({ threadId, text });
    return { turnId: `turn_${this.turns.length}` };
  }

  async interruptTurn(threadId: string, _turnId: string): Promise<Record<string, unknown>> {
    this.interrupted.push(threadId);
    return {};
  }

  async archiveThread(threadId: string): Promise<Record<string, unknown>> {
    this.archived.push(threadId);
    return {};
  }

  async respondToServerRequest(requestId: string | number, result: Record<string, unknown>): Promise<void> {
    this.responses.push({ requestId, result });
  }
}

export const makeLogger = (dir: string): Logger => new Logger(join(dir, "test.log"), "error");
