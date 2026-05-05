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

  constructor(readonly config: BridgeConfig) {
    this.database = new BridgeDatabase(config.storage.databasePath);
    this.database.migrate();
    this.repo = new Repository(this.database);
    this.logger = new Logger(config.storage.logPath);
    this.codex = new CodexClient(config, this.logger);
    this.feishu = new FeishuClient(config, this.logger);
    this.tasks = new TaskService(config, this.repo, this.codex, this.feishu, this.logger);
    this.outbox = new OutboxWorker(config, this.repo, this.feishu, this.logger);
    this.diagnostics = new DiagnosticsService(config, this.repo, this.codex);
    this.http = new BridgeHttpServer(config, this.tasks, this.diagnostics, new CardRenderer(), this.logger);
  }

  async start(): Promise<void> {
    await this.tasks.bootstrapProjectsFromConfig();
    await this.codex.start();
    this.outbox.start();
    await this.http.start();
  }

  async stop(): Promise<void> {
    this.outbox.stop();
    await this.http.stop();
    await this.codex.stop();
    this.database.close();
  }
}
