// ============================================================
// TEMPLATE: How to add a new MCP Tool Server
// Copy this file to packages/server-YOUR_NAME/src/your-server.ts
// ============================================================
//
// STEP 1: Create the package directory
//   mkdir -p packages/server-slack/src
//
// STEP 2: Add package.json (copy from another server, change "name")
//
// STEP 3: Add tsconfig.json (identical to other servers)
//
// STEP 4: Implement your server (this file):
//

import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

// 1. Define your tools
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "my_tool",
    description: "What this tool does — the LLM reads this to decide when to use it.",
    parameters: {
      message: {
        type: "string",
        description: "The message to send",
        required: true,
      },
      channel: {
        type: "string",
        description: "Target channel. Defaults to #general.",
        default: "#general",
      },
    },
  },
];

// 2. Define server metadata
const SERVER_INFO: ServerInfo = {
  id: "my_server",         // unique, snake_case
  name: "My Server",
  version: "1.0.0",
  description: "One-line description of what this server provides.",
  tools: TOOL_DEFINITIONS,
};

// 3. Define your options interface
export interface MyServerOptions {
  apiKey: string;
  someOtherOption?: string;
}

// 4. Extend BaseMCPServer
export class MyServer extends BaseMCPServer {
  private apiKey!: string;

  constructor(options: MyServerOptions) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    // 5. Register handlers for each tool
    this.registerTool("my_tool", this.handleMyTool.bind(this));
  }

  // 6. Implement startup logic
  protected async onInitialize(): Promise<void> {
    this.apiKey = this.getOption<string>("apiKey", "");
    if (!this.apiKey) throw new Error("MyServer requires an apiKey.");
    // Connect to external service, open DB connection, etc.
  }

  // 7. Implement cleanup
  protected async onShutdown(): Promise<void> {
    // Close connections, flush caches, etc.
  }

  // 8. Implement each tool handler
  private async handleMyTool(args: Record<string, unknown>): Promise<ToolCallResult> {
    const message = args.message as string;
    const channel = (args.channel as string) ?? "#general";

    try {
      // Do the actual work here...
      // const result = await someExternalAPI(this.apiKey, message, channel);

      return this.ok(
        { sent: true, channel, messageLength: message.length },
        "Message sent successfully."
      );
    } catch (err) {
      return this.fail(`Failed to send message: ${(err as Error).message}`);
    }
  }
}

// 9. Export
// In your index.ts:
// export { MyServer } from "./my-server.js";
// export type { MyServerOptions } from "./my-server.js";

// 10. Register in host/src/cli.ts:
// import { MyServer } from "@mcp-tool-hub/server-my";
// hub.use(new MyServer({ apiKey: process.env.MY_API_KEY! }));

//
// That's it! Your server is now available to the LLM.
// ============================================================
//
// IDEAS FOR FUTURE SERVERS:
//
//  server-slack         → Send messages, read channels, search
//  server-google-drive  → List, read, create Google Docs/Sheets
//  server-database      → Query PostgreSQL / MySQL / SQLite
//  server-docker        → List containers, exec commands, view logs
//  server-ansible       → Trigger playbooks, check host status
//  server-ssh           → Execute commands on remote hosts
//  server-prometheus    → Query metrics, check alerts
//  server-jira          → Create/update tickets, search issues
//  server-email         → Send emails via SMTP
//  server-s3            → Read/write files in S3-compatible storage
//
