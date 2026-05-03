#!/usr/bin/env node
// ============================================================
// host/src/cli.ts
// CLI entrypoint — boots the hub with all servers and
// exposes an interactive JSON-RPC-like stdio interface.
// This is what Ansible deploys and runs on client machines.
// ============================================================

import path from "node:path";
import readline from "node:readline";
import { MCPHub } from "./hub.js";
import { FilesystemServer } from "@mcp-tool-hub/server-filesystem";
import { GitServer }        from "@mcp-tool-hub/server-git";
import { FetchServer }      from "@mcp-tool-hub/server-fetch";
import { MemoryServer }     from "@mcp-tool-hub/server-memory";
import { SSHServer } from "@mcp-tool-hub/server-ssh";
import { DockerServer } from "@mcp-tool-hub/server-docker";
import { NetworkServer } from "@mcp-tool-hub/server-network";
import { NotificationServer } from "@mcp-tool-hub/server-notification";
import { EmailServer } from "@mcp-tool-hub/server-email";
import { DatabaseServer } from "@mcp-tool-hub/server-database";
import { WorkflowServer } from "@mcp-tool-hub/server-workflow";

// ---- Configuration from environment / defaults ----------------

const DATA_DIR       = process.env.MCP_DATA_DIR       ?? path.join(process.cwd(), "mcp-data");
const FS_ROOT        = process.env.MCP_FS_ROOT        ?? path.join(DATA_DIR, "files");
const GIT_WORKSPACE  = process.env.MCP_GIT_WORKSPACE  ?? path.join(DATA_DIR, "repos");
const MEMORY_PATH    = process.env.MCP_MEMORY_PATH    ?? path.join(DATA_DIR, "memory.json");
const LOG_LEVEL      = (process.env.MCP_LOG_LEVEL     ?? "info") as "debug" | "info" | "warn" | "error";
const ALLOWED_DOMAINS_RAW = process.env.MCP_FETCH_ALLOWED_DOMAINS ?? "";
const GMAIL_USER = process.env.MCP_GMAIL_USER ?? "";
const GMAIL_PASS = process.env.MCP_GMAIL_PASS ?? "";
const TELEGRAM_TOKEN = process.env.MCP_TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.MCP_TELEGRAM_CHAT_ID ?? "";
const ALLOWED_DOMAINS = ALLOWED_DOMAINS_RAW
  ? ALLOWED_DOMAINS_RAW.split(",").map((d) => d.trim()).filter(Boolean)
  : [];

// ---- Build hub ------------------------------------------------

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║         MCP Tool Hub v1.0.0              ║");
  console.log("║   IT Automation & AI Tool Platform        ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  const hub = new MCPHub({ logLevel: LOG_LEVEL });

  // Register all servers
  hub
    .use(new FilesystemServer({ allowedRoot: FS_ROOT }))
    .use(new GitServer({ workspacePath: GIT_WORKSPACE }))
    .use(new FetchServer({ allowedDomains: ALLOWED_DOMAINS }))
        .use(new MemoryServer({ storePath: MEMORY_PATH }))
        .use(new SSHServer({ hostsConfigPath: path.join(DATA_DIR, "ssh-hosts.json"), localFilesRoot: FS_ROOT }))
        .use(new DockerServer({}))
        .use(new NetworkServer({}))
        .use(new NotificationServer({ botToken: TELEGRAM_TOKEN, chatId: TELEGRAM_CHAT_ID }))
        .use(new EmailServer({ smtpHost: "smtp.gmail.com", smtpPort: 465, smtpUser: GMAIL_USER, smtpPass: GMAIL_PASS, fromName: "MCP Tool Hub" }))
        .use(new DatabaseServer({ connectionsConfigPath: path.join(DATA_DIR, "db-connections.json") }))
    .use(new WorkflowServer({ workflowsPath: path.join(DATA_DIR, "workflows.json") }));
  await hub.start();

  // Wire workflow engine to all servers
  const workflowSrv = hub.getServers().find(s => s.info.id === "workflow") as WorkflowServer;
  if (workflowSrv) workflowSrv.registerHub(hub.getServers());

  // Print tool manifest
  console.log("\n" + hub.generateToolManifest());
  console.log("─".repeat(60));
  console.log("Hub ready. Listening for tool calls on stdin (JSON).");
  console.log('Send: {"toolName": "...", "arguments": {...}}');
  console.log("─".repeat(60) + "\n");

  // ---- Stdio JSON-RPC interface --------------------------------
  // This is the transport layer: Ansible/LLM integration sends
  // JSON tool-call requests via stdin, reads results from stdout.

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return;

    let request: unknown;
    try {
      request = JSON.parse(trimmed);
    } catch {
      const errResponse = { status: "error", data: null, message: "Invalid JSON input" };
      process.stdout.write(JSON.stringify(errResponse) + "\n");
      return;
    }

    const result = await hub.call(request as Parameters<typeof hub.call>[0]);
    process.stdout.write(JSON.stringify(result) + "\n");
  });

  rl.on("close", async () => {
    console.log("\nStdin closed — shutting down hub...");
    await hub.stop();
    process.exit(0);
  });

  // Graceful shutdown on signals
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal} — shutting down hub...`);
    await hub.stop();
    process.exit(0);
  };

  process.on("SIGINT",  () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
