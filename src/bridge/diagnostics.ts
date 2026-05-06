import { execFile } from "node:child_process";
import { hostname, platform } from "node:os";
import { promisify } from "node:util";
import type { BridgeConfig } from "../config.js";
import type { DiagnosticSnapshot } from "../core/types.js";
import type { CodexClient } from "../codex/client.js";
import type { Repository } from "../db/repo.js";

const execFileAsync = promisify(execFile);

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
    private readonly codex: CodexClient
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
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      machineName: this.config.machine.name || hostname(),
      platform: platform(),
      nodeVersion: process.version,
      codexCommand: this.config.codex.command,
      codexAvailable: await this.isCodexAvailable(),
      appServerStatus: this.codex.status,
      feishuConfigured: Boolean(this.config.feishu.appId && this.config.feishu.appSecret && this.config.feishu.defaultChatId),
      feishuMessageTransport: this.config.feishu.messageTransport,
      feishuCardActionTransport: this.config.feishu.cardActionTransport,
      feishuInteractionMode: this.config.feishu.interactionMode,
      databasePath: this.config.storage.databasePath,
      projectsCount: this.repo.count("projects"),
      sessionBindingsCount: this.repo.count("session_bindings"),
      runningTasksCount: this.repo.count("session_bindings", "status = 'running'"),
      pendingOutboxCount: this.repo.count("notification_outbox", "status = 'pending'"),
      pendingApprovalsCount: this.repo.count("pending_approvals", "status = 'pending'"),
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
      await execFileAsync(this.config.codex.command, ["--version"], {
        windowsHide: true,
        shell: process.platform === "win32",
        timeout: 10000
      });
      return true;
    } catch {
      return false;
    }
  }
}
