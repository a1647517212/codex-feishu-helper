import type { BridgeConfig } from "./config.js";
import { BridgeDatabase } from "./db/database.js";
import { Repository } from "./db/repo.js";
import { Logger } from "./logger.js";
import { CodexClient } from "./codex/client.js";
import { FeishuClient } from "./feishu/client.js";
import { TaskService } from "./bridge/task-service.js";
import { OutboxWorker } from "./bridge/outbox.js";
import { DiagnosticsService } from "./bridge/diagnostics.js";
import { BridgeHttpServer } from "./http/server.js";
import { CardRenderer } from "./domain/cards.js";
import { FeishuLongConnectionServer } from "./feishu/long-connection.js";

export class BridgeApp {
  readonly database: BridgeDatabase;
  readonly repo: Repository;
  readonly logger: Logger;
  readonly codex: CodexClient;
  readonly feishu: FeishuClient;
  readonly tasks: TaskService;
  readonly outbox: OutboxWorker;
  readonly diagnostics: DiagnosticsService;
  readonly http: BridgeHttpServer;
  readonly longConnection: FeishuLongConnectionServer;
  private httpStarted = false;

  constructor(readonly config: BridgeConfig) {
    this.database = new BridgeDatabase(config.storage.databasePath);
    this.database.migrate();
    this.repo = new Repository(this.database);
    this.logger = new Logger(config.storage.logPath);
    this.codex = new CodexClient(config, this.logger);
    this.feishu = new FeishuClient(config, this.logger);
    this.diagnostics = new DiagnosticsService(config, this.repo, this.codex, this.feishu);
    this.tasks = new TaskService(config, this.repo, this.codex, this.feishu, this.logger, this.diagnostics);
    this.outbox = new OutboxWorker(config, this.repo, this.feishu, this.logger);
    this.http = new BridgeHttpServer(config, this.tasks, this.diagnostics, new CardRenderer(config.feishu.interactionMode), this.logger);
    this.longConnection = new FeishuLongConnectionServer(config, this.tasks, this.diagnostics, this.logger);
  }

  async start(): Promise<void> {
    await this.tasks.bootstrapProjectsFromConfig({ reconcile: false });
    await this.codex.start();
    await this.tasks.bootstrapRuntimeState();
    this.outbox.start();
    this.tasks.startCodexOnlyCompletionWatch();
    if (this.http.shouldStart()) {
      await this.http.start();
      this.httpStarted = true;
    } else {
      this.httpStarted = false;
    }
    await this.longConnection.start();
  }

  async stop(): Promise<void> {
    await this.longConnection.stop();
    this.tasks.stopCodexOnlyCompletionWatch();
    this.outbox.stop();
    await this.http.stop();
    await this.codex.stop();
    this.database.close();
  }

  startupSummary(): {
    httpStarted: boolean;
    httpUrl: string | null;
    messageTransport: BridgeConfig["feishu"]["messageTransport"];
    cardActionTransport: BridgeConfig["feishu"]["cardActionTransport"];
    taskContainerMode: BridgeConfig["feishu"]["taskContainerMode"];
  } {
    return {
      httpStarted: this.httpStarted,
      httpUrl: this.httpStarted ? this.http.localUrl() : null,
      messageTransport: this.config.feishu.messageTransport,
      cardActionTransport: this.config.feishu.cardActionTransport,
      taskContainerMode: this.config.feishu.taskContainerMode
    };
  }
}
