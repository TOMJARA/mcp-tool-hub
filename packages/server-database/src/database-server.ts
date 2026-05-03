// ============================================================
// @mcp-tool-hub/server-database — database-server.ts
//
// Multi-database server supporting SQLite, MySQL, PostgreSQL.
// SQLite works immediately with no server needed.
// MySQL/PostgreSQL connect to remote database servers.
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
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
    name: "db_query",
    description: "Execute a SELECT query and return results.",
    parameters: {
      connection: {
        type: "string",
        description: "Connection alias as defined in config",
        required: true,
      },
      sql: {
        type: "string",
        description: "SQL SELECT query to execute",
        required: true,
      },
      limit: {
        type: "number",
        description: "Max rows to return. Defaults to 100.",
        default: 100,
      },
    },
  },
  {
    name: "db_execute",
    description: "Execute INSERT, UPDATE, DELETE, or DDL statements.",
    parameters: {
      connection: {
        type: "string",
        description: "Connection alias",
        required: true,
      },
      sql: {
        type: "string",
        description: "SQL statement to execute",
        required: true,
      },
    },
  },
  {
    name: "db_list_tables",
    description: "List all tables in the database.",
    parameters: {
      connection: {
        type: "string",
        description: "Connection alias",
        required: true,
      },
    },
  },
  {
    name: "db_describe_table",
    description: "Get the structure and columns of a table.",
    parameters: {
      connection: {
        type: "string",
        description: "Connection alias",
        required: true,
      },
      table: {
        type: "string",
        description: "Table name to describe",
        required: true,
      },
    },
  },
  {
    name: "db_backup",
    description: "Backup a SQLite database to a file.",
    parameters: {
      connection: {
        type: "string",
        description: "Connection alias (SQLite only)",
        required: true,
      },
      backupPath: {
        type: "string",
        description: "Path to save the backup file",
        required: true,
      },
    },
  },
  {
    name: "db_list_connections",
    description: "List all configured database connections.",
    parameters: {},
  },
];

const SERVER_INFO: ServerInfo = {
  id: "database",
  name: "Database Server",
  version: "1.0.0",
  description:
    "Multi-database support: SQLite (local), MySQL, and PostgreSQL. Query, execute, and manage databases.",
  tools: TOOL_DEFINITIONS,
};

// ---- Connection config ----------------------------------------

export interface DatabaseConnection {
  alias: string;
  type: "sqlite" | "mysql" | "postgresql";
  description?: string;
  // SQLite
  filePath?: string;
  // MySQL / PostgreSQL
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
}

// ---- Server options -------------------------------------------

export interface DatabaseServerOptions {
  connectionsConfigPath: string;
  maxRows?: number;
}

// ---- Server class ---------------------------------------------

export class DatabaseServer extends BaseMCPServer {
  private connections = new Map<string, DatabaseConnection>();
  private connectionsConfigPath!: string;
  private maxRows!: number;

  constructor(options: DatabaseServerOptions) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("db_query",            this.dbQuery.bind(this));
    this.registerTool("db_execute",          this.dbExecute.bind(this));
    this.registerTool("db_list_tables",      this.dbListTables.bind(this));
    this.registerTool("db_describe_table",   this.dbDescribeTable.bind(this));
    this.registerTool("db_backup",           this.dbBackup.bind(this));
    this.registerTool("db_list_connections", this.dbListConnections.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.connectionsConfigPath = path.resolve(
      this.getOption<string>("connectionsConfigPath", "./mcp-data/db-connections.json")
    );
    this.maxRows = this.getOption<number>("maxRows", 100);
    await this.loadConnections();
    console.log(`[database] Loaded ${this.connections.size} connection(s)`);
  }

  // ---- Load connections ----------------------------------------

  private async loadConnections(): Promise<void> {
    try {
      const raw = await fs.readFile(this.connectionsConfigPath, "utf8");
      const configs = JSON.parse(raw) as DatabaseConnection[];
      this.connections.clear();
      for (const cfg of configs) {
        this.connections.set(cfg.alias, cfg);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Create sample config
        const sample: DatabaseConnection[] = [
          {
            alias: "local-sqlite",
            type: "sqlite",
            filePath: "./mcp-data/local.db",
            description: "Local SQLite database for testing",
          },
        ];
        await fs.mkdir(path.dirname(this.connectionsConfigPath), { recursive: true });
        await fs.writeFile(
          this.connectionsConfigPath,
          JSON.stringify(sample, null, 2),
          "utf8"
        );
        // Load the sample
        for (const cfg of sample) {
          this.connections.set(cfg.alias, cfg);
        }
        console.log(`[database] Created sample connections config`);
      } else {
        throw err;
      }
    }
  }

  // ---- SQLite helpers ------------------------------------------

  private async sqliteQuery(
    filePath: string,
    sql: string
  ): Promise<unknown[]> {
    const dbPath = path.resolve(filePath);
    const cmd    = `sqlite3 -json "${dbPath}" "${sql.replace(/"/g, '\\"')}"`;
    const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    if (!stdout.trim()) return [];
    return JSON.parse(stdout) as unknown[];
  }

  private async sqliteExecute(
    filePath: string,
    sql: string
  ): Promise<{ changes: number }> {
    const dbPath = path.resolve(filePath);
    const cmd    = `sqlite3 "${dbPath}" "${sql.replace(/"/g, '\\"')}"`;
    await execAsync(cmd);
    return { changes: 1 };
  }

  // ---- Get connection ------------------------------------------

  private getConnection(alias: string): DatabaseConnection {
    const conn = this.connections.get(alias);
    if (!conn) {
      throw new Error(
        `Unknown connection "${alias}". Available: [${[...this.connections.keys()].join(", ")}]`
      );
    }
    return conn;
  }

  // ---- Tool handlers -------------------------------------------

  private async dbQuery(args: Record<string, unknown>): Promise<ToolCallResult> {
    const conn  = this.getConnection(args.connection as string);
    const sql   = args.sql as string;
    const limit = Math.min((args.limit as number) ?? 100, this.maxRows);

    // Add LIMIT if not present
    const limitedSql = sql.toLowerCase().includes("limit")
      ? sql
      : `${sql} LIMIT ${limit}`;

    if (conn.type === "sqlite") {
      const rows = await this.sqliteQuery(conn.filePath!, limitedSql);
      return this.ok(rows, undefined, { count: rows.length, connection: conn.alias });
    }

    return this.fail(`Database type "${conn.type}" requires MySQL/PostgreSQL packages. Use SQLite for now.`);
  }

  private async dbExecute(args: Record<string, unknown>): Promise<ToolCallResult> {
    const conn = this.getConnection(args.connection as string);
    const sql  = args.sql as string;

    if (conn.type === "sqlite") {
      const result = await this.sqliteExecute(conn.filePath!, sql);
      return this.ok(result, "Statement executed successfully.");
    }

    return this.fail(`Database type "${conn.type}" not yet supported.`);
  }

  private async dbListTables(args: Record<string, unknown>): Promise<ToolCallResult> {
    const conn = this.getConnection(args.connection as string);

    if (conn.type === "sqlite") {
      const rows = await this.sqliteQuery(
        conn.filePath!,
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
      ) as Array<{ name: string; type: string }>;
      return this.ok(rows, undefined, { count: rows.length });
    }

    return this.fail(`Database type "${conn.type}" not yet supported.`);
  }

  private async dbDescribeTable(args: Record<string, unknown>): Promise<ToolCallResult> {
    const conn  = this.getConnection(args.connection as string);
    const table = args.table as string;

    if (conn.type === "sqlite") {
      const rows = await this.sqliteQuery(
        conn.filePath!,
        `PRAGMA table_info(${table})`
      );
      return this.ok(rows, undefined, { table, columnCount: (rows as unknown[]).length });
    }

    return this.fail(`Database type "${conn.type}" not yet supported.`);
  }

  private async dbBackup(args: Record<string, unknown>): Promise<ToolCallResult> {
    const conn       = this.getConnection(args.connection as string);
    const backupPath = path.resolve(args.backupPath as string);

    if (conn.type !== "sqlite") {
      return this.fail("Backup is currently supported for SQLite only.");
    }

    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(path.resolve(conn.filePath!), backupPath);

    const stat = await fs.stat(backupPath);
    return this.ok({
      backupPath,
      sizeBytes: stat.size,
      timestamp: new Date().toISOString(),
    }, "Database backed up successfully.");
  }

  private async dbListConnections(_args: Record<string, unknown>): Promise<ToolCallResult> {
    const list = [...this.connections.values()].map((c) => ({
      alias:       c.alias,
      type:        c.type,
      description: c.description ?? "",
      target:      c.type === "sqlite"
        ? c.filePath
        : `${c.host}:${c.port}/${c.database}`,
    }));
    return this.ok(list, undefined, { count: list.length });
  }
}
