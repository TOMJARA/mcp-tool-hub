// ============================================================
// @mcp-tool-hub/server-ssh — ssh-server.ts
//
// Allows the LLM to execute commands on pre-configured remote
// machines via SSH. Supports password and private key auth.
// Hosts must be pre-configured — no arbitrary connections.
// ============================================================

import { Client } from "ssh2";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

// ---- Data model -----------------------------------------------

export interface SSHHostConfig {
  /** Unique alias for this host e.g. "web-server-1" */
  alias: string;
  host: string;
  port?: number;
  username: string;
  /** Plain password (use privateKeyPath instead for production) */
  password?: string;
  /** Absolute path to private key file */
  privateKeyPath?: string;
  /** Optional passphrase for encrypted private keys */
  passphrase?: string;
  /** Human-readable description */
  description?: string;
}

// ---- Tool definitions -----------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "ssh_execute",
    description:
      "Execute a shell command on a remote machine via SSH. " +
      "Returns stdout, stderr, and exit code.",
    parameters: {
      alias: {
        type: "string",
        description: "The host alias as defined in the SSH hosts config",
        required: true,
      },
      command: {
        type: "string",
        description: "The shell command to execute on the remote host",
        required: true,
      },
      timeoutMs: {
        type: "number",
        description: "Command timeout in milliseconds. Defaults to 30000.",
        default: 30000,
      },
    },
  },
  {
    name: "ssh_check_connection",
    description: "Test if a host is reachable and authentication works.",
    parameters: {
      alias: {
        type: "string",
        description: "The host alias to test",
        required: true,
      },
    },
  },
  {
    name: "ssh_list_hosts",
    description: "List all configured SSH hosts available for connection.",
    parameters: {},
  },
  {
    name: "ssh_upload_file",
    description: "Upload a local file to a remote host via SFTP.",
    parameters: {
      alias: {
        type: "string",
        description: "The host alias",
        required: true,
      },
      localPath: {
        type: "string",
        description: "Local file path (relative to filesystem sandbox root)",
        required: true,
      },
      remotePath: {
        type: "string",
        description: "Full remote destination path e.g. /opt/myapp/config.yml",
        required: true,
      },
    },
  },
  {
    name: "ssh_download_file",
    description: "Download a file from a remote host via SFTP.",
    parameters: {
      alias: {
        type: "string",
        description: "The host alias",
        required: true,
      },
      remotePath: {
        type: "string",
        description: "Full remote file path to download",
        required: true,
      },
      localPath: {
        type: "string",
        description: "Local destination path (relative to filesystem sandbox root)",
        required: true,
      },
    },
  },
];

const SERVER_INFO: ServerInfo = {
  id: "ssh",
  name: "SSH Server",
  version: "1.0.0",
  description:
    "Execute commands and transfer files on pre-configured remote machines via SSH/SFTP.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class ---------------------------------------------

export interface SSHServerOptions {
  /**
   * Path to a JSON file containing SSHHostConfig[]
   * This is the only way to define hosts — the LLM cannot
   * add new hosts at runtime.
   */
  hostsConfigPath: string;
  /** Root path for local file operations (upload/download) */
  localFilesRoot: string;
  /** Max output characters to return from a command (default: 50000) */
  maxOutputChars?: number;
}

export class SSHServer extends BaseMCPServer {
  private hosts = new Map<string, SSHHostConfig>();
  private hostsConfigPath!: string;
  private localFilesRoot!: string;
  private maxOutputChars!: number;

  constructor(options: SSHServerOptions) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("ssh_execute",          this.sshExecute.bind(this));
    this.registerTool("ssh_check_connection", this.sshCheckConnection.bind(this));
    this.registerTool("ssh_list_hosts",       this.sshListHosts.bind(this));
    this.registerTool("ssh_upload_file",      this.sshUploadFile.bind(this));
    this.registerTool("ssh_download_file",    this.sshDownloadFile.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.hostsConfigPath = path.resolve(
      this.getOption<string>("hostsConfigPath", "./ssh-hosts.json")
    );
    this.localFilesRoot = path.resolve(
      this.getOption<string>("localFilesRoot", "./mcp-data/files")
    );
    this.maxOutputChars = this.getOption<number>("maxOutputChars", 50000);

    await this.loadHosts();
    console.log(`[ssh] Loaded ${this.hosts.size} host(s) from config`);
  }

  // ---- Host config loading ------------------------------------

  private async loadHosts(): Promise<void> {
    try {
      const raw = await fs.readFile(this.hostsConfigPath, "utf8");
      const configs = JSON.parse(raw) as SSHHostConfig[];
      this.hosts.clear();
      for (const cfg of configs) {
        this.hosts.set(cfg.alias, cfg);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Create a sample config file on first run
        const sample: SSHHostConfig[] = [
          {
            alias: "example-server",
            host: "192.168.1.100",
            port: 22,
            username: "admin",
            password: "your-password-here",
            description: "Example server — replace with your real hosts",
          },
        ];
        await fs.mkdir(path.dirname(this.hostsConfigPath), { recursive: true });
        await fs.writeFile(
          this.hostsConfigPath,
          JSON.stringify(sample, null, 2),
          "utf8"
        );
        console.log(`[ssh] Created sample hosts config at: ${this.hostsConfigPath}`);
        console.log(`[ssh] Edit this file to add your real SSH hosts.`);
      } else {
        throw err;
      }
    }
  }

  // ---- SSH connection helper ----------------------------------

  private async withSSH<T>(
    alias: string,
    callback: (client: Client) => Promise<T>
  ): Promise<T> {
    const cfg = this.hosts.get(alias);
    if (!cfg) {
      throw new Error(
        `Unknown host alias "${alias}". ` +
        `Available: [${[...this.hosts.keys()].join(", ")}]`
      );
    }

    const client = new Client();

    // Build connect config
    const connectConfig: Parameters<Client["connect"]>[0] = {
      host:     cfg.host,
      port:     cfg.port ?? 22,
      username: cfg.username,
      timeout:  10000,
    };

    if (cfg.privateKeyPath) {
      connectConfig.privateKey = await fs.readFile(cfg.privateKeyPath);
      if (cfg.passphrase) connectConfig.passphrase = cfg.passphrase;
    } else if (cfg.password) {
      connectConfig.password = cfg.password;
    }

    return new Promise<T>((resolve, reject) => {
      client.on("ready", async () => {
        try {
          const result = await callback(client);
          client.end();
          resolve(result);
        } catch (err) {
          client.end();
          reject(err);
        }
      });

      client.on("error", (err) => {
        reject(new Error(`SSH connection failed to "${alias}" (${cfg.host}): ${err.message}`));
      });

      client.connect(connectConfig);
    });
  }

  // ---- Tool handlers -----------------------------------------

  private async sshExecute(args: Record<string, unknown>): Promise<ToolCallResult> {
    const alias     = args.alias as string;
    const command   = args.command as string;
    const timeoutMs = (args.timeoutMs as number) ?? 30000;

    const result = await this.withSSH(alias, (client) => {
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve, reject) => {
          client.exec(command, (err, stream) => {
            if (err) return reject(err);

            let stdout = "";
            let stderr = "";

            stream.on("data", (chunk: Buffer) => {
              stdout += chunk.toString();
            });

            stream.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });

            const timer = setTimeout(() => {
              stream.close();
              reject(new Error(`Command timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            stream.on("close", (exitCode: number) => {
              clearTimeout(timer);

              // Truncate if too long
              if (stdout.length > this.maxOutputChars) {
                stdout = stdout.slice(0, this.maxOutputChars) +
                  `\n[... truncated at ${this.maxOutputChars} chars]`;
              }
              if (stderr.length > this.maxOutputChars) {
                stderr = stderr.slice(0, this.maxOutputChars) +
                  `\n[... truncated]`;
              }

              resolve({ stdout, stderr, exitCode });
            });
          });
        }
      );
    });

    return this.ok(result, undefined, { alias, command });
  }

  private async sshCheckConnection(args: Record<string, unknown>): Promise<ToolCallResult> {
    const alias = args.alias as string;
    const start = Date.now();

    await this.withSSH(alias, async () => {
      // Just connecting is enough to verify auth works
    });

    const cfg = this.hosts.get(alias)!;
    return this.ok({
      alias,
      host: cfg.host,
      port: cfg.port ?? 22,
      username: cfg.username,
      reachable: true,
      responseTimeMs: Date.now() - start,
    }, "Connection successful.");
  }

  private async sshListHosts(_args: Record<string, unknown>): Promise<ToolCallResult> {
    const hosts = [...this.hosts.values()].map((cfg) => ({
      alias:       cfg.alias,
      host:        cfg.host,
      port:        cfg.port ?? 22,
      username:    cfg.username,
      authMethod:  cfg.privateKeyPath ? "private-key" : "password",
      description: cfg.description ?? "",
    }));

    return this.ok(hosts, undefined, { count: hosts.length });
  }

  private async sshUploadFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const alias      = args.alias as string;
    const localPath  = path.resolve(this.localFilesRoot, args.localPath as string);
    const remotePath = args.remotePath as string;

    // Security: ensure local path stays within sandbox
    if (!localPath.startsWith(this.localFilesRoot)) {
      return this.fail("Access denied: localPath escapes the sandbox root.");
    }

    const fileContent = await fs.readFile(localPath);

    await this.withSSH(alias, (client) => {
      return new Promise<void>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(err);

          const writeStream = sftp.createWriteStream(remotePath);
          writeStream.on("close", resolve);
          writeStream.on("error", reject);
          writeStream.end(fileContent);
        });
      });
    });

    return this.ok({
      alias,
      localPath:  args.localPath,
      remotePath,
      sizeBytes:  fileContent.length,
    }, "File uploaded successfully.");
  }

  private async sshDownloadFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const alias      = args.alias as string;
    const remotePath = args.remotePath as string;
    const localPath  = path.resolve(this.localFilesRoot, args.localPath as string);

    // Security: ensure local path stays within sandbox
    if (!localPath.startsWith(this.localFilesRoot)) {
      return this.fail("Access denied: localPath escapes the sandbox root.");
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });

    const fileContent = await this.withSSH(alias, (client) => {
      return new Promise<Buffer>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(err);

          const chunks: Buffer[] = [];
          const readStream = sftp.createReadStream(remotePath);
          readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          readStream.on("end", () => resolve(Buffer.concat(chunks)));
          readStream.on("error", reject);
        });
      });
    });

    await fs.writeFile(localPath, fileContent);

    return this.ok({
      alias,
      remotePath,
      localPath:  args.localPath,
      sizeBytes:  fileContent.length,
    }, "File downloaded successfully.");
  }
}
