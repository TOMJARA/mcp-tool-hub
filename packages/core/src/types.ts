// ============================================================
// @mcp-tool-hub/core — types.ts
// All shared types for the Model Context Protocol hub
// ============================================================

// --------------- Tool Definition ---------------

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required?: boolean;
  items?: ToolParameter;          // for array types
  properties?: Record<string, ToolParameter>;  // for object types
  enum?: string[];                // allowed values
  default?: unknown;
}

export interface ToolDefinition {
  /** Unique name (snake_case). e.g. "read_file" */
  name: string;
  /** Human-readable description the LLM will use to decide when to call this tool */
  description: string;
  /** JSON-Schema-style parameter definitions */
  parameters: Record<string, ToolParameter>;
}

// --------------- Tool Call / Result ---------------

export interface ToolCallRequest {
  /** Matches ToolDefinition.name */
  toolName: string;
  /** Key-value arguments matching the tool's parameter definitions */
  arguments: Record<string, unknown>;
  /** Optional trace/correlation ID */
  callId?: string;
}

export type ToolResultStatus = "success" | "error" | "partial";

export interface ToolCallResult {
  callId?: string;
  status: ToolResultStatus;
  /** The main output — string, object, or array */
  data: unknown;
  /** Human-readable message (always present on error) */
  message?: string;
  /** Metadata the host or LLM may use */
  meta?: Record<string, unknown>;
}

// --------------- Server Info ---------------

export interface ServerInfo {
  /** Unique server identifier. e.g. "filesystem", "git" */
  id: string;
  /** Display name */
  name: string;
  version: string;
  description: string;
  /** All tools this server exposes */
  tools: ToolDefinition[];
}

// --------------- Host ↔ Server Contract ---------------

export interface IMCPServer {
  readonly info: ServerInfo;
  /** Called once during startup — open DB connections, validate config, etc. */
  initialize(): Promise<void>;
  /** Clean shutdown */
  shutdown(): Promise<void>;
  /** Dispatch a tool call and return the result */
  handleToolCall(request: ToolCallRequest): Promise<ToolCallResult>;
}

// --------------- Host Registry ---------------

export interface ToolRoute {
  serverId: string;
  toolName: string;
}

export interface RegistrySnapshot {
  servers: ServerInfo[];
  /** Flat tool → server routing table */
  routes: Record<string, ToolRoute>;
}

// --------------- Config ---------------

export interface MCPHubConfig {
  /** Which server packages to load (resolved at runtime) */
  servers: ServerConfig[];
  host: {
    logLevel: "debug" | "info" | "warn" | "error";
  };
}

export interface ServerConfig {
  /** Must match ServerInfo.id */
  id: string;
  enabled: boolean;
  /** Server-specific settings passed to initialize() */
  options: Record<string, unknown>;
}
