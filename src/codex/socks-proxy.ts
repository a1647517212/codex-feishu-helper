import { createServer, createConnection, isIP, type Server, type Socket } from "node:net";
import type { Logger } from "../logger.js";

export type SocksProxyStatus = "not_started" | "listening" | "external_or_occupied" | "error" | "stopped";

export interface DesktopSocksProxyOptions {
  listenHost: string;
  listenPort: number;
  allowedHost: string;
  allowedPort: number;
  allowExisting: boolean;
}

export interface DesktopSocksProxySnapshot {
  enabled: boolean;
  host: string;
  port: number;
  status: SocksProxyStatus;
  allowedHost: string;
  allowedPort: number;
  lastError: string | null;
}

export class DesktopSocksProxy {
  private server: Server | null = null;
  private currentStatus: SocksProxyStatus = "not_started";
  private lastError: string | null = null;

  constructor(
    private readonly options: DesktopSocksProxyOptions,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    if (this.server || this.currentStatus === "external_or_occupied") return;
    const server = createServer((client) => this.handleClient(client));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        this.server = null;
        if (error.code === "EADDRINUSE" && this.options.allowExisting) {
          this.currentStatus = "external_or_occupied";
          this.lastError = `SOCKS5 port ${this.options.listenHost}:${this.options.listenPort} is already in use`;
          this.logger.warn("codex desktop socks proxy port already in use; assuming external proxy", {
            host: this.options.listenHost,
            port: this.options.listenPort
          });
          resolve();
          return;
        }
        this.currentStatus = "error";
        this.lastError = error.message;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        this.currentStatus = "listening";
        this.lastError = null;
        this.logger.info("codex desktop socks proxy started", {
          host: this.options.listenHost,
          port: this.options.listenPort,
          allowedHost: this.options.allowedHost,
          allowedPort: this.options.allowedPort
        });
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.listenPort, this.options.listenHost);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      if (this.currentStatus !== "not_started") this.currentStatus = "stopped";
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    this.currentStatus = "stopped";
  }

  snapshot(enabled = true): DesktopSocksProxySnapshot {
    return {
      enabled,
      host: this.options.listenHost,
      port: this.options.listenPort,
      status: this.currentStatus,
      allowedHost: this.options.allowedHost,
      allowedPort: this.options.allowedPort,
      lastError: this.lastError
    };
  }

  private handleClient(client: Socket): void {
    const session = new SocksSession(client, this.options, this.logger);
    session.start();
  }
}

class SocksSession {
  private stage: "greeting" | "request" | "tunnel" = "greeting";
  private upstream: Socket | null = null;
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly client: Socket,
    private readonly options: DesktopSocksProxyOptions,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.client.on("data", (chunk) => this.handleData(chunk));
    this.client.on("error", (error) => this.logger.warn("codex desktop socks client error", { error: error.message }));
    this.client.on("close", () => this.upstream?.destroy());
  }

  private handleData(chunk: Buffer): void {
    if (this.stage === "tunnel") {
      this.upstream?.write(chunk);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      if (this.stage === "greeting") this.handleGreeting();
      if (this.stage === "request") this.handleRequest();
    } catch (error) {
      this.logger.warn("codex desktop socks protocol error", { error: String(error) });
      this.client.destroy();
    }
  }

  private handleGreeting(): void {
    if (this.buffer.length < 2) return;
    const version = this.buffer[0];
    const methodCount = this.buffer[1] ?? 0;
    const total = 2 + methodCount;
    if (this.buffer.length < total) return;
    if (version !== 0x05) {
      this.client.end(Buffer.from([0x05, 0xff]));
      return;
    }
    this.buffer = this.buffer.subarray(total);
    this.client.write(Buffer.from([0x05, 0x00]));
    this.stage = "request";
  }

  private handleRequest(): void {
    if (this.buffer.length < 5) return;
    const version = this.buffer[0];
    const command = this.buffer[1];
    const atyp = this.buffer[3];
    if (version !== 0x05 || command !== 0x01) {
      this.sendReply(0x07);
      this.client.end();
      return;
    }
    const parsed = parseAddress(this.buffer, atyp, 4);
    if (!parsed) return;
    const portOffset = parsed.nextOffset;
    if (this.buffer.length < portOffset + 2) return;
    const port = this.buffer.readUInt16BE(portOffset);
    const remaining = this.buffer.subarray(portOffset + 2);
    this.buffer = Buffer.alloc(0);
    if (!this.isAllowed(parsed.host, port)) {
      this.logger.warn("codex desktop socks rejected target", {
        host: parsed.host,
        port,
        allowedHost: this.options.allowedHost,
        allowedPort: this.options.allowedPort
      });
      this.sendReply(0x02);
      this.client.end();
      return;
    }
    this.connectUpstream(parsed.host, port, remaining);
  }

  private connectUpstream(host: string, port: number, initialPayload: Buffer): void {
    const upstream = createConnection({ host, port });
    this.upstream = upstream;
    upstream.once("connect", () => {
      this.sendReply(0x00);
      this.stage = "tunnel";
      if (initialPayload.length > 0) upstream.write(initialPayload);
    });
    upstream.on("data", (chunk) => this.client.write(chunk));
    upstream.on("error", (error) => {
      this.logger.warn("codex desktop socks upstream error", { host, port, error: error.message });
      if (this.stage !== "tunnel") this.sendReply(0x05);
      this.client.destroy();
    });
    upstream.on("close", () => this.client.destroy());
  }

  private isAllowed(host: string, port: number): boolean {
    return normalizeHost(host) === normalizeHost(this.options.allowedHost) && port === this.options.allowedPort;
  }

  private sendReply(code: number): void {
    this.client.write(Buffer.from([0x05, code, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
  }
}

const parseAddress = (
  buffer: Buffer,
  atyp: number | undefined,
  offset: number
): { host: string; nextOffset: number } | null => {
  if (atyp === 0x01) {
    if (buffer.length < offset + 4) return null;
    return { host: Array.from(buffer.subarray(offset, offset + 4)).join("."), nextOffset: offset + 4 };
  }
  if (atyp === 0x03) {
    if (buffer.length < offset + 1) return null;
    const length = buffer[offset] ?? 0;
    if (buffer.length < offset + 1 + length) return null;
    return {
      host: buffer.subarray(offset + 1, offset + 1 + length).toString("utf8"),
      nextOffset: offset + 1 + length
    };
  }
  if (atyp === 0x04) {
    if (buffer.length < offset + 16) return null;
    const parts: string[] = [];
    for (let index = 0; index < 16; index += 2) {
      parts.push(buffer.readUInt16BE(offset + index).toString(16));
    }
    return { host: parts.join(":"), nextOffset: offset + 16 };
  }
  throw new Error(`Unsupported SOCKS address type: ${String(atyp)}`);
};

const normalizeHost = (host: string): string => {
  const lowered = host.toLowerCase();
  if (lowered === "localhost") return "127.0.0.1";
  if (isIP(lowered) === 6 && lowered === "::1") return "127.0.0.1";
  return lowered;
};
