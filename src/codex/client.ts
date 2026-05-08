import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { CodexProtocolGuard, textInput, toTaskStatus, type JsonRpcMessage, type JsonRpcResponse } from "./protocol.js";

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
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private requestId = 1;
  private pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: NodeJS.Timeout }
  >();
  private initialized = false;
  private activeConnectionKind: "desktop_proxy" | "standalone" | null = null;
  private readonly guard = new CodexProtocolGuard();

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {
    super();
  }

  get status(): "connected" | "disconnected" | "not_started" | "error" {
    if (!this.proc) return "not_started";
    if (this.proc.exitCode != null) return "disconnected";
    return this.initialized ? "connected" : "disconnected";
  }

  get connectionKind(): "desktop_proxy" | "standalone" | "not_started" | "unknown" {
    return this.activeConnectionKind ?? (this.proc ? "unknown" : "not_started");
  }

  async start(): Promise<void> {
    if (this.proc && this.proc.exitCode == null) return;
    const modes = this.connectionStartModes();
    let lastError: unknown = null;
    for (const mode of modes) {
      try {
        await this.startWithArgs(mode.kind, mode.args);
        return;
      } catch (error) {
        lastError = error;
        await this.stopProcessOnly();
        this.logger.warn("codex app-server start attempt failed", {
          mode: mode.kind,
          args: mode.args,
          error: String(error)
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "codex app-server start failed"));
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.rl?.close();
    this.proc.kill();
    this.proc = null;
    this.initialized = false;
    this.activeConnectionKind = null;
  }

  async listThreads(limit: number, options: { pageSize?: number; maxPages?: number } = {}): Promise<CodexThreadSummary[]> {
    const target = Math.max(1, limit);
    const pageSize = Math.max(1, Math.min(options.pageSize ?? target, target, 50));
    const maxPages = Math.max(1, options.maxPages ?? Math.ceil(target / pageSize));
    const threads: CodexThreadSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages && threads.length < target; page++) {
      const result = await this.request("thread/list", {
        limit: Math.min(pageSize, target - threads.length),
        cursor,
        archived: false,
        sortKey: "updated_at",
        sortDirection: "desc"
      });
      const response = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const data = Array.isArray(response.data) ? response.data : [];
      threads.push(...data.map((thread) => normalizeThread(thread)));
      cursor = typeof response.nextCursor === "string" && response.nextCursor.length > 0 ? response.nextCursor : null;
      if (!cursor || data.length === 0) break;
    }
    return threads.slice(0, target);
  }

  async readThread(threadId: string, includeTurns = true): Promise<Record<string, unknown>> {
    const result = await this.request("thread/read", { threadId, includeTurns });
    return result as Record<string, unknown>;
  }

  async startThread(params: { cwd?: string | null; model?: string | null; reasoningEffort?: string | null } = {}): Promise<CodexThreadSummary> {
    const result = await this.request("thread/start", {
      model: params.model ?? this.config.codex.defaultModel,
      cwd: params.cwd ?? null,
      approvalPolicy: this.config.codex.defaultApprovalPolicy,
      sandbox: this.config.codex.defaultSandboxMode,
      config: {
        model_reasoning_effort: params.reasoningEffort ?? this.config.codex.defaultReasoningEffort
      },
      serviceName: this.config.codex.serviceName,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    return normalizeThread((result as { thread?: unknown }).thread);
  }

  async resumeThread(threadId: string): Promise<CodexThreadSummary> {
    const result = await this.request("thread/resume", { threadId });
    return normalizeThread((result as { thread?: unknown }).thread);
  }

  async listModels(limit = 20): Promise<CodexModelSummary[]> {
    const result = await this.request("model/list", { limit });
    const response = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    const data = Array.isArray(response.data) ? response.data : [];
    return data.map((entry) => normalizeModel(entry));
  }

  async startTurn(
    threadId: string,
    text: string,
    options: { cwd?: string | null; model?: string | null; reasoningEffort?: string | null } = {}
  ): Promise<Record<string, unknown>> {
    const result = await this.request("turn/start", {
      threadId,
      input: [textInput(text)],
      cwd: options.cwd ?? undefined,
      model: options.model ?? undefined,
      effort: options.reasoningEffort ?? this.config.codex.defaultReasoningEffort,
      approvalPolicy: this.config.codex.defaultApprovalPolicy,
      sandboxPolicy: sandboxPolicyFromMode(this.config.codex.defaultSandboxMode)
    });
    return result as Record<string, unknown>;
  }

  async steerTurn(threadId: string, text: string): Promise<Record<string, unknown>> {
    const result = await this.request("turn/steer", { threadId, input: [textInput(text)] });
    return result as Record<string, unknown>;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    const result = await this.request("turn/interrupt", { threadId, turnId });
    return result as Record<string, unknown>;
  }

  async archiveThread(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/archive", { threadId });
    return result as Record<string, unknown>;
  }

  async unarchiveThread(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/unarchive", { threadId });
    return result as Record<string, unknown>;
  }

  async setThreadName(threadId: string, name: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/name/set", { threadId, name });
    return result as Record<string, unknown>;
  }

  async listLoadedThreads(limit = 100): Promise<string[]> {
    const result = await this.request("thread/loaded/list", { limit });
    const response = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    return Array.isArray(response.data) ? response.data.filter((entry): entry is string => typeof entry === "string") : [];
  }

  async respondToServerRequest(requestId: string | number, result: Record<string, unknown>): Promise<void> {
    this.send({ id: requestId, result });
  }

  async request(method: string, params?: unknown, timeoutMs = 120000): Promise<unknown> {
    await this.start();
    this.guard.validateClientMethod(method);
    const id = this.requestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.send({ id, method, params });
    return promise;
  }

  private connectionStartModes(): Array<{ kind: "desktop_proxy" | "standalone"; args: string[] }> {
    const mode = this.config.codex.connectionMode;
    const proxy = { kind: "desktop_proxy" as const, args: this.config.codex.proxyArgs };
    const standalone = { kind: "standalone" as const, args: this.config.codex.args };
    if (mode === "desktop_proxy") return [proxy];
    if (mode === "standalone") return [standalone];
    return [proxy, standalone];
  }

  private async startWithArgs(kind: "desktop_proxy" | "standalone", args: string[]): Promise<void> {
    this.proc = spawn(this.config.codex.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });
    this.activeConnectionKind = kind;
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.logger.warn("codex app-server stderr", { mode: kind, text: chunk.toString("utf8") });
    });
    this.proc.on("exit", (code, signal) => {
      this.initialized = false;
      this.activeConnectionKind = null;
      this.rejectAll(new Error(`codex app-server exited: code=${code} signal=${signal}`));
      this.logger.warn("codex app-server exited", { mode: kind, code, signal });
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    await this.initialize();
    this.logger.info("codex app-server connected", { mode: kind, args });
  }

  private async initialize(): Promise<void> {
    const initializeResult = await this.rawRequest("initialize", {
      clientInfo: {
        name: "feishu_codex_bridge",
        title: "Feishu Codex Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: this.config.codex.experimentalApi
      }
    });
    this.send({ method: "initialized", params: {} });
    this.initialized = true;
    this.logger.info("codex app-server initialized", {
      result: initializeResult
    });
  }

  private rawRequest(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    const id = this.requestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.send({ id, method, params });
    return promise;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.proc || this.proc.exitCode != null) {
      throw new Error("codex app-server is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.logger.warn("failed to parse codex app-server line", { line, error: String(error) });
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }
    if ("id" in message && "method" in message) {
      this.emit("serverRequest", message as unknown as Record<string, unknown>);
      return;
    }
    if ("method" in message) {
      this.emit("notification", message as unknown as Record<string, unknown>);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
    } else {
      this.logger.warn("codex client error without listener", { error: String(error) });
    }
  }

  private async stopProcessOnly(): Promise<void> {
    if (!this.proc) return;
    this.rl?.close();
    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    this.activeConnectionKind = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("codex app-server start attempt failed"));
      this.pending.delete(id);
    }
    proc.kill();
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

const normalizeModel = (value: unknown): CodexModelSummary => {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const supported = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
        .map((entry) => {
          if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).reasoningEffort === "string") {
            return String((entry as Record<string, unknown>).reasoningEffort);
          }
          return null;
        })
        .filter((entry): entry is string => Boolean(entry))
    : [];
  return {
    id: String(raw.id ?? raw.model ?? ""),
    model: String(raw.model ?? raw.id ?? ""),
    displayName: typeof raw.displayName === "string" ? raw.displayName : String(raw.model ?? raw.id ?? ""),
    defaultReasoningEffort: typeof raw.defaultReasoningEffort === "string" ? raw.defaultReasoningEffort : null,
    supportedReasoningEfforts: supported,
    isDefault: raw.isDefault === true
  };
};
