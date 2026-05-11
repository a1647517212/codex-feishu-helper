import { EventEmitter } from "node:events";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { toTaskStatus } from "./protocol.js";
import type { CodexLocalImageAttachment } from "./protocol.js";
import { DesktopIpcClient } from "./desktop-ipc.js";

type CodexConnectionKind = "desktop_ipc";

export interface CodexThreadSummary {
  id: string;
  title: string | null;
  preview: string | null;
  cwd: string | null;
  status: ReturnType<typeof toTaskStatus>;
  updatedAt: number | null;
  source: unknown;
  agentNickname: string | null;
  agentRole: string | null;
  raw: Record<string, unknown>;
}

export interface CodexClientEvents {
  notification: [message: Record<string, unknown>];
  serverRequest: [message: Record<string, unknown>];
  error: [error: Error];
}

export interface CodexModelSummary {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[];
  isDefault: boolean;
}

export class CodexClient extends EventEmitter<CodexClientEvents> {
  private desktopIpc: DesktopIpcClient | null = null;
  private activeConnectionKind: CodexConnectionKind | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {
    super();
  }

  get status(): "connected" | "disconnected" | "not_started" | "error" {
    return this.desktopIpc?.status ?? "not_started";
  }

  get connectionKind(): CodexConnectionKind | "not_started" | "unknown" {
    return this.activeConnectionKind ?? (this.desktopIpc ? "unknown" : "not_started");
  }

  get desktopIpcSnapshot(): {
    pipePath: string;
    status: "connected" | "disconnected" | "not_started" | "error";
    clientId: string | null;
    observedThreads: number;
  } | null {
    return this.desktopIpc
      ? {
          pipePath: this.config.codex.desktopIpcPipePath,
          status: this.desktopIpc.status,
          clientId: this.desktopIpc.connectedClientId,
          observedThreads: this.desktopIpc.snapshotCount
        }
      : null;
  }

  async start(): Promise<void> {
    if (this.status === "connected") return;
    await this.stop();
    const client = new DesktopIpcClient(
      {
        pipePath: this.config.codex.desktopIpcPipePath,
        initialSnapshotWaitMs: this.config.codex.desktopIpcInitialSnapshotWaitMs,
        serviceName: this.config.codex.serviceName
      },
      this.logger
    );
    client.on("notification", (message) => this.emit("notification", message));
    client.on("serverRequest", (message) => this.emit("serverRequest", message));
    client.on("error", (error) => this.handleClientError(error));
    this.desktopIpc = client;
    this.activeConnectionKind = "desktop_ipc";
    try {
      await client.start();
      this.logger.info("codex desktop ipc transport ready", {
        mode: "desktop_ipc",
        pipePath: this.config.codex.desktopIpcPipePath,
        observedThreads: client.snapshotCount
      });
    } catch (error) {
      this.desktopIpc = null;
      this.activeConnectionKind = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.desktopIpc?.stop();
    this.desktopIpc = null;
    this.activeConnectionKind = null;
  }

  async listThreads(limit: number): Promise<CodexThreadSummary[]> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.listThreads(limit);
  }

  async readThread(threadId: string, _includeTurns = true): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.readThread(threadId);
  }

  async startThread(params: {
    cwd?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    prompt?: string | null;
    attachments?: CodexLocalImageAttachment[];
  } = {}): Promise<CodexThreadSummary> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.startThread({
      prompt: params.prompt ?? "",
      attachments: params.attachments ?? [],
      cwd: params.cwd ?? null,
      model: params.model ?? this.config.codex.defaultModel,
      reasoningEffort: params.reasoningEffort ?? this.config.codex.defaultReasoningEffort,
      approvalPolicy: this.config.codex.defaultApprovalPolicy,
      sandboxMode: this.config.codex.defaultSandboxMode,
      serviceName: this.config.codex.serviceName
    });
  }

  async resumeThread(threadId: string): Promise<CodexThreadSummary> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.listThreads(200).find((thread) => thread.id === threadId) ?? normalizeThread(desktopIpc.readThread(threadId).thread);
  }

  async listModels(_limit = 20): Promise<CodexModelSummary[]> {
    return [{
      id: this.config.codex.defaultModel,
      model: this.config.codex.defaultModel,
      displayName: this.config.codex.defaultModel,
      defaultReasoningEffort: this.config.codex.defaultReasoningEffort,
      supportedReasoningEfforts: [this.config.codex.defaultReasoningEffort],
      isDefault: true
    }];
  }

  async startTurn(
    threadId: string,
    text: string,
    options: {
      cwd?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
      attachments?: CodexLocalImageAttachment[];
    } = {}
  ): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.startTurn(threadId, text, {
      cwd: options.cwd ?? undefined,
      model: options.model ?? this.config.codex.defaultModel,
      reasoningEffort: options.reasoningEffort ?? this.config.codex.defaultReasoningEffort,
      approvalPolicy: this.config.codex.defaultApprovalPolicy,
      sandboxPolicy: sandboxPolicyFromMode(this.config.codex.defaultSandboxMode),
      attachments: options.attachments ?? []
    });
  }

  async steerTurn(threadId: string, text: string, attachments: CodexLocalImageAttachment[] = []): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.steerTurn(threadId, text, attachments);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.interruptTurn(threadId, turnId);
  }

  async archiveThread(threadId: string): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.archiveThread(threadId);
  }

  async unarchiveThread(threadId: string): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.unarchiveThread(threadId);
  }

  async setThreadName(threadId: string, name: string): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.setThreadName(threadId, name);
  }

  async setThreadGoal(threadId: string, objective: string): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.setThreadGoal(threadId, objective);
  }

  async clearThreadGoal(threadId: string): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.clearThreadGoal(threadId);
  }

  async compactThread(threadId: string): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.compactThread(threadId);
  }

  async setCollaborationMode(threadId: string, collaborationMode: Record<string, unknown>): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.setCollaborationMode(threadId, collaborationMode);
  }

  async editLastUserTurn(
    threadId: string,
    turnId: string,
    message: string,
    agentMode: string | null = null
  ): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.editLastUserTurn(threadId, turnId, message, agentMode);
  }

  async submitUserInput(
    threadId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.submitUserInput(threadId, requestId, response);
  }

  async submitMcpServerElicitationResponse(
    threadId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.submitMcpServerElicitationResponse(threadId, requestId, response);
  }

  async listLoadedThreads(limit = 100): Promise<string[]> {
    const desktopIpc = await this.requireDesktopIpc();
    return desktopIpc.listThreads(limit).map((thread) => thread.id);
  }

  async respondToServerRequest(requestId: string | number, result: Record<string, unknown>): Promise<void> {
    const desktopIpc = await this.requireDesktopIpc();
    await desktopIpc.respondToServerRequest(requestId, result);
  }

  async respondErrorToServerRequest(requestId: string | number, error: { message: string; code?: number; data?: unknown }): Promise<void> {
    const desktopIpc = await this.requireDesktopIpc();
    await desktopIpc.respondErrorToServerRequest(requestId, error);
  }

  private async requireDesktopIpc(): Promise<DesktopIpcClient> {
    await this.start();
    if (!this.desktopIpc) throw new Error("desktop_ipc transport did not start");
    return this.desktopIpc;
  }

  private handleClientError(error: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
      return;
    }
    this.logger.warn("codex client error without listener", { error: String(error) });
  }
}

const normalizeThread = (value: unknown): CodexThreadSummary => {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    id: String(raw.id ?? ""),
    title: typeof raw.name === "string" ? raw.name : null,
    preview: typeof raw.preview === "string" ? raw.preview : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    status: toTaskStatus(raw.status),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
    source: raw.source ?? null,
    agentNickname: typeof raw.agentNickname === "string" ? raw.agentNickname : null,
    agentRole: typeof raw.agentRole === "string" ? raw.agentRole : null,
    raw
  };
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
