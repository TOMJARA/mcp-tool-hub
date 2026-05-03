// ============================================================
// @mcp-tool-hub/server-email — email-server.ts
//
// Allows the LLM to send emails via SMTP (Gmail or any server).
// Uses nodemailer — the most reliable Node.js email library.
// Supports plain text, HTML, and file attachments.
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

// ---- Tool definitions -----------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "email_send",
    description: "Send a plain text email.",
    parameters: {
      to: {
        type: "string",
        description: "Recipient email address",
        required: true,
      },
      subject: {
        type: "string",
        description: "Email subject",
        required: true,
      },
      body: {
        type: "string",
        description: "Plain text email body",
        required: true,
      },
      cc: {
        type: "string",
        description: "CC email address (optional)",
      },
    },
  },
  {
    name: "email_send_html",
    description: "Send a formatted HTML email with professional styling.",
    parameters: {
      to: {
        type: "string",
        description: "Recipient email address",
        required: true,
      },
      subject: {
        type: "string",
        description: "Email subject",
        required: true,
      },
      html: {
        type: "string",
        description: "HTML content of the email",
        required: true,
      },
      plainText: {
        type: "string",
        description: "Plain text fallback for email clients that don't support HTML",
      },
    },
  },
  {
    name: "email_send_report",
    description: "Send a professionally formatted IT report email.",
    parameters: {
      to: {
        type: "string",
        description: "Recipient email address",
        required: true,
      },
      title: {
        type: "string",
        description: "Report title",
        required: true,
      },
      sections: {
        type: "object",
        description: "Report sections as key-value pairs",
        required: true,
      },
      priority: {
        type: "string",
        description: "Email priority: normal, high, low",
        enum: ["normal", "high", "low"],
        default: "normal",
      },
    },
  },
  {
    name: "email_send_attachment",
    description: "Send an email with a file attachment.",
    parameters: {
      to: {
        type: "string",
        description: "Recipient email address",
        required: true,
      },
      subject: {
        type: "string",
        description: "Email subject",
        required: true,
      },
      body: {
        type: "string",
        description: "Email body text",
        required: true,
      },
      filePath: {
        type: "string",
        description: "Path to the file to attach",
        required: true,
      },
    },
  },
  {
    name: "email_verify_connection",
    description: "Test the SMTP connection and verify credentials are working.",
    parameters: {},
  },
];

const SERVER_INFO: ServerInfo = {
  id: "email",
  name: "Email Server",
  version: "1.0.0",
  description:
    "Send emails via SMTP: plain text, HTML reports, and file attachments.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class ---------------------------------------------

export interface EmailServerOptions {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  fromName?: string;
  secure?: boolean;
}

export class EmailServer extends BaseMCPServer {
  private transporter!: Transporter;
  private fromAddress!: string;
  private fromName!: string;

  constructor(options: EmailServerOptions) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("email_send",              this.emailSend.bind(this));
    this.registerTool("email_send_html",         this.emailSendHtml.bind(this));
    this.registerTool("email_send_report",       this.emailSendReport.bind(this));
    this.registerTool("email_send_attachment",   this.emailSendAttachment.bind(this));
    this.registerTool("email_verify_connection", this.emailVerifyConnection.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    const host     = this.getOption<string>("smtpHost", "smtp.gmail.com");
    const port     = this.getOption<number>("smtpPort", 465);
    const user     = this.getOption<string>("smtpUser", "");
    const pass     = this.getOption<string>("smtpPass", "");
    const secure   = this.getOption<boolean>("secure", true);
    this.fromName  = this.getOption<string>("fromName", "MCP Tool Hub");
    this.fromAddress = user;

    if (!user || !pass) {
      throw new Error("[email] smtpUser and smtpPass are required!");
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    console.log(`[email] SMTP configured: ${host}:${port} as ${user}`);
  }

  protected async onShutdown(): Promise<void> {
    this.transporter.close();
  }

  // ---- Helper --------------------------------------------------

  private from(): string {
    return `"${this.fromName}" <${this.fromAddress}>`;
  }

  private buildReportHtml(
    title: string,
    sections: Record<string, unknown>
  ): string {
    const rows = Object.entries(sections)
      .map(([key, value]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:bold;color:#555;width:35%">${key}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#333">${value}</td>
        </tr>`)
      .join("");

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;margin:0;padding:20px;background:#f5f5f5">
  <div style="max-width:600px;margin:0 auto;background:white;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <div style="background:#1a73e8;padding:20px 24px">
      <h1 style="color:white;margin:0;font-size:20px">🔧 ${title}</h1>
      <p style="color:#a8c7fa;margin:4px 0 0;font-size:13px">Generated by MCP Tool Hub • ${new Date().toLocaleString()}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;padding:12px">
      ${rows}
    </table>
    <div style="padding:16px 24px;background:#f8f9fa;border-top:1px solid #eee">
      <p style="margin:0;color:#888;font-size:12px">This report was automatically generated by your MCP Tool Hub IT automation system.</p>
    </div>
  </div>
</body>
</html>`;
  }

  // ---- Tool handlers -------------------------------------------

  private async emailSend(args: Record<string, unknown>): Promise<ToolCallResult> {
    const to      = args.to as string;
    const subject = args.subject as string;
    const body    = args.body as string;
    const cc      = args.cc as string | undefined;

    const info = await this.transporter.sendMail({
      from: this.from(),
      to,
      cc,
      subject,
      text: body,
    });

    return this.ok({
      messageId: info.messageId,
      to,
      subject,
    }, "Email sent successfully.");
  }

  private async emailSendHtml(args: Record<string, unknown>): Promise<ToolCallResult> {
    const to        = args.to as string;
    const subject   = args.subject as string;
    const html      = args.html as string;
    const plainText = args.plainText as string | undefined;

    const info = await this.transporter.sendMail({
      from: this.from(),
      to,
      subject,
      html,
      text: plainText ?? "Please view this email in an HTML-compatible email client.",
    });

    return this.ok({
      messageId: info.messageId,
      to,
      subject,
    }, "HTML email sent successfully.");
  }

  private async emailSendReport(args: Record<string, unknown>): Promise<ToolCallResult> {
    const to       = args.to as string;
    const title    = args.title as string;
    const sections = args.sections as Record<string, unknown>;
    const priority = (args.priority as string) ?? "normal";

    const html      = this.buildReportHtml(title, sections);
    const plainText = Object.entries(sections)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const headers: Record<string, string> = {};
    if (priority === "high") headers["X-Priority"] = "1";
    if (priority === "low")  headers["X-Priority"] = "5";

    const info = await this.transporter.sendMail({
      from:    this.from(),
      to,
      subject: `📊 ${title} — ${new Date().toLocaleDateString()}`,
      html,
      text:    plainText,
      headers,
    });

    return this.ok({
      messageId: info.messageId,
      to,
      title,
      sectionCount: Object.keys(sections).length,
    }, "Report email sent successfully.");
  }

  private async emailSendAttachment(args: Record<string, unknown>): Promise<ToolCallResult> {
    const to       = args.to as string;
    const subject  = args.subject as string;
    const body     = args.body as string;
    const filePath = args.filePath as string;

    const fileName    = path.basename(filePath);
    const fileContent = await fs.readFile(filePath);

    const info = await this.transporter.sendMail({
      from: this.from(),
      to,
      subject,
      text: body,
      attachments: [{
        filename: fileName,
        content:  fileContent,
      }],
    });

    return this.ok({
      messageId: info.messageId,
      to,
      subject,
      attachment: fileName,
      sizeBytes:  fileContent.length,
    }, "Email with attachment sent successfully.");
  }

  private async emailVerifyConnection(_args: Record<string, unknown>): Promise<ToolCallResult> {
    await this.transporter.verify();
    return this.ok({
      connected: true,
      host:      this.getOption<string>("smtpHost", ""),
      port:      this.getOption<number>("smtpPort", 465),
      user:      this.fromAddress,
    }, "SMTP connection verified successfully.");
  }
}
