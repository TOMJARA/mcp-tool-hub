// @mcp-tool-hub/host — public API
export { MCPHub } from "./hub.js";
export type { HubOptions } from "./hub.js";
export { ToolRegistry } from "./registry.js";

// Re-export core types for consumers
export type {
  IMCPServer,
  ToolCallRequest,
  ToolCallResult,
  RegistrySnapshot,
  ToolDefinition,
  ServerInfo,
} from "@mcp-tool-hub/core";
