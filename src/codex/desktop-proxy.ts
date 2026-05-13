import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import type { Logger } from "../logger.js";
import { buildUserInput, toTaskStatus } from "./protocol.js";
import type { CodexLocalImageAttachment } from "./protocol.js";
import type { CodexThreadSummary, CodexModelSummary } from "./client.js";

export interface DesktopProxyClientEvents {
  notification: [message: Record<string, unknown>];
  serverRequest: [message: Record<string, unknown>];
  error: [error: Error];
}

export interface DesktopProxyClientOptions {
  command: string;
}

export interface DesktopProxyExecutionReadiness {
  usable: boolean;
  authMethod: string | null;
  requiresOpenaiAuth: boolean | null;
  accountType: string | null;
  accountEmail: string | null;
  reason: string | null;
  raw: {
    authStatus: Record<string, unknown>;
    account: Record<string, unknown> | null;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  method: string;
}

export class DesktopProxyClient extends EventEmitter<DesktopProxyClientEvents> {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private lastError: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly serverRequestIds = new Set<string>();
  private nextRequestNumber = 1;
  private stdoutBuffer = "";

  constructor(
    private readonly options: DesktopProxyClientOptions,
    private readonly logger: Logger
  ) {
    super();
  }

  get status(): "connected" | "disconnected" | "not_started" | "error" {
    if (!this.proc) return this.lastError ? "error" : "not_started";
    if (this.proc.killed || this.proc.exitCode !== null) return this.lastError ? "error" : "disconnected";
    return this.initialized ? "connected" : "disconnected";
  }

  async start(): Promise<void> {
    if (this.status === "connected") return;
    await this.stop();
    this.lastError = null;
    const proc = this.spawnProxyProcess();
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    proc.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
    proc.on("error", (error) => this.handleProcessError(error));
    proc.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.handleProcessError(error, false);
    });
    const initResult = await this.request("initialize", {
      clientInfo: {
        name: "feishu-codex-bridge",
        title: "Feishu Codex Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: []
      }
    });
    await this.notify("initialized");
    this.initialized = true;
    const init = asRecord(initResult);
    this.logger.info("codex desktop proxy transport ready", {
      mode: "desktop_proxy",
      command: this.options.command,
      codexHome: typeof init.codexHome === "string" ? init.codexHome : null,
      platformOs: typeof init.platformOs === "string" ? init.platformOs : null
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("codex desktop proxy stopped"));
    }
    this.pending.clear();
    this.serverRequestIds.clear();
    this.stdoutBuffer = "";
    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.killed) {
        resolve();
        return;
      }
      proc.once("exit", () => resolve());
      proc.kill();
      setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
        resolve();
      }, 500).unref();
    });
  }

  async listThreads(limit: number): Promise<CodexThreadSummary[]> {
    const result = await this.request("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: false
    });
    const threadsRaw = asRecord(result).data;
    const threads = Array.isArray(threadsRaw) ? threadsRaw : [];
    return threads.map((thread) => normalizeThread(thread));
  }

  async readThread(threadId: string, includeTurns = true): Promise<Record<string, unknown>> {
    const result = await this.request("thread/read", { threadId, includeTurns });
    return asRecord(result);
  }

  async startThread(params: {
    cwd?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    prompt?: string | null;
    attachments?: CodexLocalImageAttachment[];
    approvalPolicy: string;
    sandboxMode: string;
    serviceName: string;
  }): Promise<CodexThreadSummary> {
    const result = await this.request("thread/start", {
      cwd: params.cwd ?? null,
      model: params.model ?? null,
      approvalPolicy: params.approvalPolicy,
      sandbox: params.sandboxMode,
      serviceName: params.serviceName,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    }, 180000);
    const thread = asRecord(asRecord(result).thread);
    let summary = normalizeThread(thread);
    const prompt = (params.prompt ?? "").trim();
    if (prompt && summary.id) {
      const title = deriveThreadTitle(prompt);
      if (title) {
        await this.setThreadName(summary.id, title).catch((error) => {
          this.logger.warn("failed to set desktop proxy thread title after creation", {
            threadId: summary.id,
            error: String(error)
          });
        });
      }
      await this.startTurn(summary.id, prompt, {
        cwd: params.cwd ?? undefined,
        model: params.model ?? null,
        reasoningEffort: params.reasoningEffort ?? null,
        approvalPolicy: params.approvalPolicy,
        sandboxPolicy: sandboxPolicyFromMode(params.sandboxMode),
        attachments: params.attachments ?? []
      }).catch((error) => {
        this.logger.warn("failed to start desktop proxy first turn after thread creation", {
          threadId: summary.id,
          error: String(error)
        });
      });
      const detail = await this.readThread(summary.id, false).catch(() => null);
      if (detail?.thread && typeof detail.thread === "object") {
        summary = normalizeThread(detail.thread);
      }
    }
    return summary;
  }

  async resumeThread(threadId: string): Promise<CodexThreadSummary> {
    const result = await this.request("thread/resume", {
      threadId,
      persistExtendedHistory: true
    });
    return normalizeThread(asRecord(asRecord(result).thread));
  }

  async listModels(limit = 20): Promise<CodexModelSummary[]> {
    const result = await this.request("model/list", { limit });
    const modelsRaw = asRecord(result).data;
    const models = Array.isArray(modelsRaw) ? modelsRaw : [];
    return models
      .map((entry) => asRecord(entry))
      .map((model: Record<string, unknown>) => ({
        id: String(model.id ?? model.name ?? ""),
        model: String(model.id ?? model.name ?? ""),
        displayName: typeof model.displayName === "string" ? model.displayName : String(model.id ?? model.name ?? ""),
        defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.filter((entry: unknown): entry is string => typeof entry === "string")
          : [],
        isDefault: Boolean(model.isDefault)
      }))
      .slice(0, Math.max(1, limit));
  }

  async getExecutionReadiness(): Promise<DesktopProxyExecutionReadiness> {
    const authStatus = asRecord(
      await this.request("getAuthStatus", {
        includeToken: false,
        refreshToken: false
      }, 30000)
    );
    const accountResult = asRecord(
      await this.request("account/read", {
        refreshToken: false
      }, 30000).catch((error) => {
        this.logger.warn("desktop proxy account/read probe failed", { error: String(error) });
        return {};
      })
    );
    const account = asNullableRecord(accountResult.account);
    const authMethod = typeof authStatus.authMethod === "string" ? authStatus.authMethod : null;
    const requiresOpenaiAuth = typeof authStatus.requiresOpenaiAuth === "boolean" ? authStatus.requiresOpenaiAuth : null;
    const accountType = typeof account?.type === "string" ? account.type : null;
    const accountEmail = typeof account?.email === "string" ? account.email : null;

    let usable = true;
    let reason: string | null = null;
    if (requiresOpenaiAuth === true) {
      const satisfiesOpenaiAuth =
        authMethod === "chatgpt" ||
        authMethod === "chatgptAuthTokens" ||
        authMethod === "agentIdentity" ||
        accountType === "chatgpt";
      usable = satisfiesOpenaiAuth;
      if (!usable) {
        reason = authMethod === "apikey" || accountType === "apiKey"
          ? "current app-server transport only has API key style auth, but the configured provider requires OpenAI account auth"
          : "configured provider requires OpenAI account auth, but app-server has no usable account login state";
      }
    }

    return {
      usable,
      authMethod,
      requiresOpenaiAuth,
      accountType,
      accountEmail,
      reason,
      raw: {
        authStatus,
        account
      }
    };
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
    const result = await this.request("turn/start", {
      threadId,
      input: buildUserInput(text, options.attachments ?? []),
      cwd: options.cwd ?? null,
      approvalPolicy: options.approvalPolicy,
      sandboxPolicy: options.sandboxPolicy,
      model: options.model ?? null,
      effort: options.reasoningEffort ?? null
    }, 180000);
    return asRecord(result);
  }

  async steerTurn(threadId: string, text: string, attachments: CodexLocalImageAttachment[] = []): Promise<Record<string, unknown>> {
    const activeTurnId = await this.findActiveTurnId(threadId);
    if (!activeTurnId) {
      throw new Error(`Desktop proxy cannot steer thread without an active turn: ${threadId}`);
    }
    const result = await this.request("turn/steer", {
      threadId,
      input: buildUserInput(text, attachments),
      expectedTurnId: activeTurnId
    }, 120000);
    return asRecord(result);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    const result = await this.request("turn/interrupt", { threadId, turnId }, 60000);
    return asRecord(result);
  }

  async archiveThread(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/archive", { threadId }, 60000);
    return asRecord(result);
  }

  async unarchiveThread(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/unarchive", { threadId }, 60000);
    return asRecord(result);
  }

  async setThreadName(threadId: string, name: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/name/set", { threadId, name }, 60000);
    return asRecord(result);
  }

  async setThreadGoal(threadId: string, objective: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/goal/set", { threadId, objective, status: "active" }, 60000);
    return asRecord(result);
  }

  async clearThreadGoal(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/goal/clear", { threadId }, 60000);
    return asRecord(result);
  }

  async compactThread(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/compact/start", { threadId }, 120000);
    return asRecord(result);
  }

  async listLoadedThreads(limit = 100): Promise<string[]> {
    const result = await this.request("thread/loaded/list", { limit });
    const dataRaw = asRecord(result).data;
    const data = Array.isArray(dataRaw) ? dataRaw : [];
    return data.filter((entry: unknown): entry is string => typeof entry === "string" && entry.length > 0);
  }

  async setCollaborationMode(threadId: string, collaborationMode: Record<string, unknown>): Promise<Record<string, unknown>> {
    throw new Error(
      `Desktop proxy does not expose a standalone collaboration-mode update in the current official schema for thread ${threadId}: ${JSON.stringify(collaborationMode)}`
    );
  }

  async editLastUserTurn(
    _threadId: string,
    _turnId: string,
    _message: string,
    _agentMode: string | null = null
  ): Promise<Record<string, unknown>> {
    throw new Error("Desktop proxy does not expose edit-last-user-turn through the official app-server schema.");
  }

  async submitUserInput(
    _threadId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await this.respondToServerRequest(requestId, response);
    return { ok: true };
  }

  async submitMcpServerElicitationResponse(
    _threadId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await this.respondToServerRequest(requestId, response);
    return { ok: true };
  }

  async respondToServerRequest(requestId: string | number, result: Record<string, unknown>): Promise<void> {
    const id = String(requestId);
    if (!this.serverRequestIds.has(id)) {
      throw new Error(`Unknown server request id: ${id}`);
    }
    this.serverRequestIds.delete(id);
    await this.respond({ id, result });
  }

  async respondErrorToServerRequest(requestId: string | number, error: { message: string; code?: number; data?: unknown }): Promise<void> {
    const id = String(requestId);
    if (!this.serverRequestIds.has(id)) {
      throw new Error(`Unknown server request id: ${id}`);
    }
    this.serverRequestIds.delete(id);
    await this.respond({ id, error: { code: error.code ?? -32000, message: error.message, data: error.data } });
  }

  private async findActiveTurnId(threadId: string): Promise<string | null> {
    const thread = asRecord((await this.readThread(threadId, true)).thread);
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = asRecord(turns[index]);
      const status = typeof turn.status === "string" ? turn.status : null;
      const turnId = typeof turn.id === "string" ? turn.id : typeof turn.turnId === "string" ? turn.turnId : null;
      if (turnId && (status === "running" || status === "active" || status === "in_progress")) {
        return turnId;
      }
    }
    return null;
  }

  private spawnProxyProcess(): ChildProcessWithoutNullStreams {
    const [file, ...baseArgs] = resolveCommandToSpawn(this.options.command);
    const args = [...baseArgs, "app-server"];
    return spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
  }

  private async request(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    await this.ensureStarted();
    const id = `${randomUUID()}-${this.nextRequestNumber++}`;
    const payload = { id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex Desktop app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
    });
    this.writeLine(payload);
    return promise;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    this.writeLine(params === undefined ? { method } : { method, params });
  }

  private async respond(payload: Record<string, unknown>): Promise<void> {
    await this.ensureStarted();
    this.writeLine(payload);
  }

  private writeLine(payload: Record<string, unknown>): void {
    const proc = this.proc;
    if (!proc || proc.stdin.destroyed) {
      throw new Error("Codex Desktop app-server process is not connected");
    }
    proc.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return;
    await this.start();
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn("failed to parse codex desktop app-server message", {
        line: line.slice(0, 500),
        error: String(error)
      });
      return;
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : null;
    if (id && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(errorText(message.error)));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && id) {
      this.serverRequestIds.add(id);
      this.emit("serverRequest", message);
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", message);
    }
  }

  private handleStderr(chunk: string): void {
    const text = chunk.trim();
    if (!text) return;
    this.logger.warn("codex desktop app-server stderr", { text });
  }

  private handleProcessError(error: Error, emit = true): void {
    this.lastError = error.message;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
    if (emit && this.listenerCount("error") > 0) {
      this.emit("error", error);
      return;
    }
    this.logger.warn("codex desktop app-server error without listener", { error: String(error) });
  }
}

const normalizeThread = (value: unknown): CodexThreadSummary => {
  const raw = asRecord(value);
  return {
    id: String(raw.id ?? ""),
    title: typeof raw.name === "string" ? raw.name : null,
    preview: typeof raw.preview === "string" ? raw.preview : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    status: toTaskStatus(raw.status),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt * 1000 : null,
    source: raw.source ?? null,
    agentNickname: typeof raw.agentNickname === "string" ? raw.agentNickname : null,
    agentRole: typeof raw.agentRole === "string" ? raw.agentRole : null,
    raw
  };
};

const deriveThreadTitle = (prompt: string): string => {
  const title = prompt.replace(/\s+/g, " ").trim();
  if (!title) return "";
  return title.slice(0, 80);
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

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asNullableRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const errorText = (value: unknown): string => {
  const error = asRecord(value);
  if (typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return JSON.stringify(value);
};

const commandToSpawn = (command: string): [string, ...string[]] => {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"(.*)"$/, "$1")) ?? [];
  if (parts.length === 0) {
    throw new Error("Desktop proxy command must not be empty");
  }
  return parts as [string, ...string[]];
};

const resolveCommandToSpawn = (command: string): [string, ...string[]] => {
  const parts = commandToSpawn(command);
  const executable = parts[0];
  if (!executable) {
    throw new Error("Desktop proxy command must not be empty");
  }
  if (process.platform !== "win32") {
    return parts;
  }
  const resolved = resolveWindowsCommand(executable);
  if (resolved) {
    return buildWindowsSpawnCommand(resolved, parts.slice(1));
  }
  return parts;
};

const buildWindowsSpawnCommand = (executable: string, args: string[]): [string, ...string[]] => {
  const lowered = executable.toLowerCase();
  if (lowered.endsWith(".cmd") || lowered.endsWith(".bat")) {
    return ["cmd.exe", "/d", "/s", "/c", executable, ...args];
  }
  if (lowered.endsWith(".ps1")) {
    return ["pwsh.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executable, ...args];
  }
  return [executable, ...args];
};

const resolveWindowsCommand = (command: string): string | null => {
  const explicit = resolveExplicitWindowsCommand(command);
  if (explicit) {
    return explicit;
  }
  return findCommandOnPath(command);
};

const resolveExplicitWindowsCommand = (command: string): string | null => {
  if (!looksLikeWindowsPath(command)) {
    return null;
  }
  const extensionCandidates = windowsCommandExtensionCandidates();
  for (const ext of extensionCandidates) {
    const candidate = command.endsWith(ext) ? command : `${command}${ext}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return existsSync(command) ? command : null;
};

const looksLikeWindowsPath = (command: string): boolean =>
  command.includes("\\") || command.includes("/") || /^[A-Za-z]:/.test(command);

const windowsCommandExtensionCandidates = (): string[] => {
  const values = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!values.includes(".ps1")) values.push(".ps1");
  return values;
};

const findCommandOnPath = (command: string): string | null => {
  const pathValue = process.env.PATH ?? "";
  const pathext = windowsCommandExtensionCandidates();
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of pathext) {
      const candidate = `${dir}\\${command}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
    const direct = `${dir}\\${command}`;
    if (existsSync(direct)) return direct;
  }
  return null;
};
