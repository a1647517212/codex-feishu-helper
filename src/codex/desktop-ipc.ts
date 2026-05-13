import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { Logger } from "../logger.js";
import { buildUserInput, toTaskStatus } from "./protocol.js";
import type { CodexLocalImageAttachment } from "./protocol.js";
import type { CodexThreadSummary } from "./client.js";

type DesktopIpcMessageType =
  | "request"
  | "response"
  | "broadcast"
  | "client-discovery-request"
  | "client-discovery-response";

type DesktopIpcMessage = {
  type?: DesktopIpcMessageType;
  requestId?: string;
  method?: string;
  sourceClientId?: string;
  targetClientId?: string;
  version?: number;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  resultType?: string;
  response?: unknown;
  request?: unknown;
};

interface DesktopIpcPendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  method: string;
}

interface DesktopConversationSnapshot {
  conversationId: string;
  hostId: string | null;
  ownerClientId: string | null;
  observedAt: number;
  state: Record<string, unknown>;
}

export interface DesktopIpcClientEvents {
  notification: [message: Record<string, unknown>];
  serverRequest: [message: Record<string, unknown>];
  error: [error: Error];
}

export type DesktopThreadSubmitter = (input: {
  prompt: string;
  cwd: string | null;
  model: string | null;
  reasoningEffort: string | null;
  approvalPolicy: string;
  sandboxMode: string;
  serviceName: string;
  logger: Logger;
}) => Promise<unknown>;

export type DesktopRuntimeRequestSubmitter = (input: {
  method: string;
  params: Record<string, unknown> | null;
  serviceName: string;
  logger: Logger;
}) => Promise<unknown>;

export interface DesktopIpcClientOptions {
  pipePath: string;
  initialSnapshotWaitMs: number;
  creationSnapshotWaitMs?: number;
  serviceName?: string;
}

export class DesktopIpcClient extends EventEmitter<DesktopIpcClientEvents> {
  private socket: Socket | null = null;
  private initialized = false;
  private clientId: string | null = null;
  private readonly sourceClientId = `feishu-codex-bridge-${randomUUID()}`;
  private buffer = Buffer.alloc(0);
  private nextFrameLength: number | null = null;
  private nextRequestNumber = 1;
  private readonly pending = new Map<string, DesktopIpcPendingRequest>();
  private readonly conversations = new Map<string, DesktopConversationSnapshot>();
  private readonly emittedTurnStatuses = new Map<string, string>();
  private readonly archivedConversationIds = new Set<string>();
  private readonly serverRequestSources = new Map<string, string | null>();
  private lastHostId: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly options: DesktopIpcClientOptions,
    private readonly logger: Logger
  ) {
    super();
  }

  get status(): "connected" | "disconnected" | "not_started" | "error" {
    if (!this.socket) return this.lastError ? "error" : "not_started";
    if (this.socket.destroyed) return this.lastError ? "error" : "disconnected";
    return this.initialized ? "connected" : "disconnected";
  }

  get connectedClientId(): string | null {
    return this.clientId;
  }

  get snapshotCount(): number {
    return this.conversations.size;
  }

  async start(): Promise<void> {
    if (this.status === "connected") return;
    await this.stop();
    this.lastError = null;
    const socket = createConnection(this.options.pipePath);
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => {
      this.lastError = error.message;
      this.rejectAll(error);
      this.logger.warn("codex desktop ipc socket error", { error: String(error), pipePath: this.options.pipePath });
    });
    socket.on("close", () => {
      this.initialized = false;
      this.rejectAll(new Error("codex desktop ipc socket closed"));
    });
    await waitForSocketConnect(socket);
    const initResult = await this.rawRequest(
      "initialize",
      { clientType: "feishu-codex-bridge" },
      { version: 0, targetClientId: undefined, timeoutMs: 10000 }
    );
    const init = objectRecord(initResult);
    this.clientId = typeof init.clientId === "string" ? init.clientId : null;
    this.initialized = true;
    this.logger.info("codex desktop ipc connected", {
      pipePath: this.options.pipePath,
      clientId: this.clientId
    });
    await this.waitForInitialSnapshots();
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("codex desktop ipc stopped"));
    }
    this.pending.clear();
    this.archivedConversationIds.clear();
    this.serverRequestSources.clear();
    const socket = this.socket;
    this.socket = null;
    this.initialized = false;
    this.clientId = null;
    this.buffer = Buffer.alloc(0);
    this.nextFrameLength = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.end();
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
        resolve();
      }, 250).unref();
    });
  }

  listThreads(limit: number): CodexThreadSummary[] {
    return [...this.conversations.values()]
      .filter((snapshot) => !this.archivedConversationIds.has(snapshot.conversationId))
      .map((snapshot) => threadSummaryFromConversation(snapshot.state))
      .filter((thread) => thread.id.length > 0)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, Math.max(1, limit));
  }

  readThread(threadId: string): Record<string, unknown> {
    const snapshot = this.conversations.get(threadId);
    if (!snapshot) throw new Error(`Desktop IPC has not observed thread: ${threadId}`);
    return { thread: threadSummaryFromConversation(snapshot.state).raw };
  }

  async startTurn(
    threadId: string,
    text: string,
    options: {
      cwd?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
      approvalPolicy: string;
      sandboxPolicy: Record<string, unknown>;
      attachments?: CodexLocalImageAttachment[];
    }
  ): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const params = {
      conversationId: threadId,
      turnStartParams: {
        input: buildUserInput(text, options.attachments ?? []),
        cwd: options.cwd ?? undefined,
        model: options.model ?? null,
        effort: options.reasoningEffort ?? null,
        approvalPolicy: options.approvalPolicy,
        sandboxPolicy: options.sandboxPolicy
      }
    };
    const result = await this.followerRequest(snapshot, "thread-follower-start-turn", params, 180000);
    return result as Record<string, unknown>;
  }

  async startThread(options: {
    prompt: string;
    attachments?: CodexLocalImageAttachment[];
    cwd?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    approvalPolicy: string;
    sandboxMode: string;
    serviceName: string;
  }): Promise<CodexThreadSummary> {
    const prompt = options.prompt.trim();
    if (!prompt) {
      throw new Error("Desktop IPC thread creation requires a non-empty prompt.");
    }
    await this.start();
    const beforeIds = new Set(this.conversations.keys());
    const startedAt = Date.now();
    const hostId = this.currentHostId();
    const requestBase = {
      prompt,
      attachments: options.attachments ?? [],
      cwd: options.cwd ?? null,
      model: options.model ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
      approvalPolicy: options.approvalPolicy,
      sandboxMode: options.sandboxMode,
      serviceName: options.serviceName
    };
    let snapshot: DesktopConversationSnapshot | null = null;
    try {
      await this.hostRequest(
        "start-conversation",
        buildStartConversationRequest({
          hostId,
          ...requestBase
        }),
        180000
      );
      snapshot = await this.waitForNewConversationSnapshot({
        beforeIds,
        prompt,
        cwd: options.cwd ?? null,
        startedAt,
        timeoutMs: this.options.creationSnapshotWaitMs ?? 120000
      });
    } catch (error) {
      const matchedSnapshot = this.findNewConversationSnapshot({
        beforeIds,
        prompt,
        cwd: options.cwd ?? null,
        startedAt
      });
      if (matchedSnapshot) {
        snapshot = matchedSnapshot;
      } else if (isNoClientFoundError(error) && hostId) {
        this.logger.warn("desktop ipc start-conversation failed for remembered host, retrying without hostId", {
          hostId,
          error: String(error)
        });
        try {
          await this.hostRequest(
            "start-conversation",
            buildStartConversationRequest({
              hostId: null,
              ...requestBase
            }),
            180000
          );
          snapshot = await this.waitForNewConversationSnapshot({
            beforeIds,
            prompt,
            cwd: options.cwd ?? null,
            startedAt,
            timeoutMs: this.options.creationSnapshotWaitMs ?? 120000
          });
        } catch (retryError) {
          snapshot = this.findNewConversationSnapshot({
            beforeIds,
            prompt,
            cwd: options.cwd ?? null,
            startedAt
          });
          if (!snapshot && isExplicitThreadCreationFailure(retryError)) {
            snapshot = await this.tryThreadStartFallback({
              ...requestBase,
              beforeIds,
              startedAt
            });
          }
          if (!snapshot) throw retryError;
        }
      } else if (isExplicitThreadCreationFailure(error)) {
        snapshot = await this.tryThreadStartFallback({
          ...requestBase,
          beforeIds,
          startedAt
        });
      } else {
        throw error;
      }
    }
    if (!snapshot) {
      throw new Error("Desktop IPC did not return a usable thread snapshot for the new conversation.");
    }
    const title = deriveThreadTitle(prompt);
    if (title) {
      await this.setThreadName(snapshot.conversationId, title).catch((error) => {
        this.logger.warn("failed to set desktop thread title after creation", {
          conversationId: snapshot.conversationId,
          error: String(error)
        });
      });
    }
    const updated = await this.waitForConversationPromptSnapshot({
      conversationId: snapshot.conversationId,
      prompt,
      startedAt,
      timeoutMs: 30000
    });
    return threadSummaryFromConversation((updated ?? snapshot).state);
  }

  async steerTurn(
    threadId: string,
    text: string,
    attachments: CodexLocalImageAttachment[] = []
  ): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const activeTurnId = activeTurnIdFromConversation(snapshot.state);
    const params: Record<string, unknown> = {
      threadId,
      input: buildUserInput(text, attachments)
    };
    if (activeTurnId) params.expectedTurnId = activeTurnId;
    const result = await this.followerRequest(snapshot, "thread-follower-steer-turn", params, 120000);
    return result as Record<string, unknown>;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const result = await this.followerRequest(
      snapshot,
      "thread-follower-interrupt-turn",
      { threadId, turnId },
      60000
    );
    return result as Record<string, unknown>;
  }

  async setModelAndReasoning(threadId: string, model: string | null, reasoningEffort: string | null): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const result = await this.followerRequest(
      snapshot,
      "thread-follower-set-model-and-reasoning",
      { conversationId: threadId, model, reasoningEffort },
      60000
    );
    return result as Record<string, unknown>;
  }

  async compactThread(threadId: string): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const result = await this.followerRequest(snapshot, "thread-follower-compact-thread", { conversationId: threadId }, 120000);
    return result as Record<string, unknown>;
  }

  async setCollaborationMode(threadId: string, collaborationMode: Record<string, unknown>): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const result = await this.followerRequest(
      snapshot,
      "thread-follower-set-collaboration-mode",
      { conversationId: threadId, collaborationMode },
      60000
    );
    return result as Record<string, unknown>;
  }

  async editLastUserTurn(
    threadId: string,
    turnId: string,
    message: string,
    agentMode: string | null = null
  ): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const result = await this.followerRequest(
      snapshot,
      "thread-follower-edit-last-user-turn",
      { conversationId: threadId, turnId, message, agentMode },
      120000
    );
    return result as Record<string, unknown>;
  }

  async submitUserInput(
    threadId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const result = await this.followerRequest(
      snapshot,
      "thread-follower-submit-user-input",
      { conversationId: threadId, requestId, response },
      60000
    );
    return result as Record<string, unknown>;
  }

  async submitMcpServerElicitationResponse(
    threadId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const snapshot = this.requireConversation(threadId);
    const result = await this.followerRequest(
      snapshot,
      "thread-follower-submit-mcp-server-elicitation-response",
      { conversationId: threadId, requestId, response },
      60000
    );
    return result as Record<string, unknown>;
  }

  async archiveThread(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.hostRequest("archive-conversation", { conversationId: threadId, cleanupWorktree: false }, 60000);
    this.archivedConversationIds.add(threadId);
    this.emit("notification", {
      method: "thread/archived",
      params: { threadId }
    });
    return result;
  }

  async unarchiveThread(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.hostRequest("unarchive-conversation", { conversationId: threadId }, 60000);
    this.archivedConversationIds.delete(threadId);
    this.emit("notification", {
      method: "thread/unarchived",
      params: { threadId }
    });
    return result;
  }

  async setThreadName(threadId: string, name: string): Promise<Record<string, unknown>> {
    const result = await this.hostRequest("set-thread-title", { conversationId: threadId, title: name }, 60000);
    const snapshot = this.conversations.get(threadId);
    if (snapshot) {
      const state = {
        ...snapshot.state,
        title: name,
        updatedAt: Date.now()
      };
      this.conversations.set(threadId, {
        ...snapshot,
        observedAt: Date.now(),
        state
      });
    }
    this.emit("notification", {
      method: "thread/name/updated",
      params: {
        threadId,
        threadName: name
      }
    });
    return result;
  }

  async setThreadGoal(threadId: string, objective: string): Promise<Record<string, unknown>> {
    const result = await this.hostRequest("set-thread-goal", { conversationId: threadId, objective }, 60000);
    return result;
  }

  async clearThreadGoal(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.hostRequest("clear-thread-goal", { conversationId: threadId }, 60000);
    return result;
  }

  async respondToServerRequest(requestId: string | number, result: Record<string, unknown>): Promise<void> {
    const requestKey = String(requestId);
    if (!requestKey) {
      throw new Error("Desktop IPC response requires a request id.");
    }
    const targetClientId = this.serverRequestSources.get(requestKey) ?? undefined;
    this.serverRequestSources.delete(requestKey);
    this.send({
      type: "response",
      requestId: requestKey,
      sourceClientId: this.sourceClientId,
      targetClientId,
      resultType: "success",
      result
    });
  }

  async respondErrorToServerRequest(requestId: string | number, error: { message: string; code?: number; data?: unknown }): Promise<void> {
    const requestKey = String(requestId);
    if (!requestKey) {
      throw new Error("Desktop IPC error response requires a request id.");
    }
    const targetClientId = this.serverRequestSources.get(requestKey) ?? undefined;
    this.serverRequestSources.delete(requestKey);
    this.send({
      type: "response",
      requestId: requestKey,
      sourceClientId: this.sourceClientId,
      targetClientId,
      resultType: "error",
      error: {
        message: error.message,
        code: error.code ?? -32000,
        data: error.data
      }
    });
  }

  private requireConversation(threadId: string): DesktopConversationSnapshot {
    const snapshot = this.conversations.get(threadId);
    if (!snapshot) {
      throw new Error(`Desktop IPC cannot control unobserved thread: ${threadId}. Open the thread in Codex Desktop first.`);
    }
    if (!snapshot.ownerClientId) {
      throw new Error(`Desktop IPC thread has no owner client yet: ${threadId}`);
    }
    return snapshot;
  }

  private async followerRequest(
    snapshot: DesktopConversationSnapshot,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    await this.start();
    return this.rawRequest(method, params, {
      version: desktopIpcMethodVersion(method),
      targetClientId: snapshot.ownerClientId ?? undefined,
      timeoutMs
    });
  }

  private async hostRequest(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const result = await this.rawRequest(method, params, {
      version: 0,
      timeoutMs
    });
    return objectRecord(result);
  }

  private rawRequest(
    method: string,
    params: unknown,
    options: { version: number; targetClientId?: string; timeoutMs: number }
  ): Promise<unknown> {
    const requestId = `${this.sourceClientId}-${this.nextRequestNumber++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, options.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout, method });
    });
    this.send({
      type: "request",
      requestId,
      sourceClientId: this.sourceClientId,
      targetClientId: options.targetClientId,
      version: options.version,
      method,
      params
    });
    return promise;
  }

  private send(message: DesktopIpcMessage): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Codex Desktop IPC socket is not connected");
    socket.write(encodeFrame(message));
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      if (this.nextFrameLength == null) {
        this.nextFrameLength = this.buffer.readUInt32LE(0);
        this.buffer = this.buffer.subarray(4);
        if (this.nextFrameLength > 268_435_456) {
          const error = new Error(`Codex Desktop IPC frame too large: ${this.nextFrameLength}`);
          this.lastError = error.message;
          this.socket?.destroy(error);
          return;
        }
      }
      if (this.buffer.length < this.nextFrameLength) return;
      const raw = this.buffer.subarray(0, this.nextFrameLength).toString("utf8");
      this.buffer = this.buffer.subarray(this.nextFrameLength);
      this.nextFrameLength = null;
      this.handleRawMessage(raw);
    }
  }

  private handleRawMessage(raw: string): void {
    let message: DesktopIpcMessage;
    try {
      message = JSON.parse(raw) as DesktopIpcMessage;
    } catch (error) {
      this.logger.warn("failed to parse codex desktop ipc message", { raw: raw.slice(0, 500), error: String(error) });
      return;
    }
    this.handleMessage(message);
  }

  private handleMessage(message: DesktopIpcMessage): void {
    if (message.type === "response") {
      this.handleResponse(message);
      return;
    }
    if (message.type === "broadcast") {
      const synthetic = this.handleBroadcast(message);
      for (const notification of synthetic) {
        this.emit("notification", notification);
      }
      return;
    }
    if (message.type === "client-discovery-request") {
      this.handleClientDiscoveryRequest(message);
      return;
    }
    if (message.type === "request") {
      const requestId = String(message.requestId ?? "");
      if (requestId) {
        this.serverRequestSources.set(requestId, typeof message.sourceClientId === "string" ? message.sourceClientId : null);
      }
      this.emit("serverRequest", desktopMessageAsRecord(message));
    }
  }

  private handleResponse(message: DesktopIpcMessage): void {
    const requestId = String(message.requestId ?? "");
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    if (message.resultType === "error" || message.error) {
      pending.reject(new Error(String(message.error ?? "desktop-ipc-error")));
      return;
    }
    pending.resolve(message.result);
  }

  private handleBroadcast(message: DesktopIpcMessage): Record<string, unknown>[] {
    const synthetic: Record<string, unknown>[] = [];
    if (message.method === "thread-stream-state-changed") {
      const snapshot = this.applyThreadStreamState(message);
      if (snapshot) synthetic.push(...this.syntheticNotificationsFromSnapshot(snapshot));
    } else if (message.method === "thread/archived") {
      const threadId = typeof objectRecord(message.params).threadId === "string" ? String(objectRecord(message.params).threadId) : null;
      if (threadId) this.archivedConversationIds.add(threadId);
    } else if (message.method === "thread/unarchived") {
      const threadId = typeof objectRecord(message.params).threadId === "string" ? String(objectRecord(message.params).threadId) : null;
      if (threadId) this.archivedConversationIds.delete(threadId);
    } else if (message.method === "thread/name/updated") {
      const params = objectRecord(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId : null;
      const threadName = typeof params.threadName === "string" ? params.threadName : null;
      if (threadId && threadName) {
        const snapshot = this.conversations.get(threadId);
        if (snapshot) {
          const state = {
            ...snapshot.state,
            title: threadName,
            updatedAt: Date.now()
          };
          this.conversations.set(threadId, {
            ...snapshot,
            observedAt: Date.now(),
            state
          });
        }
      }
    }
    this.emit("notification", desktopMessageAsRecord(message));
    return synthetic;
  }

  private handleClientDiscoveryRequest(message: DesktopIpcMessage): void {
    if (!message.requestId) return;
    this.send({
      type: "client-discovery-response",
      requestId: message.requestId,
      sourceClientId: this.sourceClientId,
      response: { canHandle: false }
    });
  }

  private applyThreadStreamState(message: DesktopIpcMessage): DesktopConversationSnapshot | null {
    const params = objectRecord(message.params);
    const conversationId = typeof params.conversationId === "string" ? params.conversationId : null;
    if (!conversationId) return null;
    const hostId = typeof params.hostId === "string" ? params.hostId : null;
    const change = objectRecord(params.change);
    let state: Record<string, unknown> | null = null;
    if (change.type === "snapshot") {
      state = objectRecord(change.conversationState);
    } else if (change.type === "patch") {
      const existing = this.conversations.get(conversationId)?.state;
      if (existing) state = applyShallowConversationPatch(existing, change);
    }
    if (!state) return null;
    const snapshot = {
      conversationId,
      hostId,
      ownerClientId: typeof message.sourceClientId === "string" ? message.sourceClientId : null,
      observedAt: Date.now(),
      state
    };
    this.conversations.set(conversationId, snapshot);
    if (hostId) this.lastHostId = hostId;
    return snapshot;
  }

  private syntheticNotificationsFromSnapshot(snapshot: DesktopConversationSnapshot): Record<string, unknown>[] {
    const latestTurn = activeTurnFromConversation(snapshot.state) ?? latestTurnFromConversation(snapshot.state);
    if (!latestTurn) return [];
    const turnId = typeof latestTurn.turnId === "string" ? latestTurn.turnId : null;
    if (!turnId) return [];
    const status = typeof latestTurn.status === "string" ? latestTurn.status : null;
    if (!status) return [];
    const key = `${snapshot.conversationId}:${turnId}`;
    const previousStatus = this.emittedTurnStatuses.get(key);
    if (previousStatus === status) return [];
    this.emittedTurnStatuses.set(key, status);
    if (isActiveDesktopTurnStatus(status)) {
      return [{
        method: "turn/started",
        params: {
          threadId: snapshot.conversationId,
          turn: desktopTurnToAppServerTurn(latestTurn)
        }
      }];
    }
    if (isTerminalDesktopTurnStatus(status)) {
      return [{
        method: "turn/completed",
        params: {
          threadId: snapshot.conversationId,
          turn: desktopTurnToAppServerTurn(latestTurn)
        }
      }];
    }
    return [];
  }

  private async waitForInitialSnapshots(): Promise<void> {
    if (this.options.initialSnapshotWaitMs <= 0 || this.conversations.size > 0) return;
    const deadline = Date.now() + this.options.initialSnapshotWaitMs;
    while (Date.now() < deadline) {
      if (this.conversations.size > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async waitForNewConversationSnapshot(input: {
    beforeIds: Set<string>;
    prompt: string;
    cwd: string | null;
    startedAt: number;
    timeoutMs: number;
  }): Promise<DesktopConversationSnapshot> {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = this.findNewConversationSnapshot(input);
      if (snapshot) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      [
        "Timed out waiting for ordinary Codex Desktop to create a new thread through the Desktop IPC host request.",
        "If this repeats, confirm the Codex Desktop window is connected and broadcasts thread-stream-state-changed on \\\\.\\pipe\\codex-ipc."
      ].join(" ")
    );
  }

  private async waitForConversationPromptSnapshot(input: {
    conversationId: string;
    prompt: string;
    startedAt: number;
    timeoutMs: number;
  }): Promise<DesktopConversationSnapshot | null> {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = this.conversations.get(input.conversationId) ?? null;
      if (
        snapshot &&
        snapshot.observedAt >= input.startedAt &&
        (
          conversationContainsPromptSince(snapshot.state, input.prompt, input.startedAt) ||
          conversationContainsPrompt(snapshot.state, input.prompt)
        )
      ) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.conversations.get(input.conversationId) ?? null;
  }

  private findNewConversationSnapshot(input: {
    beforeIds: Set<string>;
    prompt: string;
    cwd: string | null;
    startedAt: number;
  }): DesktopConversationSnapshot | null {
    const candidates = [...this.conversations.values()]
      .filter((snapshot) => !input.beforeIds.has(snapshot.conversationId))
      .filter((snapshot) => snapshot.observedAt >= input.startedAt)
      .sort((left, right) => right.observedAt - left.observedAt);
    const cwdCandidates = input.cwd
      ? candidates.filter((snapshot) => conversationMatchesCwd(snapshot.state, input.cwd!))
      : candidates;
    for (const snapshot of cwdCandidates) {
      if (!input.prompt || conversationContainsPromptSince(snapshot.state, input.prompt, input.startedAt)) {
        return snapshot;
      }
      if (input.prompt && conversationContainsPrompt(snapshot.state, input.prompt)) {
        return snapshot;
      }
    }
    return null;
  }

  private async tryThreadStartFallback(input: {
    prompt: string;
    attachments: CodexLocalImageAttachment[];
    cwd: string | null;
    model: string | null;
    reasoningEffort: string | null;
    approvalPolicy: string;
    sandboxMode: string;
    serviceName: string;
    beforeIds: Set<string>;
    startedAt: number;
  }): Promise<DesktopConversationSnapshot> {
    this.logger.warn("desktop ipc falling back to official thread/start new-thread path", {
      cwd: input.cwd,
      model: input.model,
      serviceName: input.serviceName
    });
    await this.hostRequest(
      "thread/start",
      buildThreadStartRequest({
        cwd: input.cwd,
        model: input.model,
        approvalPolicy: input.approvalPolicy,
        sandboxMode: input.sandboxMode,
        serviceName: input.serviceName
      }),
      180000
    );
    const snapshot = await this.waitForNewConversationSnapshot({
      beforeIds: input.beforeIds,
      prompt: "",
      cwd: input.cwd,
      startedAt: input.startedAt,
      timeoutMs: this.options.creationSnapshotWaitMs ?? 120000
    });
    await this.startTurn(snapshot.conversationId, input.prompt, {
      cwd: input.cwd,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      approvalPolicy: input.approvalPolicy,
      sandboxPolicy: sandboxPolicyFromMode(input.sandboxMode),
      attachments: input.attachments
    });
    return snapshot;
  }

  private currentHostId(): string {
    return this.lastHostId ?? "local";
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
    }
  }
}

const defaultDesktopIpcVersions: Record<string, number> = {
  "thread-follower-start-turn": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 1,
  "thread-follower-set-model-and-reasoning": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-set-collaboration-mode": 1,
  "thread-follower-edit-last-user-turn": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1
};

const desktopIpcMethodVersion = (method: string): number => defaultDesktopIpcVersions[method] ?? 0;

const encodeFrame = (message: DesktopIpcMessage): Buffer => {
  const payload = Buffer.from(JSON.stringify(removeUndefinedFields(message)), "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
};

const removeUndefinedFields = (value: DesktopIpcMessage): DesktopIpcMessage =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as DesktopIpcMessage;

const waitForSocketConnect = (socket: Socket): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Codex Desktop IPC connect timed out"));
    }, 10000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });

const objectRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const buildStartConversationRequest = (input: {
  hostId: string | null;
  prompt: string;
  attachments: CodexLocalImageAttachment[];
  cwd: string | null;
  model: string | null;
  reasoningEffort: string | null;
  approvalPolicy: string;
  sandboxMode: string;
  serviceName: string;
}): Record<string, unknown> => {
  const request: Record<string, unknown> = {
    input: buildUserInput(input.prompt, input.attachments),
    workspaceRoots: input.cwd ? [input.cwd] : [],
    cwd: input.cwd,
    fileAttachments: [],
    addedFiles: [],
    agentMode: "default",
    model: input.model,
    serviceTier: null,
    reasoningEffort: input.reasoningEffort,
    collaborationMode: {
      mode: "default",
      settings: {
        model: input.model ?? "",
        reasoning_effort: input.reasoningEffort,
        developer_instructions: null
      }
    },
    config: {
      approvalPolicy: input.approvalPolicy,
      sandboxMode: input.sandboxMode,
      serviceName: input.serviceName
    },
    workspaceKind: "project"
  };
  if (input.hostId) request.hostId = input.hostId;
  return request;
};

const buildThreadStartRequest = (input: {
  cwd: string | null;
  model: string | null;
  approvalPolicy: string;
  sandboxMode: string;
  serviceName: string;
}): Record<string, unknown> => ({
  cwd: input.cwd,
  model: input.model,
  approvalPolicy: input.approvalPolicy,
  sandbox: sandboxModeToThreadStart(input.sandboxMode),
  serviceName: input.serviceName,
  experimentalRawEvents: false,
  persistExtendedHistory: true
});

const isNoClientFoundError = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("no-client-found");
};

const isExplicitThreadCreationFailure = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("no-client-found");
};

const desktopMessageAsRecord = (message: DesktopIpcMessage): Record<string, unknown> => {
  const record = message as unknown as Record<string, unknown>;
  if (message.type === "request" && typeof message.requestId !== "undefined" && record.id === undefined) {
    record.id = message.requestId;
  }
  return record;
};

const deriveThreadTitle = (prompt: string): string => {
  const title = prompt.replace(/\s+/g, " ").trim();
  if (!title) return "";
  return title.slice(0, 80);
};

const threadSummaryFromConversation = (state: Record<string, unknown>): CodexThreadSummary => {
  const status = conversationStatus(state);
  return {
    id: String(state.id ?? ""),
    title: typeof state.title === "string" ? state.title : null,
    preview: latestPreviewText(state),
    cwd: latestCwd(state),
    status,
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : null,
    source: state.source ?? null,
    agentNickname: null,
    agentRole: null,
    raw: {
      ...state,
      status: taskStatusToAppServerStatus(status),
      name: typeof state.title === "string" ? state.title : null,
      preview: latestPreviewText(state),
      cwd: latestCwd(state),
      updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : null
    }
  };
};

const conversationStatus = (state: Record<string, unknown>): ReturnType<typeof toTaskStatus> => {
  const runtimeStatus = objectRecord(state.threadRuntimeStatus);
  const fromRuntime = toTaskStatus(runtimeStatus);
  if (fromRuntime !== "idle") return fromRuntime;
  if (activeTurnFromConversation(state)) return "running";
  const turns = Array.isArray(state.turns) ? state.turns : [];
  const latest = objectRecord(turns[turns.length - 1]);
  const status = typeof latest.status === "string" ? latest.status : null;
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "running" || status === "active") return "running";
  return toTaskStatus(runtimeStatus);
};

const taskStatusToAppServerStatus = (status: ReturnType<typeof toTaskStatus>): Record<string, unknown> => {
  if (status === "running") return { type: "active" };
  if (status === "failed") return { type: "systemError" };
  return { type: "idle" };
};

const sandboxPolicyFromMode = (mode: string): Record<string, unknown> => {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: true };
  return {
    type: "workspaceWrite",
    writableRoots: [],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
};

const sandboxModeToThreadStart = (mode: string): string => {
  if (mode === "danger-full-access") return "danger-full-access";
  if (mode === "read-only") return "read-only";
  return "workspace-write";
};

const latestCwd = (state: Record<string, unknown>): string | null => {
  if (typeof state.cwd === "string") return state.cwd;
  const turns = Array.isArray(state.turns) ? state.turns : [];
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = objectRecord(turns[index]);
    const params = objectRecord(turn.params);
    if (typeof params.cwd === "string") return params.cwd;
  }
  return null;
};

const latestPreviewText = (state: Record<string, unknown>): string | null => {
  const turns = Array.isArray(state.turns) ? state.turns : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = objectRecord(turns[turnIndex]);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = objectRecord(items[itemIndex]);
      if (typeof item.text === "string" && item.text.trim()) return item.text.trim().slice(0, 500);
      const content = Array.isArray(item.content) ? item.content : [];
      for (const entry of content) {
        const contentItem = objectRecord(entry);
        if (typeof contentItem.text === "string" && contentItem.text.trim()) {
          return contentItem.text.trim().slice(0, 500);
        }
      }
    }
  }
  return null;
};

const conversationContainsPrompt = (state: Record<string, unknown>, prompt: string): boolean => {
  const normalizedPrompt = normalizeTextForMatch(prompt);
  if (!normalizedPrompt) return false;
  const turns = Array.isArray(state.turns) ? state.turns : [];
  for (const turn of turns) {
    const turnObject = objectRecord(turn);
    const params = objectRecord(turnObject.params);
    if (inputItemsContainText(params.input, normalizedPrompt)) return true;
    if (inputItemsContainText(turnObject.input, normalizedPrompt)) return true;
    if (inputItemsContainText(turnObject.items, normalizedPrompt)) return true;
  }
  return false;
};

const conversationContainsPromptSince = (state: Record<string, unknown>, prompt: string, startedAt: number): boolean => {
  const normalizedPrompt = normalizeTextForMatch(prompt);
  if (!normalizedPrompt) return false;
  const turns = Array.isArray(state.turns) ? state.turns : [];
  for (const turn of turns) {
    const turnObject = objectRecord(turn);
    const activityAt = turnActivityAtMs(turnObject);
    if (activityAt == null || activityAt < startedAt) continue;
    const params = objectRecord(turnObject.params);
    if (inputItemsContainText(params.input, normalizedPrompt)) return true;
    if (inputItemsContainText(turnObject.input, normalizedPrompt)) return true;
    if (inputItemsContainText(turnObject.items, normalizedPrompt)) return true;
  }
  return false;
};

const conversationLooksNewSince = (state: Record<string, unknown>, startedAt: number): boolean => {
  const turns = Array.isArray(state.turns) ? state.turns : [];
  if (turns.length === 0) {
    return typeof state.updatedAt === "number" && state.updatedAt >= startedAt;
  }
  let hasRecentTurn = false;
  for (const turn of turns) {
    const activityAt = turnActivityAtMs(objectRecord(turn));
    if (activityAt == null) return false;
    if (activityAt < startedAt) return false;
    hasRecentTurn = true;
  }
  return hasRecentTurn;
};

const conversationMatchesCwd = (state: Record<string, unknown>, cwd: string): boolean => {
  const expected = normalizeFsPath(cwd);
  const actual = latestCwd(state);
  return actual ? normalizeFsPath(actual) === expected : false;
};

const inputItemsContainText = (value: unknown, normalizedPrompt: string): boolean => {
  if (typeof value === "string") return normalizeTextForMatch(value).includes(normalizedPrompt);
  if (Array.isArray(value)) return value.some((entry) => inputItemsContainText(entry, normalizedPrompt));
  const object = objectRecord(value);
  for (const key of ["text", "message", "content", "input"]) {
    const raw = object[key];
    if (typeof raw === "string" && normalizeTextForMatch(raw).includes(normalizedPrompt)) return true;
    if (Array.isArray(raw) && raw.some((entry) => inputItemsContainText(entry, normalizedPrompt))) return true;
  }
  return false;
};

const normalizeTextForMatch = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 300);

const normalizeFsPath = (value: string): string =>
  value.trim().replace(/[\\/]+/g, "/").replace(/\/+$/g, "").toLowerCase();

const turnActivityAtMs = (turn: Record<string, unknown>): number | null => {
  const timestamps = [
    typeof turn.turnStartedAtMs === "number" ? turn.turnStartedAtMs : null,
    typeof turn.finalAssistantStartedAtMs === "number" ? turn.finalAssistantStartedAtMs : null,
    typeof turn.updatedAt === "number" ? turn.updatedAt : null,
    typeof turn.completedAtMs === "number" ? turn.completedAtMs : null
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
};

const activeTurnIdFromConversation = (state: Record<string, unknown>): string | null => {
  const activeTurn = activeTurnFromConversation(state);
  return typeof activeTurn?.turnId === "string" ? activeTurn.turnId : null;
};

const activeTurnFromConversation = (state: Record<string, unknown>): Record<string, unknown> | null => {
  for (const turn of turnsNewestFirst(state)) {
    const status = typeof turn.status === "string" ? turn.status : null;
    const turnId = typeof turn.turnId === "string" ? turn.turnId : null;
    if (turnId && isActiveDesktopTurnStatus(status ?? "")) return turn;
  }
  return null;
};

const latestTurnFromConversation = (state: Record<string, unknown>): Record<string, unknown> | null => {
  const turns = turnsNewestFirst(state);
  return turns[0] ?? null;
};

const turnsNewestFirst = (state: Record<string, unknown>): Record<string, unknown>[] => {
  const turns = Array.isArray(state.turns) ? state.turns : [];
  return [...turns].reverse().map(objectRecord).filter((turn) => Object.keys(turn).length > 0);
};

const isActiveDesktopTurnStatus = (status: string): boolean =>
  status === "running" || status === "active" || status === "in_progress";

const isTerminalDesktopTurnStatus = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

const desktopTurnToAppServerTurn = (turn: Record<string, unknown>): Record<string, unknown> => ({
  ...turn,
  id: typeof turn.turnId === "string" ? turn.turnId : turn.id,
  status: normalizeDesktopTurnStatus(turn.status)
});

const normalizeDesktopTurnStatus = (status: unknown): unknown => {
  if (status === "running" || status === "active" || status === "in_progress") return "running";
  return status;
};

const applyShallowConversationPatch = (
  existing: Record<string, unknown>,
  change: Record<string, unknown>
): Record<string, unknown> => {
  const patch = objectRecord(change.patch ?? change.conversationState ?? change.state);
  return Object.keys(patch).length > 0 ? { ...existing, ...patch } : existing;
};
