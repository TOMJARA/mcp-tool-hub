// ============================================================
// @mcp-tool-hub/server-fetch — fetch-server.ts
//
// Lets the LLM fetch content from the web.
// Supports: plain fetch, HTML-to-text stripping, JSON APIs,
// redirect following, custom headers, and domain allowlists.
// Uses Node 18+ native fetch — no extra dependencies.
// ============================================================

import {
  BaseMCPServer,
  ServerInfo,
  ToolCallResult,
  ToolDefinition,
} from "@mcp-tool-hub/core";

// ---- Tool definitions ------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "fetch_url",
    description:
      "Fetch the content of a URL. Returns text/HTML by default. " +
      "Set extractText=true to strip HTML tags and return clean text.",
    parameters: {
      url: {
        type: "string",
        description: "The URL to fetch",
        required: true,
      },
      extractText: {
        type: "boolean",
        description: "Strip HTML tags and return clean readable text. Defaults to false.",
        default: false,
      },
      maxChars: {
        type: "number",
        description: "Truncate response to this many characters (default: 50000)",
        default: 50000,
      },
      headers: {
        type: "object",
        description: "Optional HTTP headers to include in the request",
      },
    },
  },
  {
    name: "fetch_json",
    description: "Fetch a URL expecting a JSON response. Returns the parsed object.",
    parameters: {
      url: {
        type: "string",
        description: "The JSON API URL to fetch",
        required: true,
      },
      headers: {
        type: "object",
        description: "Optional HTTP headers",
      },
    },
  },
  {
    name: "check_url",
    description: "Check if a URL is reachable. Returns status code and response time.",
    parameters: {
      url: {
        type: "string",
        description: "The URL to check",
        required: true,
      },
    },
  },
];

const SERVER_INFO: ServerInfo = {
  id: "fetch",
  name: "Fetch Server",
  version: "1.0.0",
  description: "Fetch web content: HTML pages, REST APIs, or plain text. Supports domain allowlisting.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class ----------------------------------------------

export interface FetchServerOptions {
  /**
   * If set, only these domains are allowed.
   * e.g. ["github.com", "api.example.com"]
   * Leave empty/undefined to allow all domains.
   */
  allowedDomains?: string[];
  /** Request timeout in ms (default: 15000) */
  timeoutMs?: number;
  /** User-Agent header to send (default: mcp-tool-hub/1.0) */
  userAgent?: string;
}

export class FetchServer extends BaseMCPServer {
  private allowedDomains: string[] = [];
  private timeoutMs!: number;
  private userAgent!: string;

  constructor(options: FetchServerOptions = {}) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("fetch_url",  this.fetchUrl.bind(this));
    this.registerTool("fetch_json", this.fetchJson.bind(this));
    this.registerTool("check_url",  this.checkUrl.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.allowedDomains = this.getOption<string[]>("allowedDomains", []);
    this.timeoutMs      = this.getOption<number>("timeoutMs", 15000);
    this.userAgent      = this.getOption<string>("userAgent", "mcp-tool-hub/1.0");

    if (this.allowedDomains.length > 0) {
      console.log(`[fetch] Domain allowlist: ${this.allowedDomains.join(", ")}`);
    } else {
      console.log(`[fetch] No domain restrictions (all URLs allowed)`);
    }
  }

  // ---- Security ------------------------------------------------

  private checkDomain(url: string): void {
    if (this.allowedDomains.length === 0) return;

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error(`Invalid URL: "${url}"`);
    }

    const allowed = this.allowedDomains.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`)
    );

    if (!allowed) {
      throw new Error(
        `Domain "${hostname}" is not in the allowed list: [${this.allowedDomains.join(", ")}]`
      );
    }
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "User-Agent": this.userAgent,
      Accept: "text/html,application/json,*/*",
      ...extra,
    };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
      ),
    ]);
  }

  // ---- HTML → text (naive but effective) -----------------------

  private extractText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // ---- Tool handlers -------------------------------------------

  private async fetchUrl(args: Record<string, unknown>): Promise<ToolCallResult> {
    const url         = args.url as string;
    const extractText = (args.extractText as boolean) ?? false;
    const maxChars    = (args.maxChars as number) ?? 50_000;
    const headers     = (args.headers as Record<string, string>) ?? {};

    this.checkDomain(url);

    const response = await this.withTimeout(
      fetch(url, { headers: this.buildHeaders(headers) }),
      this.timeoutMs
    );

    const contentType = response.headers.get("content-type") ?? "";
    let body = await response.text();

    if (extractText && contentType.includes("html")) {
      body = this.extractText(body);
    }

    if (body.length > maxChars) {
      body = body.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars]`;
    }

    return this.ok(body, undefined, {
      url,
      statusCode: response.status,
      contentType,
      truncated: body.length >= maxChars,
    });
  }

  private async fetchJson(args: Record<string, unknown>): Promise<ToolCallResult> {
    const url     = args.url as string;
    const headers = (args.headers as Record<string, string>) ?? {};

    this.checkDomain(url);

    const response = await this.withTimeout(
      fetch(url, {
        headers: this.buildHeaders({ ...headers, Accept: "application/json" }),
      }),
      this.timeoutMs
    );

    if (!response.ok) {
      return this.fail(`HTTP ${response.status}: ${response.statusText}`, { url });
    }

    const json = await response.json();
    return this.ok(json, undefined, { url, statusCode: response.status });
  }

  private async checkUrl(args: Record<string, unknown>): Promise<ToolCallResult> {
    const url = args.url as string;
    this.checkDomain(url);

    const start = Date.now();
    const response = await this.withTimeout(
      fetch(url, { method: "HEAD", headers: this.buildHeaders() }),
      this.timeoutMs
    );
    const responseTimeMs = Date.now() - start;

    return this.ok({
      url,
      reachable: response.ok,
      statusCode: response.status,
      statusText: response.statusText,
      responseTimeMs,
    });
  }
}
