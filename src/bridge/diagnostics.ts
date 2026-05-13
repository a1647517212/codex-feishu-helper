import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { BridgeConfig } from "../config.js";
import type { DiagnosticSnapshot, FeishuChatDiagnostic } from "../core/types.js";
import type { CodexClient } from "../codex/client.js";
import { detectDesktopIpcCapabilities } from "../codex/desktop-ipc-capabilities.js";
import type { Repository } from "../db/repo.js";
import type { FeishuChatInfoProvider } from "../feishu/client.js";

const execFileAsync = promisify(execFile);
type RemoteControlSnapshot = NonNullable<DiagnosticSnapshot["codexRemoteControl"]>;

interface DiagnosticsRuntime {
  execCodex?: (command: string, args: string[]) => Promise<{ stdout?: string; stderr?: string }>;
  chatInfoTimeoutMs?: number;
}

export class DiagnosticsService {
  private readonly startedAt = Date.now();
  private lastError: string | null = null;
  private lastFeishuMessageAt: string | null = null;
  private lastFeishuMessageId: string | null = null;
  private lastFeishuCardActionAt: string | null = null;
  private lastFeishuCardAction: string | null = null;
  private lastFeishuCardActionId: string | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly repo: Repository,
    private readonly codex: CodexClient,
    private readonly feishu?: FeishuChatInfoProvider,
    private readonly runtime: DiagnosticsRuntime = {}
  ) {}

  recordError(error: unknown): void {
    this.lastError = String(error);
  }

  recordFeishuMessage(messageId: string): void {
    this.lastFeishuMessageAt = new Date().toISOString();
    this.lastFeishuMessageId = messageId;
  }

  recordFeishuCardAction(action: string, actionId: string): void {
    this.lastFeishuCardActionAt = new Date().toISOString();
    this.lastFeishuCardAction = action;
    this.lastFeishuCardActionId = actionId;
  }

  async snapshot(): Promise<DiagnosticSnapshot> {
    const devices = this.repo.listBridgeDevices(5);
    const currentDevice = devices.find((device) => device.id === this.config.machine.id) ?? null;
    const trustedSubjects = this.repo.listTrustedFeishuSubjects(5);
    const desktopIpcCapabilities = detectDesktopIpcCapabilities();
    const [codexAvailable, feishuDefaultChatDiagnostic, codexRemoteControl] = await Promise.all([
      this.isCodexAvailable(),
      this.defaultChatDiagnostic(),
      this.probeRemoteControl()
    ]);
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      machineName: this.config.machine.name || hostname(),
      platform: platform(),
      nodeVersion: process.version,
      codexCommand: this.config.codex.command,
      codexConnectionMode: this.config.codex.connectionMode,
      codexConnectionKind: this.codex.connectionKind,
      codexDesktopIpc: this.codex.desktopIpcSnapshot
        ? {
            ...this.codex.desktopIpcSnapshot,
            capabilities: desktopIpcCapabilities
          }
        : null,
      codexDesktopProxy: this.codex.desktopProxySnapshot,
      codexRemoteControl,
      codexAvailable,
      appServerStatus: this.codex.status,
      feishuConfigured: Boolean(this.config.feishu.appId && this.config.feishu.appSecret && this.config.feishu.defaultChatId),
      feishuMessageTransport: this.config.feishu.messageTransport,
      feishuCardActionTransport: this.config.feishu.cardActionTransport,
      feishuInteractionMode: this.config.feishu.interactionMode,
      feishuDefaultChatId: this.config.feishu.defaultChatId ?? null,
      feishuDefaultChatDiagnostic,
      feishuTaskContainerMode: this.config.feishu.taskContainerMode,
      databasePath: this.config.storage.databasePath,
      projectsCount: this.repo.count("projects"),
      sessionBindingsCount: this.repo.count("session_bindings"),
      runningTasksCount: this.repo.count("session_bindings", "status = 'running'"),
      pendingOutboxCount: this.repo.count("notification_outbox", "status = 'pending'"),
      pendingApprovalsCount: this.repo.count("pending_approvals", "status = 'pending'"),
      notificationPreferenceCount: this.repo.count("notification_preferences"),
      trustedSubjectsCount: this.repo.count("trusted_feishu_subjects"),
      bridgeDevicesCount: this.repo.count("bridge_devices"),
      currentDevice,
      trustedSubjects,
      lastFeishuMessageAt: this.lastFeishuMessageAt,
      lastFeishuMessageId: this.lastFeishuMessageId,
      lastFeishuCardActionAt: this.lastFeishuCardActionAt,
      lastFeishuCardAction: this.lastFeishuCardAction,
      lastFeishuCardActionId: this.lastFeishuCardActionId,
      lastError: this.lastError
    };
  }

  private async isCodexAvailable(): Promise<boolean> {
    try {
      await this.execCodex(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  static desktopProxyRecommendation(snapshot: DiagnosticSnapshot): string | null {
    if (snapshot.codexConnectionMode === "desktop_auto" && snapshot.codexConnectionKind === "desktop_proxy") {
      return "Desktop Auto 当前已走官方 App Server 直连路径；飞书新任务会创建真实 Desktop 线程并同步 thread title。普通飞书消息不会自动进入 goal 模式，只有 Codex 官方 `/goal` 指令或其它显式 goal 操作才会触发 goal。";
    }
    if (snapshot.codexConnectionMode !== "desktop_proxy") return null;
    if (snapshot.codexDesktopProxy?.status === "connected") {
      return "Desktop Proxy 已连接，飞书新任务应通过官方 Codex App Server 直连路径创建真实 Desktop 线程。";
    }
    return "Desktop Proxy 未连接。当前配置仍要求走官方 Codex App Server 直连主线；请先检查 `codex app-server` 是否能在本机直接启动，再根据需要查看 Remote Control 侧状态。";
  }

  static desktopIpcRecommendation(snapshot: DiagnosticSnapshot): string | null {
    const capabilities = snapshot.codexDesktopIpc?.capabilities ?? null;
    const followerOnly =
      capabilities?.supportsFollowerControl === true &&
      capabilities.supportsHostThreadCreation === false &&
      capabilities.supportsThreadGoal === false &&
      capabilities.supportsThreadTitle === false &&
      capabilities.supportsArchiveControl === false;
    if (snapshot.codexConnectionMode === "desktop_auto") {
      if (snapshot.codexConnectionKind === "desktop_proxy") return null;
      const lastError = snapshot.lastError ?? "";
      if (lastError.includes("no-client-found") || followerOnly) {
        return "Desktop Auto 当前已回退到 Desktop IPC，但普通 Codex Desktop 运行态没有可用的官方新线程 handler。当前可接管已打开线程；如果要从飞书直接新建对话，必须让自动模式回到官方 app-server 主线。";
      }
      return "Desktop Auto 当前已回退到 Desktop IPC；接管已打开线程可用。若飞书要稳定新建真实 Desktop 线程，必须恢复到官方 app-server 主线。";
    }
    if (snapshot.codexConnectionMode !== "desktop_ipc") return null;
    const lastError = snapshot.lastError ?? "";
    if (lastError.includes("no-client-found") || followerOnly) {
      return "Desktop IPC 已连接，但当前普通 Codex Desktop 运行态没有可用的官方新线程 handler。当前可接管已打开线程，但不能从飞书直接新建新对话。";
    }
    return "Desktop IPC 主要用于接管和继续已打开的普通 Desktop 线程。当前产品不支持通过飞书在 desktop_ipc 模式下直接新建新对话；如需新建真实 Desktop 线程，必须回到官方 app-server 主线。";
  }

  static remoteControlRecommendation(snapshot: DiagnosticSnapshot): string | null {
    const remoteControl = snapshot.codexRemoteControl;
    if (!remoteControl) return null;
    if (snapshot.codexConnectionMode === "desktop_auto" && snapshot.codexConnectionKind === "desktop_proxy") {
      return "Remote Control runtime 已就绪。这是并行能力，不是当前飞书新建线程 direct app-server 主线的前置条件。";
    }
    if (remoteControl.featureEnabled === false) {
      return "当前 Codex 配置里 `features.remote_control` 仍未开启；这会影响官方 Remote Control / proxy 侧诊断，但不是当前飞书新建线程 direct app-server 主线的前置条件。";
    }
    const localFeatureIssue = describeLocalFeatureIssue(remoteControl);
    if (remoteControl.loginAuthMode === "api_key") {
      return [
        localFeatureIssue,
        "当前 `codex login status` 仍是 API key 登录。Remote Control 很可能不会完成 enrollment。",
        remoteControl.cloudAccess === "disabled"
          ? "Desktop 全局状态里的 `codexCloudAccess` 也仍是 `disabled`，说明当前 Desktop UI 本身还没有进入可用的 Cloud access 状态。"
          : null,
        "如果后续还要排查官方 Remote Control / proxy 侧，再考虑 Desktop 内账户登录与相关开关。"
      ].filter(Boolean).join(" ");
    }
    if (remoteControl.loginAuthMode === "logged_out") {
      return [
        localFeatureIssue,
        "当前没有检测到可用的 Codex 账户登录态。",
        remoteControl.cloudAccess === "disabled"
          ? "Desktop 全局状态里的 `codexCloudAccess` 也仍是 `disabled`，这和当前未登录状态一致。"
          : null,
        "如果后续还要排查官方 Remote Control / proxy 侧，再考虑 Desktop 内账户登录与相关开关。"
      ].filter(Boolean).join(" ");
    }
    if (remoteControl.loginAuthMode === "account" && remoteControl.cloudAccess === "disabled") {
      return [
        localFeatureIssue,
        "当前 `codex login status` 看起来已有账户登录，但 Desktop 全局状态里的 `codexCloudAccess` 仍是 `disabled`。",
        "这说明 Desktop UI 侧并没有真正进入可用的 Cloud access 状态。",
        "在这个状态下，Remote Control 仍不会完成 enrollment，也不会产出 control socket。"
      ].filter(Boolean).join(" ");
    }
    if (localFeatureIssue) {
      return localFeatureIssue;
    }
    if (remoteControl.enrollmentCount === 0) {
      return [
        "Remote Control enrollment 仍为空。这只说明官方 Remote Control / proxy 侧还没有就绪。",
        remoteControl.cloudAccess ? `当前 Desktop 全局状态里的 codexCloudAccess = ${remoteControl.cloudAccess}。` : null,
        "如果后续还要排查该侧能力，再去处理 Desktop 内账户登录、相关开关和 control socket。"
      ].filter(Boolean).join(" ");
    }
    if (remoteControl.enrollmentCount && !remoteControl.controlSocketExists) {
      return "Remote Control 已有 enrollment，但 `app-server-control.sock` 仍未出现。这只影响官方 Remote Control / proxy 侧，不直接否定 direct app-server 主线。";
    }
    if (!remoteControl.controlSocketExists && (snapshot.codexConnectionMode === "desktop_proxy" || snapshot.codexConnectionMode === "desktop_auto")) {
      return "官方 Remote Control control socket 尚未出现；这只说明 Remote Control / proxy 侧仍不可用。";
    }
    if (snapshot.codexConnectionMode === "desktop_proxy" && snapshot.codexDesktopProxy?.status !== "connected") {
      return "Remote Control 前置条件基本已具备，但桥接当前还没有接上 direct app-server 主线；请先看 app-server 启动报错，再决定是否继续排查 Remote Control。";
    }
    if (snapshot.codexConnectionMode === "desktop_auto" && snapshot.codexConnectionKind !== "desktop_proxy" && remoteControl.controlSocketExists) {
      return "Remote Control control socket 已出现，但 desktop_auto 还没有切回官方 app-server 主线；请点击恢复连接或重启桥接。";
    }
    return null;
  }

  private async defaultChatDiagnostic(): Promise<FeishuChatDiagnostic | null> {
    const chatId = this.config.feishu.defaultChatId;
    if (!chatId || !this.feishu) return null;
    try {
      const chat = await withTimeout(
        this.feishu.getChatInfo(chatId),
        this.runtime.chatInfoTimeoutMs ?? 12000,
        "Feishu get chat info timed out"
      );
      const fullTopicMode = chat.chatMode === "topic" || chat.groupMessageType === "thread";
      const topicReplySupported = chat.chatMode === "group" || chat.chatMode === "topic" || chat.groupMessageType === "thread";
      return {
        ok: true,
        chatId,
        name: chat.name,
        chatMode: chat.chatMode,
        groupMessageType: chat.groupMessageType,
        topicReplySupported,
        fullTopicMode,
        recommendation: chatRecommendation(chat.chatMode, chat.groupMessageType, this.config.feishu.taskContainerMode),
        requiredScopes: this.config.feishu.taskContainerMode === "dedicated_chat"
          ? ["im:chat:readonly", "im:chat:create", "im:chat:update"]
          : ["im:chat:readonly"],
        error: null
      };
    } catch (error) {
      this.lastError = String(error);
      return {
        ok: false,
        chatId,
        name: null,
        chatMode: null,
        groupMessageType: null,
        topicReplySupported: null,
        fullTopicMode: null,
        recommendation: "无法读取默认群信息。请确认机器人仍在群里，并为应用开通 im:chat:readonly 或 im:chat:read / im:chat 权限。",
        requiredScopes: ["im:chat:readonly", "im:chat:read", "im:chat"],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async probeRemoteControl(): Promise<DiagnosticSnapshot["codexRemoteControl"]> {
    const codexHome = dirname(this.config.codex.appStatePath);
    const configPath = join(codexHome, "config.toml");
    const appStatePath = this.config.codex.appStatePath;
    const controlSocketPath = join(codexHome, "app-server-control", "app-server-control.sock");
    const errors: string[] = [];
    let featureEnabled: boolean | null = null;
    let stateDbPath: string | null = null;
    let enrollmentCount: number | null = null;
    const localFeatureStateDbPath = join(codexHome, "sqlite", "codex-dev.db");
    let localFeatureState: RemoteControlSnapshot["localFeatureState"] = "missing_db";
    let localFeatureEntryCount: number | null = null;
    let localFeatureUpdatedAt: string | null = null;
    let loginStatus: string | null = null;
    let loginAuthMode: "api_key" | "account" | "logged_out" | "unknown" | "error" = "unknown";
    let cloudAccess: string | null = null;
    let authorizedClientCount: number | null = null;

    try {
      featureEnabled = readRemoteControlFeatureFlag(configPath);
    } catch (error) {
      errors.push(`config.toml: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      stateDbPath = findLatestStateDbPath(codexHome);
    } catch (error) {
      errors.push(`state db: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (stateDbPath) {
      try {
        enrollmentCount = readEnrollmentCount(stateDbPath);
      } catch (error) {
        errors.push(`remote_control_enrollments: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const localFeatureStateResult = readLocalFeatureState(localFeatureStateDbPath);
      localFeatureState = localFeatureStateResult.state;
      localFeatureEntryCount = localFeatureStateResult.entryCount;
      localFeatureUpdatedAt = localFeatureStateResult.updatedAt;
    } catch (error) {
      localFeatureState = "unknown";
      errors.push(`local_app_server_feature_enablement: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const globalState = readDesktopGlobalState(appStatePath);
      if (globalState) {
        cloudAccess = readCloudAccess(globalState);
        authorizedClientCount = readAuthorizedClientCount(globalState);
      }
    } catch (error) {
      errors.push(`app state: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const output = await this.execCodex(["login", "status"]);
      loginStatus = normalizeCliText(output.stdout || output.stderr || "");
      loginAuthMode = parseLoginAuthMode(loginStatus);
    } catch (error) {
      const fallbackOutput = extractExecOutput(error);
      loginStatus = normalizeCliText(fallbackOutput);
      loginAuthMode = loginStatus ? parseLoginAuthMode(loginStatus) : "error";
      errors.push(`codex login status: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      codexHome,
      configPath,
      appStatePath,
      featureEnabled,
      stateDbPath,
      enrollmentCount,
      localFeatureStateDbPath: existsSync(localFeatureStateDbPath) ? localFeatureStateDbPath : null,
      localFeatureState,
      localFeatureEntryCount,
      localFeatureUpdatedAt,
      controlSocketPath,
      controlSocketExists: existsSync(controlSocketPath),
      loginStatus,
      loginAuthMode,
      cloudAccess,
      authorizedClientCount,
      probeError: errors.length > 0 ? errors.join(" | ") : null
    };
  }

  private async execCodex(args: string[]): Promise<{ stdout?: string; stderr?: string }> {
    if (this.runtime.execCodex) {
      return this.runtime.execCodex(this.config.codex.command, args);
    }
    return execFileAsync(this.config.codex.command, args, {
      windowsHide: true,
      shell: process.platform === "win32",
      timeout: 10000
    });
  }
}

const readRemoteControlFeatureFlag = (configPath: string): boolean | null => {
  if (!existsSync(configPath)) return null;
  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  let currentSection = "";
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]?.trim() ?? "";
      continue;
    }
    if (currentSection !== "features") continue;
    const featureMatch = line.match(/^remote_control\s*=\s*(true|false)\s*$/i);
    if (!featureMatch) continue;
    return featureMatch[1]?.toLowerCase() === "true";
  }
  return null;
};

const readDesktopGlobalState = (appStatePath: string): Record<string, unknown> | null => {
  if (!existsSync(appStatePath)) return null;
  return asRecord(JSON.parse(readFileSync(appStatePath, "utf8")));
};

const readCloudAccess = (globalState: Record<string, unknown>): string | null => {
  const atomState = asRecord(globalState["electron-persisted-atom-state"]);
  const value = atomState["codexCloudAccess"];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const readAuthorizedClientCount = (globalState: Record<string, unknown>): number | null => {
  const clients = globalState["electron-remote-control-client-enrollments"];
  if (clients == null) return 0;
  if (!clients || typeof clients !== "object" || Array.isArray(clients)) return null;
  return Object.keys(clients).length;
};

const findLatestStateDbPath = (codexHome: string): string | null => {
  if (!existsSync(codexHome)) return null;
  const candidates = readdirSync(codexHome)
    .map((name) => ({ name, match: name.match(/^state_(\d+)\.sqlite$/) }))
    .filter((entry): entry is { name: string; match: RegExpMatchArray } => Boolean(entry.match))
    .sort((left, right) => Number(right.match[1] ?? 0) - Number(left.match[1] ?? 0));
  const latest = candidates[0];
  return latest ? join(codexHome, latest.name) : null;
};

const readEnrollmentCount = (stateDbPath: string): number | null => {
  const db = new DatabaseSync(stateDbPath, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get("remote_control_enrollments") as
      | { found?: number }
      | undefined;
    if (!table?.found) return null;
    const row = db.prepare("SELECT COUNT(*) AS count FROM remote_control_enrollments").get() as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  } finally {
    db.close();
  }
};

const readLocalFeatureState = (
  localFeatureStateDbPath: string
): {
  state: RemoteControlSnapshot["localFeatureState"];
  entryCount: number | null;
  updatedAt: string | null;
} => {
  if (!existsSync(localFeatureStateDbPath)) {
    return {
      state: "missing_db",
      entryCount: null,
      updatedAt: null
    };
  }
  const db = new DatabaseSync(localFeatureStateDbPath, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get("local_app_server_feature_enablement") as
      | { found?: number }
      | undefined;
    if (!table?.found) {
      return {
        state: "missing_table",
        entryCount: null,
        updatedAt: null
      };
    }
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM local_app_server_feature_enablement").get() as { count?: number } | undefined;
    const entryCount = typeof countRow?.count === "number" ? countRow.count : 0;
    const row = db
      .prepare(
        "SELECT feature_name, enabled, updated_at FROM local_app_server_feature_enablement WHERE feature_name = ? ORDER BY updated_at DESC LIMIT 1"
      )
      .get("remote_control") as
      | {
          feature_name?: string;
          enabled?: number | boolean | null;
          updated_at?: string | null;
        }
      | undefined;
    if (!row) {
      return {
        state: "unset",
        entryCount,
        updatedAt: null
      };
    }
    return {
      state: row.enabled === 1 || row.enabled === true ? "enabled" : "disabled",
      entryCount,
      updatedAt: typeof row.updated_at === "string" && row.updated_at.length > 0 ? row.updated_at : null
    };
  } finally {
    db.close();
  }
};

const normalizeCliText = (value: string): string | null => {
  const compact = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  return compact || null;
};

const parseLoginAuthMode = (status: string | null): "api_key" | "account" | "logged_out" | "unknown" | "error" => {
  if (!status) return "unknown";
  const lowered = status.toLowerCase();
  if (lowered.includes("api key")) return "api_key";
  if (lowered.includes("not logged in") || lowered.includes("logged out")) return "logged_out";
  if (lowered.includes("chatgpt") || lowered.includes("openai") || lowered.includes("logged in")) return "account";
  return "unknown";
};

const extractExecOutput = (error: unknown): string => {
  if (!error || typeof error !== "object") return "";
  const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
  const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  return stdout || stderr;
};

const describeLocalFeatureIssue = (remoteControl: RemoteControlSnapshot): string | null => {
  const pathHint = remoteControl.localFeatureStateDbPath
    ? `本地 feature store 路径：${remoteControl.localFeatureStateDbPath}。`
    : null;
  switch (remoteControl.localFeatureState) {
    case "enabled":
      return null;
    case "disabled":
      return [
        "Codex Desktop 的官方本地 feature store 已存在，但 `remote_control` 当前被标记为 disabled。",
        pathHint,
        "这会影响官方 Remote Control / proxy 侧能力，但不是当前飞书新建线程 direct app-server 主线的前置条件。"
      ].filter(Boolean).join(" ");
    case "unset":
      return [
        "当前 `config.toml` 已经打开 `features.remote_control`，但 Codex Desktop 官方本地 feature store 里还没有 `remote_control` 记录。",
        remoteControl.localFeatureEntryCount === 0
          ? "这台机器的 `local_app_server_feature_enablement` 当前是空表，说明 Desktop UI 的正式 enablement 链路还没有真正跑通。"
          : `当前 ` + "`local_app_server_feature_enablement`" + ` 已有 ${remoteControl.localFeatureEntryCount} 条记录，但没有 remote_control 这一项。`,
        pathHint,
        "在这个状态下，不要再把它误判成 direct app-server 主线故障；它只说明官方 Remote Control / proxy 侧还没有正式 enable。"
      ].filter(Boolean).join(" ");
    case "missing_db":
      return "Codex Desktop 的本地 feature store 数据库 `codex-dev.db` 还不存在；官方 local app server enablement 尚未落盘。";
    case "missing_table":
      return [
        "Codex Desktop 的 `codex-dev.db` 已存在，但缺少 `local_app_server_feature_enablement` 表。",
        pathHint,
        "这说明当前本机还没有进入官方 local app server feature enablement 流程。"
      ].filter(Boolean).join(" ");
    default:
      return null;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const chatRecommendation = (chatMode: string | null, groupMessageType: string | null, containerMode: string): string => {
  if (containerMode === "dedicated_chat") {
    return "当前默认群作为主控群使用；新任务默认创建独立任务会话，不依赖群内话题列表。";
  }
  if (chatMode === "topic" || groupMessageType === "thread") {
    return "当前群已经是话题消息形式；新的任务回复会在话题流中展示。";
  }
  if (chatMode === "group" && (!groupMessageType || groupMessageType === "chat")) {
    return "当前群是普通会话消息形式。桥接已用 reply_in_thread 创建任务话题，但主界面仍会像普通群回复；如需所有任务按话题流展示，需要把群的 group_message_type 改为 thread。";
  }
  if (chatMode === "p2p") {
    return "当前默认会话是单聊，不适合承载多人任务话题；建议配置一个群聊 chat_id。";
  }
  return "未能判断当前群的话题展示形态；请用 feishu-chat doctor 或 /doctor 查看原始群属性。";
};
