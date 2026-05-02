// ============================================================
// @mcp-tool-hub/server-docker — docker-server.ts
//
// Allows the LLM to manage Docker containers and images.
// Uses the Docker CLI via child_process — no extra deps needed.
// Can work locally or via SSH tunnel to a remote Docker host.
// ============================================================

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

const execAsync = promisify(exec);

// ---- Tool definitions -----------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "docker_list_containers",
    description: "List all Docker containers (running and stopped).",
    parameters: {
      all: {
        type: "boolean",
        description: "Include stopped containers. Defaults to true.",
        default: true,
      },
    },
  },
  {
    name: "docker_start_container",
    description: "Start a stopped Docker container.",
    parameters: {
      container: {
        type: "string",
        description: "Container name or ID",
        required: true,
      },
    },
  },
  {
    name: "docker_stop_container",
    description: "Stop a running Docker container.",
    parameters: {
      container: {
        type: "string",
        description: "Container name or ID",
        required: true,
      },
      timeout: {
        type: "number",
        description: "Seconds to wait before killing. Defaults to 10.",
        default: 10,
      },
    },
  },
  {
    name: "docker_restart_container",
    description: "Restart a Docker container.",
    parameters: {
      container: {
        type: "string",
        description: "Container name or ID",
        required: true,
      },
    },
  },
  {
    name: "docker_get_logs",
    description: "Get logs from a Docker container.",
    parameters: {
      container: {
        type: "string",
        description: "Container name or ID",
        required: true,
      },
      lines: {
        type: "number",
        description: "Number of lines to return. Defaults to 50.",
        default: 50,
      },
      since: {
        type: "string",
        description: "Show logs since this time e.g. '1h', '30m', '2024-01-01'",
      },
    },
  },
  {
    name: "docker_list_images",
    description: "List all Docker images on the system.",
    parameters: {},
  },
  {
    name: "docker_pull_image",
    description: "Pull a Docker image from Docker Hub or a registry.",
    parameters: {
      image: {
        type: "string",
        description: "Image name and tag e.g. 'nginx:latest', 'ubuntu:22.04'",
        required: true,
      },
    },
  },
  {
    name: "docker_exec_command",
    description: "Execute a command inside a running container.",
    parameters: {
      container: {
        type: "string",
        description: "Container name or ID",
        required: true,
      },
      command: {
        type: "string",
        description: "Command to run inside the container",
        required: true,
      },
    },
  },
  {
    name: "docker_inspect",
    description: "Get detailed information about a container or image.",
    parameters: {
      target: {
        type: "string",
        description: "Container or image name/ID to inspect",
        required: true,
      },
    },
  },
  {
    name: "docker_system_stats",
    description: "Get real-time CPU and memory usage of running containers.",
    parameters: {},
  },
];

const SERVER_INFO: ServerInfo = {
  id: "docker",
  name: "Docker Server",
  version: "1.0.0",
  description:
    "Manage Docker containers and images: list, start, stop, logs, exec, and stats.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class ---------------------------------------------

export interface DockerServerOptions {
  /** Optional: DOCKER_HOST env variable for remote Docker daemon */
  dockerHost?: string;
  /** Max output characters (default: 50000) */
  maxOutputChars?: number;
}

export class DockerServer extends BaseMCPServer {
  private dockerHost: string = "";
  private maxOutputChars!: number;

  constructor(options: DockerServerOptions = {}) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("docker_list_containers", this.listContainers.bind(this));
    this.registerTool("docker_start_container", this.startContainer.bind(this));
    this.registerTool("docker_stop_container",  this.stopContainer.bind(this));
    this.registerTool("docker_restart_container", this.restartContainer.bind(this));
    this.registerTool("docker_get_logs",        this.getLogs.bind(this));
    this.registerTool("docker_list_images",     this.listImages.bind(this));
    this.registerTool("docker_pull_image",      this.pullImage.bind(this));
    this.registerTool("docker_exec_command",    this.execCommand.bind(this));
    this.registerTool("docker_inspect",         this.inspect.bind(this));
    this.registerTool("docker_system_stats",    this.systemStats.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.dockerHost     = this.getOption<string>("dockerHost", "");
    this.maxOutputChars = this.getOption<number>("maxOutputChars", 50000);

    // Verify docker is available
    try {
      await this.docker("version --format '{{.Server.Version}}'");
      console.log(`[docker] Docker daemon connected successfully`);
    } catch {
      console.warn(`[docker] WARNING: Docker not available. ` +
        `Server will load but tools will fail until Docker is installed.`);
    }
  }

  // ---- Docker CLI helper ---------------------------------------

  private async docker(args: string): Promise<string> {
    const env = this.dockerHost
      ? { ...process.env, DOCKER_HOST: this.dockerHost }
      : process.env;

    const { stdout, stderr } = await execAsync(`docker ${args}`, {
      env,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stderr && !stdout) throw new Error(stderr.trim());
    return stdout.trim();
  }

  private truncate(text: string): string {
    if (text.length > this.maxOutputChars) {
      return text.slice(0, this.maxOutputChars) +
        `\n[... truncated at ${this.maxOutputChars} chars]`;
    }
    return text;
  }

  // ---- Tool handlers -------------------------------------------

  private async listContainers(args: Record<string, unknown>): Promise<ToolCallResult> {
    const all  = (args.all as boolean) ?? true;
    const flag = all ? "-a" : "";
    const fmt  = '--format "{{json .}}"';

    const raw = await this.docker(`ps ${flag} ${fmt}`);
    const containers = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return this.ok(containers, undefined, { count: containers.length });
  }

  private async startContainer(args: Record<string, unknown>): Promise<ToolCallResult> {
    const container = args.container as string;
    await this.docker(`start ${container}`);
    return this.ok({ container, action: "started" }, `Container "${container}" started.`);
  }

  private async stopContainer(args: Record<string, unknown>): Promise<ToolCallResult> {
    const container = args.container as string;
    const timeout   = (args.timeout as number) ?? 10;
    await this.docker(`stop -t ${timeout} ${container}`);
    return this.ok({ container, action: "stopped" }, `Container "${container}" stopped.`);
  }

  private async restartContainer(args: Record<string, unknown>): Promise<ToolCallResult> {
    const container = args.container as string;
    await this.docker(`restart ${container}`);
    return this.ok({ container, action: "restarted" }, `Container "${container}" restarted.`);
  }

  private async getLogs(args: Record<string, unknown>): Promise<ToolCallResult> {
    const container = args.container as string;
    const lines     = (args.lines as number) ?? 50;
    const since     = args.since ? `--since ${args.since}` : "";

    const logs = await this.docker(`logs --tail ${lines} ${since} ${container} 2>&1`);
    return this.ok(this.truncate(logs));
  }

  private async listImages(_args: Record<string, unknown>): Promise<ToolCallResult> {
    const fmt = '--format "{{json .}}"';
    const raw = await this.docker(`images ${fmt}`);
    const images = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return this.ok(images, undefined, { count: images.length });
  }

  private async pullImage(args: Record<string, unknown>): Promise<ToolCallResult> {
    const image = args.image as string;
    const output = await this.docker(`pull ${image}`);
    return this.ok({ image, output: this.truncate(output) }, `Image "${image}" pulled.`);
  }

  private async execCommand(args: Record<string, unknown>): Promise<ToolCallResult> {
    const container = args.container as string;
    const command   = args.command as string;
    const output    = await this.docker(`exec ${container} ${command}`);
    return this.ok(this.truncate(output));
  }

  private async inspect(args: Record<string, unknown>): Promise<ToolCallResult> {
    const target = args.target as string;
    const raw    = await this.docker(`inspect ${target}`);
    const data   = JSON.parse(raw);
    return this.ok(data);
  }

  private async systemStats(_args: Record<string, unknown>): Promise<ToolCallResult> {
    const fmt = '--format "{{json .}}"';
    const raw = await this.docker(`stats --no-stream ${fmt}`);
    const stats = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return this.ok(stats, undefined, { count: stats.length });
  }
}
