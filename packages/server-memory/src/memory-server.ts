// ============================================================
// @mcp-tool-hub/server-memory — memory-server.ts
//
// Gives the LLM a persistent, searchable key-value knowledge
// base backed by a local JSON file. Survives restarts.
// Entries have namespaces, tags, and full-text search.
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

// ---- Data model ------------------------------------------------

export interface MemoryEntry {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemoryStore {
  version: number;
  entries: Record<string, MemoryEntry>; // keyed by id
}

// ---- Tool definitions ------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "memory_set",
    description: "Store a value in the persistent memory with a key and optional namespace/tags.",
    parameters: {
      key: {
        type: "string",
        description: "Unique key within the namespace",
        required: true,
      },
      value: {
        type: "object",
        description: "The value to store (any JSON-serializable value)",
        required: true,
      },
      namespace: {
        type: "string",
        description: 'Logical grouping (e.g. "user_prefs", "project_state"). Defaults to "default".',
        default: "default",
      },
      tags: {
        type: "array",
        description: "Optional tags for filtering",
        items: { type: "string", description: "tag" },
      },
    },
  },
  {
    name: "memory_get",
    description: "Retrieve a memory entry by key (and optional namespace).",
    parameters: {
      key: {
        type: "string",
        description: "The key to look up",
        required: true,
      },
      namespace: {
        type: "string",
        description: 'Namespace to search in. Defaults to "default".',
        default: "default",
      },
    },
  },
  {
    name: "memory_search",
    description:
      "Search memory entries by namespace, tags, or text in keys/values. " +
      "Returns matching entries.",
    parameters: {
      query: {
        type: "string",
        description: "Text to search for in keys and string values",
      },
      namespace: {
        type: "string",
        description: "Filter by namespace",
      },
      tags: {
        type: "array",
        description: "Filter entries that have ALL of these tags",
        items: { type: "string", description: "tag" },
      },
      limit: {
        type: "number",
        description: "Max results to return (default: 20)",
        default: 20,
      },
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory entry by key.",
    parameters: {
      key: {
        type: "string",
        description: "Key to delete",
        required: true,
      },
      namespace: {
        type: "string",
        description: 'Namespace. Defaults to "default".',
        default: "default",
      },
    },
  },
  {
    name: "memory_list_namespaces",
    description: "List all namespaces in the memory store with entry counts.",
    parameters: {},
  },
  {
    name: "memory_clear_namespace",
    description: "Delete ALL entries within a specific namespace.",
    parameters: {
      namespace: {
        type: "string",
        description: "Namespace to clear",
        required: true,
      },
    },
  },
];

const SERVER_INFO: ServerInfo = {
  id: "memory",
  name: "Memory Server",
  version: "1.0.0",
  description:
    "Persistent key-value knowledge base. Lets the AI remember information across conversations.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class ----------------------------------------------

export interface MemoryServerOptions {
  /** Path to the JSON file where memory is persisted */
  storePath: string;
}

export class MemoryServer extends BaseMCPServer {
  private storePath!: string;
  private store: MemoryStore = { version: 1, entries: {} };
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(options: MemoryServerOptions) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("memory_set",              this.memorySet.bind(this));
    this.registerTool("memory_get",              this.memoryGet.bind(this));
    this.registerTool("memory_search",           this.memorySearch.bind(this));
    this.registerTool("memory_delete",           this.memoryDelete.bind(this));
    this.registerTool("memory_list_namespaces",  this.memoryListNamespaces.bind(this));
    this.registerTool("memory_clear_namespace",  this.memoryClearNamespace.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.storePath = path.resolve(
      this.getOption<string>("storePath", "./memory-store.json")
    );
    await this.loadStore();
    console.log(
      `[memory] Loaded ${Object.keys(this.store.entries).length} entries from ${this.storePath}`
    );
  }

  protected async onShutdown(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.persistStore();
  }

  // ---- Persistence --------------------------------------------

  private async loadStore(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      this.store = JSON.parse(raw) as MemoryStore;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // First run — create fresh store
        this.store = { version: 1, entries: {} };
        await this.persistStore();
      } else {
        throw err;
      }
    }
  }

  private async persistStore(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(this.store, null, 2), "utf8");
    this.dirty = false;
  }

  /** Debounced write — batches rapid successive writes */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(async () => {
      if (this.dirty) await this.persistStore();
    }, 1000);
  }

  // ---- ID generation ------------------------------------------

  private makeId(namespace: string, key: string): string {
    return `${namespace}::${key}`;
  }

  // ---- Tool handlers ------------------------------------------

  private async memorySet(args: Record<string, unknown>): Promise<ToolCallResult> {
    const key       = args.key as string;
    const value     = args.value;
    const namespace = (args.namespace as string) ?? "default";
    const tags      = (args.tags as string[]) ?? [];
    const id        = this.makeId(namespace, key);
    const now       = new Date().toISOString();

    const existing  = this.store.entries[id];
    this.store.entries[id] = {
      id,
      namespace,
      key,
      value,
      tags,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.schedulePersist();
    return this.ok({ id, namespace, key }, "Memory entry saved.");
  }

  private async memoryGet(args: Record<string, unknown>): Promise<ToolCallResult> {
    const key       = args.key as string;
    const namespace = (args.namespace as string) ?? "default";
    const id        = this.makeId(namespace, key);
    const entry     = this.store.entries[id];

    if (!entry) {
      return this.fail(`No memory entry found for key "${key}" in namespace "${namespace}".`);
    }

    return this.ok(entry);
  }

  private async memorySearch(args: Record<string, unknown>): Promise<ToolCallResult> {
    const query     = (args.query as string | undefined)?.toLowerCase();
    const namespace = args.namespace as string | undefined;
    const tags      = (args.tags as string[]) ?? [];
    const limit     = Math.min((args.limit as number) ?? 20, 200);

    let results = Object.values(this.store.entries);

    if (namespace) {
      results = results.filter((e) => e.namespace === namespace);
    }

    if (tags.length > 0) {
      results = results.filter((e) => tags.every((t) => e.tags.includes(t)));
    }

    if (query) {
      results = results.filter(
        (e) =>
          e.key.toLowerCase().includes(query) ||
          JSON.stringify(e.value).toLowerCase().includes(query)
      );
    }

    results = results.slice(0, limit);
    return this.ok(results, undefined, { count: results.length });
  }

  private async memoryDelete(args: Record<string, unknown>): Promise<ToolCallResult> {
    const key       = args.key as string;
    const namespace = (args.namespace as string) ?? "default";
    const id        = this.makeId(namespace, key);

    if (!this.store.entries[id]) {
      return this.fail(`No entry found for key "${key}" in namespace "${namespace}".`);
    }

    delete this.store.entries[id];
    this.schedulePersist();
    return this.ok({ deleted: key, namespace }, "Entry deleted.");
  }

  private async memoryListNamespaces(_args: Record<string, unknown>): Promise<ToolCallResult> {
    const counts: Record<string, number> = {};

    for (const entry of Object.values(this.store.entries)) {
      counts[entry.namespace] = (counts[entry.namespace] ?? 0) + 1;
    }

    const namespaces = Object.entries(counts).map(([name, count]) => ({ name, count }));
    return this.ok(namespaces);
  }

  private async memoryClearNamespace(args: Record<string, unknown>): Promise<ToolCallResult> {
    const namespace = args.namespace as string;
    let deleted     = 0;

    for (const id of Object.keys(this.store.entries)) {
      if (this.store.entries[id].namespace === namespace) {
        delete this.store.entries[id];
        deleted++;
      }
    }

    this.schedulePersist();
    return this.ok({ namespace, deleted }, `Cleared ${deleted} entries from namespace "${namespace}".`);
  }
}
