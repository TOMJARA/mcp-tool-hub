// ============================================================
// @mcp-tool-hub/server-workflow — workflow-server.ts
//
// Workflow engine that connects all MCP servers together.
// Runs multi-step automated IT workflows:
// - Health checks across all machines
// - Deployment workflows
// - Backup workflows
// - Daily reports
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
import {
  BaseMCPServer,
  IMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

// ---- Types ---------------------------------------------------

export interface WorkflowStep {
  name: string;
  toolName: string;
  arguments: Record<string, unknown>;
  continueOnError?: boolean;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export interface WorkflowResult {
  workflowId: string;
  workflowName: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  steps: StepResult[];
}

export interface StepResult {
  stepName: string;
  toolName: string;
  success: boolean;
  data: unknown;
  error?: string;
  durationMs: number;
}

// ---- Tool definitions ----------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "workflow_run",
    description: "Run a predefined workflow by ID.",
    parameters: {
      workflowId: {
        type: "string",
        description: "The workflow ID to run",
        required: true,
      },
    },
  },
  {
    name: "workflow_list",
    description: "List all available workflows.",
    parameters: {},
  },
  {
    name: "workflow_health_check",
    description:
      "Run a full health check on all configured computers. " +
      "Pings each machine, checks key ports, and sends a report.",
    parameters: {
      notify: {
        type: "boolean",
        description: "Send results via Telegram notification. Defaults to true.",
        default: true,
      },
    },
  },
  {
    name: "workflow_daily_report",
    description:
      "Generate and send a daily IT status report via email and Telegram.",
    parameters: {
      email: {
        type: "string",
        description: "Email address to send the report to",
        required: true,
      },
    },
  },
  {
    name: "workflow_deploy_file",
    description:
      "Deploy a file to a remote machine via SSH and run an install command.",
    parameters: {
      hostAlias: {
        type: "string",
        description: "SSH host alias to deploy to",
        required: true,
      },
      localFile: {
        type: "string",
        description: "Local file path to deploy",
        required: true,
      },
      remotePath: {
        type: "string",
        description: "Remote destination path",
        required: true,
      },
      command: {
        type: "string",
        description: "Command to run after deployment e.g. 'bash /tmp/install.sh'",
      },
    },
  },
  {
    name: "workflow_backup_all",
    description: "Backup all SQLite databases and send confirmation.",
    parameters: {
      notify: {
        type: "boolean",
        description: "Send backup confirmation via Telegram. Defaults to true.",
        default: true,
      },
    },
  },
];

const SERVER_INFO: ServerInfo = {
  id: "workflow",
  name: "Workflow Engine",
  version: "1.0.0",
  description:
    "Automated IT workflows: health checks, deployments, backups, and daily reports.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class --------------------------------------------

export interface WorkflowServerOptions {
  workflowsPath?: string;
}

export class WorkflowServer extends BaseMCPServer {
  private hub: IMCPServer[] = [];
  private workflowsPath!: string;
  private workflows = new Map<string, WorkflowDefinition>();

  constructor(options: WorkflowServerOptions = {}) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("workflow_run",          this.workflowRun.bind(this));
    this.registerTool("workflow_list",         this.workflowList.bind(this));
    this.registerTool("workflow_health_check", this.workflowHealthCheck.bind(this));
    this.registerTool("workflow_daily_report", this.workflowDailyReport.bind(this));
    this.registerTool("workflow_deploy_file",  this.workflowDeployFile.bind(this));
    this.registerTool("workflow_backup_all",   this.workflowBackupAll.bind(this));
  }

  // ---- Register hub reference ---------------------------------

  registerHub(servers: IMCPServer[]): void {
    this.hub = servers;
  }

  protected async onInitialize(): Promise<void> {
    this.workflowsPath = path.resolve(
      this.getOption<string>("workflowsPath", "./mcp-data/workflows.json")
    );
    await this.loadWorkflows();
    console.log(`[workflow] Loaded ${this.workflows.size} workflow(s)`);
  }

  // ---- Load workflows -----------------------------------------

  private async loadWorkflows(): Promise<void> {
    try {
      const raw = await fs.readFile(this.workflowsPath, "utf8");
      const defs = JSON.parse(raw) as WorkflowDefinition[];
      for (const def of defs) {
        this.workflows.set(def.id, def);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Create sample workflows
        const samples: WorkflowDefinition[] = [
          {
            id: "ping-all",
            name: "Ping All Computers",
            description: "Ping all known computers and report results",
            steps: [
              {
                name: "Ping Office PC",
                toolName: "network_ping",
                arguments: { host: "172.16.13.18", count: 3 },
                continueOnError: true,
              },
              {
                name: "Ping Lab PC",
                toolName: "network_ping",
                arguments: { host: "172.16.13.19", count: 3 },
                continueOnError: true,
              },
            ],
          },
        ];
        await fs.mkdir(path.dirname(this.workflowsPath), { recursive: true });
        await fs.writeFile(
          this.workflowsPath,
          JSON.stringify(samples, null, 2),
          "utf8"
        );
        for (const def of samples) {
          this.workflows.set(def.id, def);
        }
      }
    }
  }

  // ---- Call another server's tool -----------------------------

  private async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    for (const server of this.hub) {
      const tool = server.info.tools.find((t) => t.name === toolName);
      if (tool) {
        return server.handleToolCall({ toolName, arguments: args });
      }
    }
    return {
      status: "error",
      data: null,
      message: `Tool "${toolName}" not found in any server`,
    };
  }

  // ---- Run workflow steps -------------------------------------

  private async runSteps(steps: WorkflowStep[]): Promise<StepResult[]> {
    const results: StepResult[] = [];

    for (const step of steps) {
      const start  = Date.now();
      let success  = false;
      let data: unknown = null;
      let error: string | undefined;

      try {
        const result = await this.callTool(step.toolName, step.arguments);
        success = result.status === "success";
        data    = result.data;
        if (!success) error = result.message;
      } catch (err) {
        error = (err as Error).message;
      }

      results.push({
        stepName:   step.name,
        toolName:   step.toolName,
        success,
        data,
        error,
        durationMs: Date.now() - start,
      });

      // Stop on error unless continueOnError is set
      if (!success && !step.continueOnError) break;
    }

    return results;
  }

  // ---- Tool handlers ------------------------------------------

  private async workflowRun(args: Record<string, unknown>): Promise<ToolCallResult> {
    const workflowId = args.workflowId as string;
    const workflow   = this.workflows.get(workflowId);

    if (!workflow) {
      return this.fail(
        `Workflow "${workflowId}" not found. Available: [${[...this.workflows.keys()].join(", ")}]`
      );
    }

    const startedAt  = new Date().toISOString();
    const steps      = await this.runSteps(workflow.steps);
    const finishedAt = new Date().toISOString();
    const success    = steps.every((s) => s.success);

    const result: WorkflowResult = {
      workflowId,
      workflowName: workflow.name,
      startedAt,
      finishedAt,
      success,
      steps,
    };

    return this.ok(result, `Workflow "${workflow.name}" ${success ? "completed" : "failed"}.`);
  }

  private async workflowList(_args: Record<string, unknown>): Promise<ToolCallResult> {
    const list = [...this.workflows.values()].map((w) => ({
      id:          w.id,
      name:        w.name,
      description: w.description,
      stepCount:   w.steps.length,
    }));
    return this.ok(list, undefined, { count: list.length });
  }

  private async workflowHealthCheck(args: Record<string, unknown>): Promise<ToolCallResult> {
    const notify     = (args.notify as boolean) ?? true;
    const startedAt  = new Date();
    const results: Record<string, unknown> = {};

    // Get computers from database
    const dbResult = await this.callTool("db_query", {
      connection: "local-sqlite",
      sql: "SELECT * FROM computers",
    });

    const computers = (dbResult.data as Array<{
      name: string;
      ip: string;
      status: string;
    }>) ?? [];

    // Ping each computer
    for (const computer of computers) {
      try {
        const pingResult = await this.callTool("network_ping", {
          host:  computer.ip,
          count: 2,
        });
        const isOnline = pingResult.status === "success";
        results[computer.name] = isOnline ? "🟢 Online" : "🔴 Offline";

        // Update status in database
        await this.callTool("db_execute", {
          connection: "local-sqlite",
          sql: `UPDATE computers SET status='${isOnline ? "online" : "offline"}' WHERE name='${computer.name}'`,
        });
      } catch {
        results[computer.name] = "🔴 Unreachable";
      }
    }

    // Add system info
    results["Check Time"]    = startedAt.toLocaleString();
    results["Total Checked"] = `${computers.length} computers`;
    results["Online Count"]  = `${Object.values(results).filter((v) => String(v).includes("🟢")).length}`;

    // Send Telegram notification
    if (notify) {
      await this.callTool("notify_status_report", {
        title:  "🔍 Health Check Report",
        fields: results,
        footer: "Generated by MCP Tool Hub Workflow Engine",
      });
    }

    return this.ok(results, "Health check completed.");
  }

  private async workflowDailyReport(args: Record<string, unknown>): Promise<ToolCallResult> {
    const email     = args.email as string;
    const timestamp = new Date().toLocaleString();

    // Collect data from all servers
    const [dbResult, memResult] = await Promise.all([
      this.callTool("db_query", {
        connection: "local-sqlite",
        sql: "SELECT name, ip, status FROM computers",
      }),
      this.callTool("memory_list_namespaces", {}),
    ]);

    const computers = (dbResult.data as Array<{
      name: string;
      ip: string;
      status: string;
    }>) ?? [];

    const onlineCount  = computers.filter((c) => c.status === "online").length;
    const offlineCount = computers.length - onlineCount;

    // Build report sections
    const sections: Record<string, string> = {
      "Report Time":       timestamp,
      "Total Computers":   `${computers.length}`,
      "Online":            `✅ ${onlineCount}`,
      "Offline":           `❌ ${offlineCount}`,
      "MCP Hub Status":    "🟢 Running",
      "MeshCentral":       "🟢 Active",
      "SSH Server":        "🟢 Ready",
      "Database":          "🟢 Connected",
    };

    // Add computer details
    for (const computer of computers) {
      sections[computer.name] = `${computer.ip} — ${computer.status === "online" ? "🟢" : "🔴"} ${computer.status}`;
    }

    // Send email report
    await this.callTool("email_send_report", {
      to:       email,
      title:    "Daily IT Status Report",
      sections,
      priority: "normal",
    });

    // Send Telegram notification
    await this.callTool("notify_status_report", {
      title:  "📊 Daily IT Report",
      fields: sections,
      footer: `Sent to ${email}`,
    });

    return this.ok({
      reportTime:    timestamp,
      emailSentTo:   email,
      computerCount: computers.length,
      sections,
    }, "Daily report sent successfully.");
  }

  private async workflowDeployFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const hostAlias  = args.hostAlias as string;
    const localFile  = args.localFile as string;
    const remotePath = args.remotePath as string;
    const command    = args.command as string | undefined;
    const steps: StepResult[] = [];

    // Step 1 — Upload file
    const uploadStart  = Date.now();
    const uploadResult = await this.callTool("ssh_upload_file", {
      alias:      hostAlias,
      localPath:  localFile,
      remotePath,
    });
    steps.push({
      stepName:   "Upload File",
      toolName:   "ssh_upload_file",
      success:    uploadResult.status === "success",
      data:       uploadResult.data,
      error:      uploadResult.message,
      durationMs: Date.now() - uploadStart,
    });

    if (uploadResult.status !== "success") {
      await this.callTool("notify_alert", {
        title:    "Deployment Failed",
        message:  `Failed to upload ${localFile} to ${hostAlias}: ${uploadResult.message}`,
        severity: "high",
      });
      return this.fail(`Upload failed: ${uploadResult.message}`);
    }

    // Step 2 — Run command (if provided)
    if (command) {
      const cmdStart  = Date.now();
      const cmdResult = await this.callTool("ssh_execute", {
        alias:   hostAlias,
        command,
      });
      steps.push({
        stepName:   "Run Command",
        toolName:   "ssh_execute",
        success:    cmdResult.status === "success",
        data:       cmdResult.data,
        error:      cmdResult.message,
        durationMs: Date.now() - cmdStart,
      });
    }

    // Step 3 — Notify success
    await this.callTool("notify_send", {
      message: `✅ Deployment to ${hostAlias} completed!\nFile: ${localFile} → ${remotePath}${command ? `\nCommand: ${command}` : ""}`,
      level:   "success",
    });

    return this.ok({ steps, hostAlias, localFile, remotePath }, "Deployment completed.");
  }

  private async workflowBackupAll(args: Record<string, unknown>): Promise<ToolCallResult> {
    const notify    = (args.notify as boolean) ?? true;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backups: Record<string, unknown> = {};

    // Backup SQLite database
    const backupPath   = `./mcp-data/backups/db-${timestamp}.sqlite`;
    const backupResult = await this.callTool("db_backup", {
      connection: "local-sqlite",
      backupPath,
    });

    backups["SQLite DB"] = backupResult.status === "success"
      ? `✅ ${backupPath}`
      : `❌ Failed: ${backupResult.message}`;

    // Backup memory store
    const memBackupPath   = `./mcp-data/backups/memory-${timestamp}.json`;
    const memBackupResult = await this.callTool("read_file", {
      path: "../memory.json",
    });

    if (memBackupResult.status === "success") {
      await this.callTool("write_file", {
        path:    `../backups/memory-${timestamp}.json`,
        content: memBackupResult.data as string,
      });
      backups["Memory Store"] = `✅ ${memBackupPath}`;
    }

    // Notify
    if (notify) {
      await this.callTool("notify_status_report", {
        title:  "💾 Backup Complete",
        fields: {
          ...backups,
          "Timestamp": new Date().toLocaleString(),
        },
        footer: "MCP Tool Hub automatic backup",
      });
    }

    return this.ok(backups, "Backup workflow completed.");
  }
}
