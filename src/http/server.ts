import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BridgeConfig } from "../config.js";
import type { CardRenderer } from "../domain/cards.js";
import type { DiagnosticsService } from "../bridge/diagnostics.js";
import type { TaskService } from "../bridge/task-service.js";
import { FeishuEventParser } from "../feishu/events.js";
import type { Logger } from "../logger.js";

export class BridgeHttpServer {
  private server: Server | null = null;
  private readonly parser: FeishuEventParser;

  constructor(
    private readonly config: BridgeConfig,
    private readonly taskService: TaskService,
    private readonly diagnostics: DiagnosticsService,
    private readonly cards: CardRenderer,
    private readonly logger: Logger
  ) {
    this.parser = new FeishuEventParser(config);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => {
      this.route(req, res).catch((error) => {
        const status = error instanceof HttpError ? error.status : 500;
        const meta = { error: String(error), url: req.url, status };
        if (status >= 500) {
          this.diagnostics.recordError(error);
          this.logger.error("http request failed", meta);
        } else {
          this.logger.warn("http request rejected", meta);
        }
        writeJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.server.port, this.config.server.host, resolve);
    });
    this.logger.info("bridge http server started", {
      host: this.config.server.host,
      port: this.config.server.port
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  localUrl(): string {
    if (!this.server) throw new Error("bridge http server is not started");
    const address = this.server.address() as AddressInfo | string | null;
    if (!address || typeof address === "string") throw new Error("bridge http server address is unavailable");
    const host = address.address === "::" || address.address === "0.0.0.0" ? "127.0.0.1" : address.address;
    return `http://${host}:${address.port}`;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/readyz") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/doctor") {
      this.assertAdmin(req);
      const snapshot = await this.diagnostics.snapshot();
      writeJson(res, 200, { ok: true, snapshot });
      return;
    }
    if (req.method === "POST" && url.pathname === "/feishu/events") {
      const body = await readJson(req);
      const parsed = this.parser.parse(body);
      if (parsed.type === "url_verification") {
        writeJson(res, 200, { challenge: parsed.challenge });
        return;
      }
      if (parsed.type === "message") {
        await this.taskService.handleMessage(parsed.message);
        writeJson(res, 200, { ok: true });
        return;
      }
      writeJson(res, 200, { ok: true, ignored: parsed.type === "ignored" ? parsed.reason : parsed.type });
      return;
    }
    if (req.method === "POST" && url.pathname === "/feishu/card") {
      const body = await readJson(req);
      const parsed = this.parser.parse(body);
      if (parsed.type !== "card_action") {
        writeJson(res, 200, { ok: true, ignored: parsed.type });
        return;
      }
      const result = await this.taskService.handleCardAction(parsed.action);
      writeJson(res, 200, {
        toast: {
          type: "success",
          content: typeof result.text === "string" ? result.text : "已处理"
        }
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/console-card") {
      this.assertAdmin(req);
      const snapshot = await this.diagnostics.snapshot();
      writeJson(res, 200, {
        ok: true,
        card: this.cards.diagnosticCard(snapshot)
      });
      return;
    }
    writeJson(res, 404, { ok: false, error: "not found" });
  }

  private assertAdmin(req: IncomingMessage): void {
    const header = req.headers.authorization ?? "";
    const expected = `Bearer ${this.config.server.adminToken}`;
    if (header !== expected) {
      throw new HttpError(401, "unauthorized");
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

const writeJson = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
