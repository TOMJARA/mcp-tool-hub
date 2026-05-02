// ============================================================
// host/src/hub.ts
// MCPHub — the main orchestrator.
// Wires servers together, exposes a clean dispatch API,
// and generates the tool manifest for LLM system prompts.
// ============================================================

import {
  IMCPServer,
  ToolCallRequest,
  ToolCallResult,
  RegistrySnapshot,
  ToolDefinition,
} from "@mcp-tool-hub/core";
import { Logger } from "@mcp-tool-hub/core";
import { ToolRegistry } from "./registry.js";

export interface HubOptions {
  logLevel?: "debug" | "info" | "warn" | "error";
}

export class MCPHub {
  private registry = new ToolRegistry();
  private log: Logger;
  private started = false;

  constructor(options: HubOptions = {}) {
    this.log = new Logger("hub", options.logLevel ?? "info");
  }

  // ---- Server registration (call before start()) ---------------

  use(server: IMCPServer): this {
    if (this.started) {
      throw new Error("Cannot register servers after hub.start() has been called.");
    }
    this.registry.register(server);
    return this;
  }

  // ---- Lifecycle -----------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.log.info("Starting MCP Tool Hub...");
    await this.registry.initializeAll();
    this.started = true;
    this.log.info(
      `Hub started. ${this.registry.getServerCount()} servers, ` +
      `${this.registry.getToolCount()} tools available.`
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.log.info("Stopping MCP Tool Hub...");
    await this.registry.shutdownAll();
    this.started = false;
    this.log.info("Hub stopped.");
  }

  // ---- Tool dispatch -------------------------------------------

  /**
   * Dispatch a tool call request to the appropriate server.
   * This is the primary API the LLM integration layer calls.
   */
  async call(request: ToolCallRequest): Promise<ToolCallResult> {
    if (!this.started) {
      return {
        status: "error",
        data: null,
        message: "Hub is not started. Call hub.start() first.",
      };
    }

    this.log.debug(`Tool call: ${request.toolName}`, request.arguments);
    const result = await this.registry.dispatch(request);

    if (result.status === "error") {
      this.log.warn(`Tool "${request.toolName}" failed: ${result.message}`);
    } else {
      this.log.debug(`Tool "${request.toolName}" succeeded`, { status: result.status });
    }

    return result;
  }

  // ---- Convenience: call by name + args directly ---------------

  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    return this.call({ toolName, arguments: args });
  }

  // ---- Introspection -------------------------------------------

  getSnapshot(): RegistrySnapshot {
    return this.registry.snapshot();
  }

  /**
   * Generate a Markdown tool manifest for inclusion in LLM system prompts.
   * This tells the LLM what tools are available and how to use them.
   */
  generateToolManifest(): string {
    const { servers } = this.registry.snapshot();
    const lines: string[] = [
      "# Available Tools",
      "",
      "You have access to the following tools. Use them by specifying the tool name and arguments.",
      "",
    ];

    for (const server of servers) {
      lines.push(`## ${server.name}`);
      lines.push(`*${server.description}*`);
      lines.push("");

      for (const tool of server.tools) {
        lines.push(`### \`${tool.name}\``);
        lines.push(tool.description);
        lines.push("");
        lines.push("**Parameters:**");
        lines.push("");

        for (const [paramName, param] of Object.entries(tool.parameters)) {
          const req = param.required ? "*(required)*" : "*(optional)*";
          lines.push(`- \`${paramName}\` ${req} — ${param.description}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * Return the full tool definitions array (for OpenAI/Anthropic function-calling APIs)
   */
  getToolDefinitions(): ToolDefinition[] {
    const { servers } = this.registry.snapshot();
    return servers.flatMap((s) => s.tools);
  }
}
