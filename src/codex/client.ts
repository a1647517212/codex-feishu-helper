import { EventEmitter } from "node:events";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { toTaskStatus } from "./protocol.js";
import type { CodexLocalImageAttachment } from "./protocol.js";
import { DesktopIpcClient } from "./desktop-ipc.js";
import { DesktopProxyClient, type DesktopProxyExecutionReadiness } from "./desktop-proxy.js";

type CodexConnectionKind = "desktop_ipc" | "desktop_proxy";

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

export interface CodexExecutionReadiness {
  usable: boolean;
  connectionKind: CodexConnectionKind | "not_started" | "unknown";
  reason: string | null;
  authMethod: string | null;
  requiresOpenaiAuth: boolean | null;
  accountType: string | null;
  accountEmail: string | null;
  raw: Record<string, unknown>;
}

export class CodexClient extends EventEmitter<CodexClientEvents> {
  private desktopIpc: DesktopIpcClient | null = null;
  private desktopProxy: DesktopProxyClient | null = null;
  private activeConnectionKind: CodexConnectionKind | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {
    super();
  }

  get status(): "connected" | "disconnected" | "not_started" | "error" {
    return this.desktopIpc?.status ?? this.desktopProxy?.status ?? "not_started";
  }

  get connectionKind(): CodexConnectionKind | "not_started" | "unknown" {
    return this.activeConnectionKind ?? (this.desktopIpc || this.desktopProxy ? "unknown" : "not_started");
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

  get desktopProxySnapshot(): {
    command: string;
    status: "connected" | "disconnected" | "not_started" | "error";
  } | null {
    return this.desktopProxy
      ? {
          command: this.config.codex.desktopProxyCommand,
          status: this.desktopProxy.status
        }
      : null;
  }

  async start(): Promise<void> {
    if (this.status === "connected") return;
    await this.stop();
    if (this.shouldTryDesktopProxyFirst()) {
      try {
        await this.startDesktopProxy();
        return;
      } catch (error) {
        if (!this.canFallbackToDesktopIpc()) throw error;
        this.logger.warn("codex desktop proxy transport unavailable, falling back to desktop ipc", {
          mode: this.config.codex.connectionMode,
          command: this.config.codex.desktopProxyCommand,
          error: String(error)
        });
      }
    }
    await this.startDesktopIpc();
  }

  async stop(): Promise<void> {
    await this.desktopIpc?.stop();
    await this.desktopProxy?.stop();
    this.desktopIpc = null;
    this.desktopProxy = null;
    this.activeConnectionKind = null;
  }

  async listThreads(limit: number): Promise<CodexThreadSummary[]> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().listThreads(limit);
    }
    return this.getStartedDesktopIpc().listThreads(limit);
  }

  async readThread(threadId: string, includeTurns = true): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().readThread(threadId, includeTurns);
    }
    return this.getStartedDesktopIpc().readThread(threadId);
  }

  async startThread(params: {
    cwd?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    prompt?: string | null;
    attachments?: CodexLocalImageAttachment[];
  } = {}): Promise<CodexThreadSummary> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().startThread({
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
    return this.getStartedDesktopIpc().startThread({
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
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().resumeThread(threadId);
    }
    const desktopIpc = this.getStartedDesktopIpc();
    return desktopIpc.listThreads(200).find((thread) => thread.id === threadId) ?? normalizeThread(desktopIpc.readThread(threadId).thread);
  }

  async listModels(limit = 20): Promise<CodexModelSummary[]> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().listModels(limit);
    }
    return [{
      id: this.config.codex.defaultModel,
      model: this.config.codex.defaultModel,
      displayName: this.config.codex.defaultModel,
      defaultReasoningEffort: this.config.codex.defaultReasoningEffort,
      supportedReasoningEfforts: [this.config.codex.defaultReasoningEffort],
      isDefault: true
    }];
  }

  async getExecutionReadiness(): Promise<CodexExecutionReadiness> {
    if (await this.usesDesktopProxy()) {
      const readiness: DesktopProxyExecutionReadiness = await this.getStartedDesktopProxy().getExecutionReadiness();
      return {
        usable: readiness.usable,
        connectionKind: "desktop_proxy",
        reason: readiness.reason,
        authMethod: readiness.authMethod,
        requiresOpenaiAuth: readiness.requiresOpenaiAuth,
        accountType: readiness.accountType,
        accountEmail: readiness.accountEmail,
        raw: readiness.raw
      };
    }
    return {
      usable: true,
      connectionKind: this.activeConnectionKind ?? "unknown",
      reason: null,
      authMethod: null,
      requiresOpenaiAuth: null,
      accountType: null,
      accountEmail: null,
      raw: {}
    };
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
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().startTurn(threadId, text, {
        cwd: options.cwd ?? undefined,
        model: options.model ?? this.config.codex.defaultModel,
        reasoningEffort: options.reasoningEffort ?? this.config.codex.defaultReasoningEffort,
        approvalPolicy: this.config.codex.defaultApprovalPolicy,
        sandboxPolicy: sandboxPolicyFromMode(this.config.codex.defaultSandboxMode),
        attachments: options.attachments ?? []
      });
    }
    return this.getStartedDesktopIpc().startTurn(threadId, text, {
      cwd: options.cwd ?? undefined,
      model: options.model ?? this.config.codex.defaultModel,
      reasoningEffort: options.reasoningEffort ?? this.config.codex.defaultReasoningEffort,
      approvalPolicy: this.config.codex.defaultApprovalPolicy,
      sandboxPolicy: sandboxPolicyFromMode(this.config.codex.defaultSandboxMode),
      attachments: options.attachments ?? []
    });
  }

  async steerTurn(threadId: string, text: string, attachments: CodexLocalImageAttachment[] = []): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().steerTurn(threadId, text, attachments);
    }
    return this.getStartedDesktopIpc().steerTurn(threadId, text, attachments);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().interruptTurn(threadId, turnId);
    }
    return this.getStartedDesktopIpc().interruptTurn(threadId, turnId);
  }

  async archiveThread(threadId: string): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().archiveThread(threadId);
    }
    return this.getStartedDesktopIpc().archiveThread(threadId);
  }

  async unarchiveThread(threadId: string): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().unarchiveThread(threadId);
    }
    return this.getStartedDesktopIpc().unarchiveThread(threadId);
  }

  async setThreadName(threadId: string, name: string): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().setThreadName(threadId, name);
    }
    return this.getStartedDesktopIpc().setThreadName(threadId, name);
  }

  async setThreadGoal(threadId: string, objective: string): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().setThreadGoal(threadId, objective);
    }
    return this.getStartedDesktopIpc().setThreadGoal(threadId, objective);
  }

  async clearThreadGoal(threadId: string): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().clearThreadGoal(threadId);
    }
    return this.getStartedDesktopIpc().clearThreadGoal(threadId);
  }

  async compactThread(threadId: string): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().compactThread(threadId);
    }
    return this.getStartedDesktopIpc().compactThread(threadId);
  }

  async setCollaborationMode(threadId: string, collaborationMode: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().setCollaborationMode(threadId, collaborationMode);
    }
    return this.getStartedDesktopIpc().setCollaborationMode(threadId, collaborationMode);
  }

  async editLastUserTurn(
    threadId: string,
    turnId: string,
    message: string,
    agentMode: string | null = null
  ): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().editLastUserTurn(threadId, turnId, message, agentMode);
    }
    return this.getStartedDesktopIpc().editLastUserTurn(threadId, turnId, message, agentMode);
  }

  async submitUserInput(
    threadId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().submitUserInput(threadId, requestId, response);
    }
    return this.getStartedDesktopIpc().submitUserInput(threadId, requestId, response);
  }

  async submitMcpServerElicitationResponse(
    threadId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().submitMcpServerElicitationResponse(threadId, requestId, response);
    }
    return this.getStartedDesktopIpc().submitMcpServerElicitationResponse(threadId, requestId, response);
  }

  async listLoadedThreads(limit = 100): Promise<string[]> {
    if (await this.usesDesktopProxy()) {
      return this.getStartedDesktopProxy().listLoadedThreads(limit);
    }
    return this.getStartedDesktopIpc().listThreads(limit).map((thread) => thread.id);
  }

  async respondToServerRequest(requestId: string | number, result: Record<string, unknown>): Promise<void> {
    if (await this.usesDesktopProxy()) {
      await this.getStartedDesktopProxy().respondToServerRequest(requestId, result);
      return;
    }
    await this.getStartedDesktopIpc().respondToServerRequest(requestId, result);
  }

  async respondErrorToServerRequest(requestId: string | number, error: { message: string; code?: number; data?: unknown }): Promise<void> {
    if (await this.usesDesktopProxy()) {
      await this.getStartedDesktopProxy().respondErrorToServerRequest(requestId, error);
      return;
    }
    await this.getStartedDesktopIpc().respondErrorToServerRequest(requestId, error);
  }

  private shouldTryDesktopProxyFirst(): boolean {
    return this.config.codex.connectionMode === "desktop_proxy" || this.config.codex.connectionMode === "desktop_auto";
  }

  private canFallbackToDesktopIpc(): boolean {
    return (
      this.config.codex.connectionMode === "desktop_auto" ||
      this.config.codex.connectionMode === "desktop_ipc" ||
      this.config.codex.connectionMode === "desktop_proxy"
    );
  }

  private async startDesktopProxy(): Promise<void> {
    const client = new DesktopProxyClient(
      {
        command: this.config.codex.desktopProxyCommand
      },
      this.logger
    );
    client.on("notification", (message) => this.emit("notification", message));
    client.on("serverRequest", (message) => this.emit("serverRequest", message));
    client.on("error", (error) => this.handleClientError(error));
    this.desktopProxy = client;
    this.activeConnectionKind = "desktop_proxy";
    try {
      await client.start();
    } catch (error) {
      this.desktopProxy = null;
      this.activeConnectionKind = null;
      throw error;
    }
  }

  private async startDesktopIpc(): Promise<void> {
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

  private async usesDesktopProxy(): Promise<boolean> {
    await this.start();
    return this.activeConnectionKind === "desktop_proxy";
  }

  private getStartedDesktopIpc(): DesktopIpcClient {
    if (!this.desktopIpc) throw new Error("desktop_ipc transport did not start");
    return this.desktopIpc;
  }

  private getStartedDesktopProxy(): DesktopProxyClient {
    if (!this.desktopProxy) throw new Error("desktop_proxy transport did not start");
    return this.desktopProxy;
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
