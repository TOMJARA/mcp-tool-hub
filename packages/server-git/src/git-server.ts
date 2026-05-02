// ============================================================
// @mcp-tool-hub/server-git — git-server.ts
//
// Allows the LLM to read and inspect Git repositories.
// Uses the system `git` binary via child_process (no extra deps).
// Write operations (commit, push) are intentionally excluded
// for safety — the LLM can read code, not change history.
// ============================================================

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

const execAsync = promisify(exec);

// ---- Tool definitions ------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "git_log",
    description: "Get the commit history for a repository or specific file.",
    parameters: {
      repoPath: {
        type: "string",
        description: "Relative path to the repository",
        required: true,
      },
      filePath: {
        type: "string",
        description: "Optional: limit log to commits touching this file",
      },
      limit: {
        type: "number",
        description: "Max number of commits to return (default: 20)",
        default: 20,
      },
    },
  },
  {
    name: "git_show_file",
    description: "Show the contents of a file at a specific commit.",
    parameters: {
      repoPath: {
        type: "string",
        description: "Relative path to the repository",
        required: true,
      },
      filePath: {
        type: "string",
        description: "Path to the file within the repository",
        required: true,
      },
      ref: {
        type: "string",
        description: 'Git ref (commit hash, branch, tag). Defaults to "HEAD".',
        default: "HEAD",
      },
    },
  },
  {
    name: "git_diff",
    description: "Show the diff for a specific commit, or between two refs.",
    parameters: {
      repoPath: {
        type: "string",
        description: "Relative path to the repository",
        required: true,
      },
      fromRef: {
        type: "string",
        description: "Base ref (commit hash, branch, or tag)",
        required: true,
      },
      toRef: {
        type: "string",
        description: 'Target ref. Defaults to "HEAD".',
        default: "HEAD",
      },
      filePath: {
        type: "string",
        description: "Optional: limit diff to this file path",
      },
    },
  },
  {
    name: "git_status",
    description: "Get the working tree status (modified, staged, untracked files).",
    parameters: {
      repoPath: {
        type: "string",
        description: "Relative path to the repository",
        required: true,
      },
    },
  },
  {
    name: "git_branches",
    description: "List all local (and optionally remote) branches.",
    parameters: {
      repoPath: {
        type: "string",
        description: "Relative path to the repository",
        required: true,
      },
      includeRemote: {
        type: "boolean",
        description: "Include remote-tracking branches. Defaults to false.",
        default: false,
      },
    },
  },
  {
    name: "git_show_commit",
    description: "Show the full details and diff of a single commit.",
    parameters: {
      repoPath: {
        type: "string",
        description: "Relative path to the repository",
        required: true,
      },
      ref: {
        type: "string",
        description: "Commit hash or ref to inspect",
        required: true,
      },
    },
  },
];

const SERVER_INFO: ServerInfo = {
  id: "git",
  name: "Git Server",
  version: "1.0.0",
  description: "Read-only access to Git repositories: log, diff, file content, branches, and status.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class ----------------------------------------------

export interface GitServerOptions {
  /** Absolute base path — repo paths are resolved relative to this */
  workspacePath: string;
}

export class GitServer extends BaseMCPServer {
  private workspacePath!: string;

  constructor(options: GitServerOptions) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("git_log",         this.gitLog.bind(this));
    this.registerTool("git_show_file",   this.gitShowFile.bind(this));
    this.registerTool("git_diff",        this.gitDiff.bind(this));
    this.registerTool("git_status",      this.gitStatus.bind(this));
    this.registerTool("git_branches",    this.gitBranches.bind(this));
    this.registerTool("git_show_commit", this.gitShowCommit.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.workspacePath = path.resolve(
      this.getOption<string>("workspacePath", process.cwd())
    );
    // Verify git is available
    try {
      await execAsync("git --version");
    } catch {
      throw new Error("[git] `git` binary not found. Please install Git.");
    }
  }

  // ---- Security helpers ----------------------------------------

  private resolveRepo(relativePath: string): string {
    const resolved = path.resolve(this.workspacePath, relativePath);
    if (!resolved.startsWith(this.workspacePath)) {
      throw new Error(`Access denied: repo path "${relativePath}" escapes workspace.`);
    }
    return resolved;
  }

  /** Sanitize a git ref to prevent shell injection */
  private sanitizeRef(ref: string): string {
    if (!/^[a-zA-Z0-9_./~^@{}\-]+$/.test(ref)) {
      throw new Error(`Invalid git ref: "${ref}"`);
    }
    return ref;
  }

  private async runGit(repoPath: string, args: string): Promise<string> {
    const { stdout, stderr } = await execAsync(`git -C "${repoPath}" ${args}`, {
      maxBuffer: 5 * 1024 * 1024, // 5MB
    });
    if (stderr && !stdout) throw new Error(stderr.trim());
    return stdout.trim();
  }

  // ---- Tool handlers -------------------------------------------

  private async gitLog(args: Record<string, unknown>): Promise<ToolCallResult> {
    const repoPath = this.resolveRepo(args.repoPath as string);
    const limit    = Math.min((args.limit as number) ?? 20, 100);
    const file     = args.filePath ? `-- "${args.filePath}"` : "";
    const format   = "--pretty=format:%H|%an|%ae|%ad|%s --date=iso";

    const raw = await this.runGit(repoPath, `log -${limit} ${format} ${file}`);
    const commits = raw.split("\n").filter(Boolean).map((line) => {
      const [hash, author, email, date, ...subjectParts] = line.split("|");
      return { hash, author, email, date, subject: subjectParts.join("|") };
    });

    return this.ok(commits, undefined, { count: commits.length });
  }

  private async gitShowFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const repoPath = this.resolveRepo(args.repoPath as string);
    const ref      = this.sanitizeRef((args.ref as string) ?? "HEAD");
    const filePath = args.filePath as string;

    const content = await this.runGit(repoPath, `show ${ref}:"${filePath}"`);
    return this.ok(content);
  }

  private async gitDiff(args: Record<string, unknown>): Promise<ToolCallResult> {
    const repoPath = this.resolveRepo(args.repoPath as string);
    const fromRef  = this.sanitizeRef(args.fromRef as string);
    const toRef    = this.sanitizeRef((args.toRef as string) ?? "HEAD");
    const file     = args.filePath ? `-- "${args.filePath}"` : "";

    const diff = await this.runGit(repoPath, `diff ${fromRef} ${toRef} ${file}`);
    return this.ok(diff);
  }

  private async gitStatus(args: Record<string, unknown>): Promise<ToolCallResult> {
    const repoPath = this.resolveRepo(args.repoPath as string);
    const raw = await this.runGit(repoPath, "status --porcelain");

    const files = raw.split("\n").filter(Boolean).map((line) => ({
      status: line.substring(0, 2).trim(),
      path:   line.substring(3).trim(),
    }));

    return this.ok({ files }, undefined, { count: files.length });
  }

  private async gitBranches(args: Record<string, unknown>): Promise<ToolCallResult> {
    const repoPath      = this.resolveRepo(args.repoPath as string);
    const includeRemote = (args.includeRemote as boolean) ?? false;
    const flag          = includeRemote ? "-a" : "";

    const raw = await this.runGit(repoPath, `branch ${flag} --format="%(refname:short)|%(objectname:short)|%(subject)"`);
    const branches = raw.split("\n").filter(Boolean).map((line) => {
      const [name, hash, ...descParts] = line.replace(/^"(.*)"$/, "$1").split("|");
      return { name, hash, description: descParts.join("|") };
    });

    return this.ok(branches);
  }

  private async gitShowCommit(args: Record<string, unknown>): Promise<ToolCallResult> {
    const repoPath = this.resolveRepo(args.repoPath as string);
    const ref      = this.sanitizeRef(args.ref as string);

    const details = await this.runGit(repoPath, `show ${ref} --stat`);
    return this.ok(details);
  }
}
