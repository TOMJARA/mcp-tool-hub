// ============================================================
// @mcp-tool-hub/server-filesystem — filesystem-server.ts
//
// Provides the LLM with secure, sandboxed access to the local
// filesystem. ALL operations are restricted to an allowed root
// directory — path traversal attacks are blocked.
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

// ---- Tool definitions (visible to the LLM) --------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the full contents of a file at the given path.",
    parameters: {
      path: {
        type: "string",
        description: "Relative path to the file (relative to the allowed root)",
        required: true,
      },
      encoding: {
        type: "string",
        description: 'File encoding. Defaults to "utf8".',
        enum: ["utf8", "base64"],
        default: "utf8",
      },
    },
  },
  {
    name: "write_file",
    description: "Write (or overwrite) content to a file. Creates parent directories if needed.",
    parameters: {
      path: {
        type: "string",
        description: "Relative path to the file",
        required: true,
      },
      content: {
        type: "string",
        description: "Text content to write",
        required: true,
      },
      append: {
        type: "boolean",
        description: "If true, append instead of overwrite. Defaults to false.",
        default: false,
      },
    },
  },
  {
    name: "list_directory",
    description: "List files and subdirectories at a given path.",
    parameters: {
      path: {
        type: "string",
        description: 'Relative directory path. Use "." for root.',
        required: true,
      },
      recursive: {
        type: "boolean",
        description: "If true, list all nested entries. Defaults to false.",
        default: false,
      },
    },
  },
  {
    name: "delete_file",
    description: "Delete a file. Will NOT delete directories.",
    parameters: {
      path: {
        type: "string",
        description: "Relative path to the file to delete",
        required: true,
      },
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory.",
    parameters: {
      source: {
        type: "string",
        description: "Relative source path",
        required: true,
      },
      destination: {
        type: "string",
        description: "Relative destination path",
        required: true,
      },
    },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file or directory (size, dates, type).",
    parameters: {
      path: {
        type: "string",
        description: "Relative path",
        required: true,
      },
    },
  },
];

const SERVER_INFO: ServerInfo = {
  id: "filesystem",
  name: "Filesystem Server",
  version: "1.0.0",
  description: "Secure sandboxed access to local filesystem within an allowed root directory.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class -----------------------------------------------

export interface FilesystemServerOptions {
  /** Absolute path to the directory the LLM is allowed to access */
  allowedRoot: string;
  /** Max file size in bytes that can be read (default: 10MB) */
  maxReadBytes?: number;
}

export class FilesystemServer extends BaseMCPServer {
  private allowedRoot!: string;
  private maxReadBytes!: number;

  constructor(options: FilesystemServerOptions) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("read_file",      this.readFile.bind(this));
    this.registerTool("write_file",     this.writeFile.bind(this));
    this.registerTool("list_directory", this.listDirectory.bind(this));
    this.registerTool("delete_file",    this.deleteFile.bind(this));
    this.registerTool("move_file",      this.moveFile.bind(this));
    this.registerTool("get_file_info",  this.getFileInfo.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.allowedRoot = path.resolve(
      this.getOption<string>("allowedRoot", process.cwd())
    );
    this.maxReadBytes = this.getOption<number>("maxReadBytes", 10 * 1024 * 1024);

    // Ensure the root exists
    await fs.mkdir(this.allowedRoot, { recursive: true });
    console.log(`[filesystem] Sandboxed to: ${this.allowedRoot}`);
  }

  // ---- Security: resolve & verify path stays within root --------

  private resolveSafe(relativePath: string): string {
    const resolved = path.resolve(this.allowedRoot, relativePath);
    if (!resolved.startsWith(this.allowedRoot + path.sep) && resolved !== this.allowedRoot) {
      throw new Error(`Access denied: path "${relativePath}" escapes the allowed root.`);
    }
    return resolved;
  }

  // ---- Tool handlers --------------------------------------------

  private async readFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const filePath  = this.resolveSafe(args.path as string);
    const encoding  = (args.encoding as BufferEncoding) ?? "utf8";

    const stat = await fs.stat(filePath);
    if (stat.size > this.maxReadBytes) {
      return this.fail(
        `File is ${stat.size} bytes, which exceeds the max of ${this.maxReadBytes} bytes.`
      );
    }

    const content = await fs.readFile(filePath, { encoding });
    return this.ok(content, undefined, { sizeBytes: stat.size, encoding });
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const filePath = this.resolveSafe(args.path as string);
    const content  = args.content as string;
    const append   = (args.append as boolean) ?? false;

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (append) {
      await fs.appendFile(filePath, content, "utf8");
    } else {
      await fs.writeFile(filePath, content, "utf8");
    }

    return this.ok({ path: args.path, append }, `File ${append ? "appended" : "written"} successfully.`);
  }

  private async listDirectory(args: Record<string, unknown>): Promise<ToolCallResult> {
    const dirPath   = this.resolveSafe(args.path as string);
    const recursive = (args.recursive as boolean) ?? false;

    const entries = await this.readDir(dirPath, recursive);
    return this.ok(entries, undefined, { count: entries.length });
  }

  private async readDir(dirPath: string, recursive: boolean): Promise<object[]> {
    const raw = await fs.readdir(dirPath, { withFileTypes: true });
    const entries: object[] = [];

    for (const entry of raw) {
      const fullPath = path.join(dirPath, entry.name);
      const relPath  = path.relative(this.allowedRoot, fullPath);

      if (entry.isDirectory()) {
        entries.push({ name: entry.name, path: relPath, type: "directory" });
        if (recursive) {
          entries.push(...await this.readDir(fullPath, true));
        }
      } else {
        const stat = await fs.stat(fullPath);
        entries.push({
          name: entry.name,
          path: relPath,
          type: "file",
          sizeBytes: stat.size,
        });
      }
    }

    return entries;
  }

  private async deleteFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const filePath = this.resolveSafe(args.path as string);
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      return this.fail("delete_file cannot delete directories. Use a directory-specific tool.");
    }

    await fs.unlink(filePath);
    return this.ok({ deleted: args.path }, "File deleted successfully.");
  }

  private async moveFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const src  = this.resolveSafe(args.source as string);
    const dest = this.resolveSafe(args.destination as string);

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);

    return this.ok({ source: args.source, destination: args.destination }, "Moved successfully.");
  }

  private async getFileInfo(args: Record<string, unknown>): Promise<ToolCallResult> {
    const filePath = this.resolveSafe(args.path as string);
    const stat = await fs.stat(filePath);

    return this.ok({
      path: args.path,
      type: stat.isDirectory() ? "directory" : "file",
      sizeBytes: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      accessedAt: stat.atime.toISOString(),
    });
  }
}
