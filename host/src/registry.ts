// ============================================================
// host/src/registry.ts
// The routing table: maps tool names → server instances
// ============================================================

import {
  IMCPServer,
  RegistrySnapshot,
  ServerInfo,
  ToolCallRequest,
  ToolCallResult,
  ToolRoute,
} from "@mcp-tool-hub/core";
import { Logger } from "@mcp-tool-hub/core";

export class ToolRegistry {
  private servers = new Map<string, IMCPServer>();
  private routes  = new Map<string, string>(); // toolName → serverId
  private log     = new Logger("registry");

  // ---- Registration --------------------------------------------

  register(server: IMCPServer): void {
    if (this.servers.has(server.info.id)) {
      throw new Error(`Server "${server.info.id}" is already registered.`);
    }

    // Register the server
    this.servers.set(server.info.id, server);

    // Register all its tools in the routing table
    for (const tool of server.info.tools) {
      if (this.routes.has(tool.name)) {
        const existing = this.routes.get(tool.name)!;
        this.log.warn(
          `Tool "${tool.name}" is already registered by server "${existing}". ` +
          `Server "${server.info.id}" will shadow it.`
        );
      }
      this.routes.set(tool.name, server.info.id);
      this.log.debug(`Registered tool: ${tool.name} → ${server.info.id}`);
    }

    this.log.info(`Registered server: ${server.info.name} (${server.info.tools.length} tools)`);
  }

  // ---- Dispatch ------------------------------------------------

  async dispatch(request: ToolCallRequest): Promise<ToolCallResult> {
    const serverId = this.routes.get(request.toolName);

    if (!serverId) {
      return {
        callId: request.callId,
        status: "error",
        data: null,
        message: `Unknown tool: "${request.toolName}". Available tools: [${[...this.routes.keys()].join(", ")}]`,
      };
    }

    const server = this.servers.get(serverId)!;
    this.log.debug(`Dispatching ${request.toolName} → ${serverId}`);

    return server.handleToolCall(request);
  }

  // ---- Introspection -------------------------------------------

  snapshot(): RegistrySnapshot {
    const servers: ServerInfo[] = [];
    const routes: Record<string, ToolRoute> = {};

    for (const [, server] of this.servers) {
      servers.push(server.info);
    }

    for (const [toolName, serverId] of this.routes) {
      routes[toolName] = { serverId, toolName };
    }

    return { servers, routes };
  }

  getToolNames(): string[] {
    return [...this.routes.keys()];
  }

  getServerCount(): number {
    return this.servers.size;
  }

  getToolCount(): number {
    return this.routes.size;
  }

  // ---- Lifecycle -----------------------------------------------

  async initializeAll(): Promise<void> {
    for (const [id, server] of this.servers) {
      this.log.info(`Initializing server: ${id}`);
      await server.initialize();
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [id, server] of this.servers) {
      this.log.info(`Shutting down server: ${id}`);
      await server.shutdown();
    }
  }
}
