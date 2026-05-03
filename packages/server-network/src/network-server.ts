// ============================================================
// @mcp-tool-hub/server-network — network-server.ts
//
// Network diagnostics and scanning tools for IT engineers.
// Uses system tools: ping, traceroute, nmap, dig, curl.
// All tools work on Android/Termux and Linux systems.
// ============================================================

import { exec } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns/promises";
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
    name: "network_ping",
    description: "Ping a host and return response time and packet loss.",
    parameters: {
      host: {
        type: "string",
        description: "Hostname or IP address to ping",
        required: true,
      },
      count: {
        type: "number",
        description: "Number of ping packets to send. Defaults to 4.",
        default: 4,
      },
    },
  },
  {
    name: "network_traceroute",
    description: "Trace the network route to a host showing each hop.",
    parameters: {
      host: {
        type: "string",
        description: "Hostname or IP address",
        required: true,
      },
      maxHops: {
        type: "number",
        description: "Maximum number of hops. Defaults to 20.",
        default: 20,
      },
    },
  },
  {
    name: "network_port_scan",
    description: "Scan ports on a host to check which ones are open.",
    parameters: {
      host: {
        type: "string",
        description: "Hostname or IP address to scan",
        required: true,
      },
      ports: {
        type: "string",
        description: "Port range e.g. '80', '1-1000', '22,80,443,3389'",
        required: true,
      },
      timeout: {
        type: "number",
        description: "Scan timeout in seconds. Defaults to 30.",
        default: 30,
      },
    },
  },
  {
    name: "network_dns_lookup",
    description: "Perform DNS lookup for a domain — get IP addresses and DNS records.",
    parameters: {
      domain: {
        type: "string",
        description: "Domain name to look up",
        required: true,
      },
      recordType: {
        type: "string",
        description: "DNS record type: A, AAAA, MX, TXT, NS, CNAME. Defaults to A.",
        enum: ["A", "AAAA", "MX", "TXT", "NS", "CNAME"],
        default: "A",
      },
    },
  },
  {
    name: "network_check_http",
    description: "Check if a website or HTTP service is up. Returns status code and response time.",
    parameters: {
      url: {
        type: "string",
        description: "URL to check e.g. 'https://google.com'",
        required: true,
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds. Defaults to 10.",
        default: 10,
      },
    },
  },
  {
    name: "network_local_info",
    description: "Get local network information: IP addresses, interfaces, and routing.",
    parameters: {},
  },
  {
    name: "network_whois",
    description: "Get WHOIS information for a domain or IP address.",
    parameters: {
      target: {
        type: "string",
        description: "Domain name or IP address to look up",
        required: true,
      },
    },
  },
];

const SERVER_INFO: ServerInfo = {
  id: "network",
  name: "Network Server",
  version: "1.0.0",
  description:
    "Network diagnostics for IT engineers: ping, traceroute, port scan, DNS, HTTP checks, and WHOIS.",
  tools: TOOL_DEFINITIONS,
};

// ---- Server class ---------------------------------------------

export interface NetworkServerOptions {
  /** Max output characters (default: 50000) */
  maxOutputChars?: number;
  /** Default ping count (default: 4) */
  defaultPingCount?: number;
}

export class NetworkServer extends BaseMCPServer {
  private maxOutputChars!: number;

  constructor(options: NetworkServerOptions = {}) {
    super(SERVER_INFO, options as unknown as Record<string, unknown>);

    this.registerTool("network_ping",       this.ping.bind(this));
    this.registerTool("network_traceroute", this.traceroute.bind(this));
    this.registerTool("network_port_scan",  this.portScan.bind(this));
    this.registerTool("network_dns_lookup", this.dnsLookup.bind(this));
    this.registerTool("network_check_http", this.checkHttp.bind(this));
    this.registerTool("network_local_info", this.localInfo.bind(this));
    this.registerTool("network_whois",      this.whois.bind(this));
  }

  protected async onInitialize(): Promise<void> {
    this.maxOutputChars = this.getOption<number>("maxOutputChars", 50000);
    console.log(`[network] Network server ready`);
  }

  // ---- Security helper -----------------------------------------

  private sanitizeHost(host: string): string {
    if (!/^[a-zA-Z0-9.\-_:]+$/.test(host)) {
      throw new Error(`Invalid host: "${host}"`);
    }
    return host;
  }

  private truncate(text: string): string {
    if (text.length > this.maxOutputChars) {
      return text.slice(0, this.maxOutputChars) +
        `\n[... truncated at ${this.maxOutputChars} chars]`;
    }
    return text;
  }

  private async run(cmd: string, timeoutMs = 30000): Promise<string> {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    return (stdout + stderr).trim();
  }

  // ---- Tool handlers -------------------------------------------

  private async ping(args: Record<string, unknown>): Promise<ToolCallResult> {
    const host  = this.sanitizeHost(args.host as string);
    const count = Math.min((args.count as number) ?? 4, 20);

    const raw = await this.run(`ping -c ${count} ${host}`);

    // Parse key stats from ping output
    const lines     = raw.split("\n");
    const statsLine = lines.find((l) => l.includes("packets transmitted"));
    const rttLine   = lines.find((l) => l.includes("rtt") || l.includes("round-trip"));

    return this.ok({
      host,
      raw: this.truncate(raw),
      stats: statsLine ?? "",
      rtt:   rttLine ?? "",
    });
  }

  private async traceroute(args: Record<string, unknown>): Promise<ToolCallResult> {
    const host    = this.sanitizeHost(args.host as string);
    const maxHops = Math.min((args.maxHops as number) ?? 20, 30);

    const raw = await this.run(
      `traceroute -m ${maxHops} ${host}`,
      60000
    );

    return this.ok(this.truncate(raw), undefined, { host, maxHops });
  }

  private async portScan(args: Record<string, unknown>): Promise<ToolCallResult> {
    const host    = this.sanitizeHost(args.host as string);
    const ports   = (args.ports as string).replace(/[^0-9,\-]/g, "");
    const timeout = Math.min((args.timeout as number) ?? 30, 120);

    const raw = await this.run(
      `nmap -p ${ports} --open -T4 ${host}`,
      timeout * 1000
    );

    // Parse open ports from nmap output
    const openPorts = raw
      .split("\n")
      .filter((l) => l.includes("/tcp") || l.includes("/udp"))
      .filter((l) => l.includes("open"))
      .map((l) => l.trim());

    return this.ok({
      host,
      ports,
      openPorts,
      raw: this.truncate(raw),
    }, undefined, { count: openPorts.length });
  }

  private async dnsLookup(args: Record<string, unknown>): Promise<ToolCallResult> {
    const domain     = args.domain as string;
    const recordType = (args.recordType as string) ?? "A";

    let records: unknown;

    switch (recordType) {
      case "A":
        records = await dns.resolve4(domain);
        break;
      case "AAAA":
        records = await dns.resolve6(domain);
        break;
      case "MX":
        records = await dns.resolveMx(domain);
        break;
      case "TXT":
        records = await dns.resolveTxt(domain);
        break;
      case "NS":
        records = await dns.resolveNs(domain);
        break;
      case "CNAME":
        records = await dns.resolveCname(domain);
        break;
      default:
        records = await dns.resolve4(domain);
    }

    return this.ok({ domain, recordType, records });
  }

  private async checkHttp(args: Record<string, unknown>): Promise<ToolCallResult> {
    const url     = args.url as string;
    const timeout = Math.min((args.timeout as number) ?? 10, 60);
    const start   = Date.now();

    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeout * 1000),
    });

    const responseTimeMs = Date.now() - start;

    return this.ok({
      url,
      statusCode:    response.status,
      statusText:    response.statusText,
      reachable:     response.ok,
      responseTimeMs,
      contentType:   response.headers.get("content-type") ?? "",
      server:        response.headers.get("server") ?? "",
    });
  }

  private async localInfo(_args: Record<string, unknown>): Promise<ToolCallResult> {
    const ifconfig = await this.run("ifconfig 2>/dev/null || ip addr 2>/dev/null").catch(() => "");
    const routing  = await this.run("ip route 2>/dev/null || route -n 2>/dev/null").catch(() => "");
    const dns      = await this.run("cat /etc/resolv.conf 2>/dev/null").catch(() => "");

    return this.ok({
      interfaces: this.truncate(ifconfig),
      routing:    this.truncate(routing),
      dns:        this.truncate(dns),
    });
  }

  private async whois(args: Record<string, unknown>): Promise<ToolCallResult> {
    const target = this.sanitizeHost(args.target as string);

    // Use whois command if available, otherwise fall back to IANA WHOIS API
    try {
      const raw = await this.run(`whois ${target}`, 15000);
      return this.ok(this.truncate(raw), undefined, { target });
    } catch {
      // Fallback: fetch from IANA WHOIS API
      const response = await fetch(`https://www.whois.com/whois/${target}`);
      const text     = await response.text();
      return this.ok(
        this.truncate(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
        undefined,
        { target, source: "whois.com" }
      );
    }
  }
}
