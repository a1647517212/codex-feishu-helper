import { appendFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  constructor(
    private readonly logPath: string,
    private readonly minLevel: LogLevel = "info"
  ) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    if (order[level] < order[this.minLevel]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      meta: meta ?? {}
    };
    const line = `${JSON.stringify(entry)}\n`;
    appendFileSync(this.logPath, line, { encoding: "utf8" });
    if (level === "error" || level === "warn") {
      console.error(line.trim());
    } else {
      console.log(line.trim());
    }
  }
}
