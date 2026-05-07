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

  shouldStart(): boolean {
    if (this.config.server.mode === "enabled") return true;
    if (this.config.server.mode === "disabled") return false;
    return this.config.feishu.messageTransport === "http_callback" || this.config.feishu.cardActionTransport === "http_callback";
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (!this.shouldStart()) {
      this.logger.info("bridge http server skipped", {
        mode: this.config.server.mode,
        messageTransport: this.config.feishu.messageTransport,
        cardActionTransport: this.config.feishu.cardActionTransport
      });
      return;
    }
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
      if (this.config.feishu.messageTransport !== "http_callback") {
        writeJson(res, 409, { ok: false, error: "Feishu HTTP callback transport is disabled." });
        return;
      }
      const body = await readJson(req);
      const parsed = this.parser.parse(body);
      if (parsed.type === "url_verification") {
        writeJson(res, 200, { challenge: parsed.challenge });
        return;
      }
      if (parsed.type === "message") {
        this.diagnostics.recordFeishuMessage(parsed.message.messageId);
        await this.taskService.handleMessage(parsed.message);
        writeJson(res, 200, { ok: true });
        return;
      }
      writeJson(res, 200, { ok: true, ignored: parsed.type === "ignored" ? parsed.reason : parsed.type });
      return;
    }
    if (req.method === "POST" && url.pathname === "/feishu/card") {
      if (this.config.feishu.cardActionTransport !== "http_callback") {
        writeJson(res, 409, { ok: false, error: "Feishu HTTP callback transport is disabled." });
        return;
      }
      const body = await readJson(req);
      const parsed = this.parser.parse(body);
      if (parsed.type !== "card_action") {
        writeJson(res, 200, { ok: true, ignored: parsed.type });
        return;
      }
      this.diagnostics.recordFeishuCardAction(parsed.action.action, parsed.action.actionId);
      void this.taskService.processCardActionDeferred(parsed.action);
      writeJson(res, 200, {
        toast: {
          type: "success",
          content: "已收到，正在处理"
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
    if (req.method === "GET" && url.pathname.startsWith("/task/")) {
      this.assertAdmin(req, url);
      const bindingId = decodeURIComponent(url.pathname.slice("/task/".length));
      const data = this.taskService.taskDetailData(bindingId);
      if (wantsHtml(req)) {
        writeHtml(res, 200, renderTaskDetailHtml(data));
      } else {
        writeJson(res, 200, { ok: true, data });
      }
      return;
    }
    writeJson(res, 404, { ok: false, error: "not found" });
  }

  private assertAdmin(req: IncomingMessage, url?: URL): void {
    const header = req.headers.authorization ?? "";
    const expected = `Bearer ${this.config.server.adminToken}`;
    const token = url?.searchParams.get("token");
    if (header !== expected && token !== this.config.server.adminToken) {
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

const writeHtml = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
};

const wantsHtml = (req: IncomingMessage): boolean => {
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/html") && !accept.includes("application/json");
};

const renderTaskDetailHtml = (data: Record<string, unknown>): string => {
  const status = asRecord(data.status);
  const process = asRecord(data.process);
  const sections = Array.isArray(process.sections) ? process.sections.map(asRecord) : [];
  const events = Array.isArray(data.events) ? data.events.map(asRecord) : [];
  const checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints.map(asRecord) : [];
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(String(status.title ?? "Codex 任务"))}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f6f7f9;color:#1f2329}
main{max-width:980px;margin:0 auto;padding:24px}
section{background:#fff;border:1px solid #dee0e3;border-radius:8px;padding:18px;margin:14px 0}
h1{font-size:24px;margin:0 0 8px} h2{font-size:17px;margin:0 0 12px}
.meta{color:#646a73;line-height:1.7}.block{white-space:pre-wrap;line-height:1.65}
.event{border-top:1px solid #eff0f1;padding:10px 0}.event:first-child{border-top:0}
code{background:#f2f3f5;padding:2px 5px;border-radius:4px}
</style>
</head>
<body>
<main>
<section>
<h1>${escapeHtml(String(status.title ?? "Codex 任务"))}</h1>
<div class="meta">状态：${escapeHtml(String(status.status ?? ""))} · 项目：${escapeHtml(String(status.projectName ?? ""))} · 更新时间：${escapeHtml(String(status.updatedAt ?? ""))}</div>
</section>
<section><h2>处理记录</h2>${sections.map((section) => `<h3>${escapeHtml(String(section.label ?? ""))}</h3><div class="block">${escapeHtml(String(section.text ?? ""))}</div>`).join("") || "<div class=\"meta\">暂无处理记录</div>"}</section>
<section><h2>检查点</h2><div class="meta">共 ${checkpoints.length} 个</div>${checkpoints.slice(0, 20).map((checkpoint) => `<div class="event"><code>${escapeHtml(String(checkpoint.kind ?? ""))}</code> ${escapeHtml(String(checkpoint.createdAt ?? ""))}<br>${escapeHtml(String(checkpoint.snapshotNote ?? ""))}</div>`).join("")}</section>
<section><h2>完整时间线</h2>${events.map((event) => `<div class="event"><code>#${escapeHtml(String(event.seq ?? ""))} ${escapeHtml(String(event.eventType ?? ""))}</code><br><span class="meta">${escapeHtml(String(event.createdAt ?? ""))}</span><div class="block">${escapeHtml(JSON.stringify(event.eventPayload ?? {}, null, 2))}</div></div>`).join("") || "<div class=\"meta\">暂无事件</div>"}</section>
</main>
</body>
</html>`;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
