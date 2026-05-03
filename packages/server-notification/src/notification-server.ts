// ============================================================
// @mcp-tool-hub/server-notification — notification-server.ts
//
// Sends notifications to the IT engineer via Telegram.
// Supports text messages, alerts, status reports, and files.
// Uses Telegram Bot API — no extra dependencies needed.
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

// ---- Tool definitions -----------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "notify_send",
    description:
      "Send a text message notification to the IT engineer via Telegram.",
    parameters: {
      message: {
        type: "string",
        description: "The message to send",
        required: true,
      },
      level: {
        type: "string",
        description: "Message level: info, success, warning, error. Affects the emoji prefix.",
        enum: ["info", "success", "warning", "error"],
        default: "info",
      },
      silent: {
        type: "boolean",
        description: "Send without notification sound. Defaults to false.",
        default: false,
      },
    },
  },
  {
    name: "notify_alert",
    description: "Send an urgent alert with high priority. Always makes a sound.",
    parameters: {
      title: {
        type: "string",
        description: "Alert title",
        required: true,
      },
      message: {
        type: "string",
        description: "Alert details",
        required: true,
      },
      severity: {
        type: "string",
        description: "Severity level: low, medium, high, critical",
        enum: ["low", "medium", "high", "critical"],
        default: "high",
      },
    },
  },
  {
    name: "notify_status_report",
    description: "Send a formatted status report with multiple fields.",
    parameters: {
      title: {
        type: "string",
        description: "Report title",
        required: true,
      },
      fields: {
        type: "object",
        description: "Key-value pairs to include in the report",
        required: true,
      },
      footer: {
        type: "string",
        description: "Optional footer text",
      },
    },
  },
  {
    name: "notify_send_file",
    description: "Send a file (log, config, report) to Telegram.",
    parameters: {
      filePath: {
        type: "string",
        description: "Path to the file to send (relative to filesystem root)",
        required: true,
      },
      caption: {
        type: "string",
        description: "Optional caption for the file",
      },
    },
  },
  {
    name: "notify_get_history",
    description: "Get the history of recently sent notifications.",
    parameters: {
      limit: {
        type: "number",
        description: "Number of recent notifications to return. Defaults to 10.",
        default: 10,
      },
    },
  },
];

const SERVER_INFO: ServerInfo = {
  id: "notification",
  name: "Notification Server",
  version: "1.0.0",
  description:
    "Send real-time notifications and alerts to the IT engineer via Telegram.",
  tools: TOOL_DEFINITIONS,
};

// ---- Notification history entry -------------------------------

interface NotificationRecord {
  timestamp: string;
  type: string;
  message: string;
  status: "sent" | "failed";
}

// ---- Level emojis --------------------------------------------

const LEVEL_EMOJI: Record<string, string> = {
  info:    "ℹ️",
  success: "✅",
  warning: "⚠️",
  error:   "❌",
};

const SEVERITY_EMOJI: Record<string, string> = {
  low:      "🟡",
  medium:   "🟠",
  high:     "🔴",
  critical: "🚨",
};

// ---- Server class ---------------------------------------------

export interface NotificationServerOptions {
  botToken: string;
  chatId: string;
  /** Max notification history to keep (default: 100) */
  maxHistory?: number;
  /** Path to store notification history */
  historyPath?: string;
}

export class NotificationServer extends BaseMCPServer {
  private botToken!: string;
  private chatId!: string;
  private maxHistory!: number;
  private historyPath!: string;
  private history: NotificationRecord[] = [];
  private apiBase!: string;

  constructor(options: NotificationServerOptions) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("notify_send",          this.notifySend.bind(this));
    this.registerTool("notify_alert",         this.notifyAlert.bind(this));
    this.registerTool("notify_status_report", this.notifyStatusReport.bind(this));
    this.registerTool("notify_send_file",     this.notifySendFile.bind(this));
    this.registerTool("notify_get_history",   this.notifyGetHistory.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.botToken    = this.getOption<string>("botToken", "");
    this.chatId      = this.getOption<string>("chatId", "");
    this.maxHistory  = this.getOption<number>("maxHistory", 100);
    this.historyPath = path.resolve(
      this.getOption<string>("historyPath", "./mcp-data/notification-history.json")
    );
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;

    if (!this.botToken || !this.chatId) {
      throw new Error("[notification] botToken and chatId are required!");
    }

    // Load history
    await this.loadHistory();

    // Test the connection
    await this.testConnection();
    console.log(`[notification] Telegram bot connected successfully`);
  }

  // ---- Telegram API helpers ------------------------------------

  private async telegramRequest(
    method: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    return data;
  }

  private async sendMessage(
    text: string,
    silent = false
  ): Promise<void> {
    await this.telegramRequest("sendMessage", {
      chat_id:              this.chatId,
      text,
      parse_mode:           "HTML",
      disable_notification: silent,
    });
  }

  private async testConnection(): Promise<void> {
    const response = await fetch(`${this.apiBase}/getMe`);
    const data = await response.json() as { ok: boolean };
    if (!data.ok) throw new Error("Failed to connect to Telegram bot");
  }

  // ---- History management --------------------------------------

  private async loadHistory(): Promise<void> {
    try {
      const raw = await fs.readFile(this.historyPath, "utf8");
      this.history = JSON.parse(raw) as NotificationRecord[];
    } catch {
      this.history = [];
    }
  }

  private async saveHistory(): Promise<void> {
    await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
    await fs.writeFile(
      this.historyPath,
      JSON.stringify(this.history.slice(-this.maxHistory), null, 2),
      "utf8"
    );
  }

  private async recordNotification(
    type: string,
    message: string,
    status: "sent" | "failed"
  ): Promise<void> {
    this.history.push({
      timestamp: new Date().toISOString(),
      type,
      message: message.slice(0, 200),
      status,
    });
    await this.saveHistory();
  }

  // ---- Tool handlers -------------------------------------------

  private async notifySend(args: Record<string, unknown>): Promise<ToolCallResult> {
    const message = args.message as string;
    const level   = (args.level as string) ?? "info";
    const silent  = (args.silent as boolean) ?? false;
    const emoji   = LEVEL_EMOJI[level] ?? "ℹ️";

    const text = `${emoji} <b>MCP Tool Hub</b>\n\n${message}\n\n<i>${new Date().toLocaleString()}</i>`;

    await this.sendMessage(text, silent);
    await this.recordNotification("message", message, "sent");

    return this.ok({ sent: true, level, silent }, "Notification sent successfully.");
  }

  private async notifyAlert(args: Record<string, unknown>): Promise<ToolCallResult> {
    const title    = args.title as string;
    const message  = args.message as string;
    const severity = (args.severity as string) ?? "high";
    const emoji    = SEVERITY_EMOJI[severity] ?? "🔴";

    const text = [
      `${emoji} <b>ALERT: ${title}</b>`,
      ``,
      `<b>Severity:</b> ${severity.toUpperCase()}`,
      `<b>Details:</b> ${message}`,
      ``,
      `<i>🕐 ${new Date().toLocaleString()}</i>`,
    ].join("\n");

    // Alerts always make sound
    await this.sendMessage(text, false);
    await this.recordNotification("alert", `${title}: ${message}`, "sent");

    return this.ok({ sent: true, severity }, "Alert sent successfully.");
  }

  private async notifyStatusReport(args: Record<string, unknown>): Promise<ToolCallResult> {
    const title  = args.title as string;
    const fields = args.fields as Record<string, unknown>;
    const footer = args.footer as string | undefined;

    const fieldLines = Object.entries(fields)
      .map(([key, value]) => `<b>${key}:</b> ${value}`)
      .join("\n");

    const text = [
      `📊 <b>${title}</b>`,
      ``,
      fieldLines,
      footer ? `\n<i>${footer}</i>` : "",
      ``,
      `<i>🕐 ${new Date().toLocaleString()}</i>`,
    ].join("\n");

    await this.sendMessage(text, false);
    await this.recordNotification("status_report", title, "sent");

    return this.ok({ sent: true, fieldCount: Object.keys(fields).length }, "Status report sent.");
  }

  private async notifySendFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const filePath = args.filePath as string;
    const caption  = (args.caption as string) ?? "";

    const fileContent = await fs.readFile(filePath);
    const fileName    = path.basename(filePath);

    // Send as document via multipart form
    const formData = new FormData();
    formData.append("chat_id", this.chatId);
    formData.append("caption", caption);
    formData.append(
      "document",
      new Blob([fileContent]),
      fileName
    );

    const response = await fetch(`${this.apiBase}/sendDocument`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json() as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(`Failed to send file: ${data.description}`);

    await this.recordNotification("file", fileName, "sent");
    return this.ok({ sent: true, fileName, caption }, "File sent successfully.");
  }

  private async notifyGetHistory(args: Record<string, unknown>): Promise<ToolCallResult> {
    const limit   = Math.min((args.limit as number) ?? 10, 100);
    const recent  = this.history.slice(-limit).reverse();
    return this.ok(recent, undefined, { count: recent.length });
  }
}
