// ============================================================
// @mcp-tool-hub/core — logger.ts
// Lightweight structured logger
// ============================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private readonly prefix: string;
  private readonly minLevel: number;

  constructor(prefix: string, level: LogLevel = "info") {
    this.prefix = prefix;
    this.minLevel = LEVELS[level];
  }

  debug(msg: string, data?: unknown): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: unknown): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: unknown): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: unknown): void {
    this.log("error", msg, data);
  }

  private log(level: LogLevel, msg: string, data?: unknown): void {
    if (LEVELS[level] < this.minLevel) return;
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] [${this.prefix}] ${msg}`;
    const out = level === "error" || level === "warn" ? console.error : console.log;
    if (data !== undefined) {
      out(line, typeof data === "object" ? JSON.stringify(data, null, 2) : data);
    } else {
      out(line);
    }
  }
}
