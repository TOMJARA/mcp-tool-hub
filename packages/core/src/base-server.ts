// ============================================================
// @mcp-tool-hub/core — base-server.ts
// Abstract base class every tool server must extend
// ============================================================

import {
  IMCPServer,
  ServerInfo,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
} from "./types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolCallResult>;

/**
 * BaseMCPServer
 *
 * Extend this class to create a new tool server in 4 steps:
 *  1. Call super(info) with your ServerInfo
 *  2. Register handlers in the constructor via this.registerTool(name, handler)
 *  3. Override onInitialize() for startup logic (optional)
 *  4. Override onShutdown() for cleanup logic (optional)
 *
 * @example
 * ```ts
 * export class MyServer extends BaseMCPServer {
 *   constructor(options: MyOptions) {
 *     super({ id: "my_server", name: "My Server", version: "1.0.0",
 *             description: "...", tools: [MY_TOOL_DEF] });
 *     this.registerTool("my_tool", this.handleMyTool.bind(this));
 *   }
 *   private async handleMyTool(args) { ... }
 * }
 * ```
 */
export abstract class BaseMCPServer implements IMCPServer {
  readonly info: ServerInfo;
  protected options: Record<string, unknown>;
  private readonly handlers = new Map<string, ToolHandler>();

  constructor(info: ServerInfo, options: Record<string, unknown> = {}) {
    this.info = info;
    this.options = options;
  }

  // ---- Lifecycle -------------------------------------------------

  async initialize(): Promise<void> {
    await this.onInitialize();
    console.log(`[${this.info.id}] Server initialized (v${this.info.version})`);
  }

  async shutdown(): Promise<void> {
    await this.onShutdown();
    console.log(`[${this.info.id}] Server shut down`);
  }

  /** Override for custom startup logic */
  protected async onInitialize(): Promise<void> {}
  /** Override for custom shutdown/cleanup logic */
  protected async onShutdown(): Promise<void> {}

  // ---- Tool Registration -----------------------------------------

  /**
   * Register a handler for a named tool.
   * The tool must be listed in this.info.tools for it to be visible.
   */
  protected registerTool(name: string, handler: ToolHandler): void {
    this.validateToolName(name);
    this.handlers.set(name, handler);
  }

  // ---- Dispatch --------------------------------------------------

  async handleToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
    const { toolName, arguments: args, callId } = request;
    const handler = this.handlers.get(toolName);

    if (!handler) {
      return {
        callId,
        status: "error",
        data: null,
        message: `Tool "${toolName}" not found in server "${this.info.id}"`,
      };
    }

    try {
      const result = await handler(args);
      return { callId, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.info.id}] Tool "${toolName}" threw: ${message}`);
      return {
        callId,
        status: "error",
        data: null,
        message,
      };
    }
  }

  // ---- Helpers ---------------------------------------------------

  /** Typed accessor for options */
  protected getOption<T>(key: string, defaultValue: T): T {
    return key in this.options ? (this.options[key] as T) : defaultValue;
  }

  /** Build a success result */
  protected ok(data: unknown, message?: string, meta?: Record<string, unknown>): ToolCallResult {
    return { status: "success", data, message, meta };
  }

  /** Build an error result */
  protected fail(message: string, meta?: Record<string, unknown>): ToolCallResult {
    return { status: "error", data: null, message, meta };
  }

  // ---- Private ---------------------------------------------------

  private validateToolName(name: string): void {
    const defined = this.info.tools.map((t: ToolDefinition) => t.name);
    if (!defined.includes(name)) {
      throw new Error(
        `[${this.info.id}] Registering handler for "${name}" but it is not in info.tools. ` +
        `Defined tools: [${defined.join(", ")}]`
      );
    }
  }
}
