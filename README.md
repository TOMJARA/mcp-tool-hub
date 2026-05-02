# MCP Tool Hub

> A modular, extensible **Model Context Protocol** multi-server hub — built in TypeScript for IT automation teams.

Give your LLM access to real-world tools: files, Git, web content, and persistent memory. Deploy to any number of client machines simultaneously via **Ansible**.

---

## Architecture

```
mcp-tool-hub/
├── packages/
│   ├── core/              ← Shared types + BaseMCPServer abstract class
│   ├── server-filesystem/ ← Sandboxed local file access (read/write/list/delete)
│   ├── server-git/        ← Git log, diff, file contents, branches, status
│   ├── server-fetch/      ← Web fetching: HTML, JSON APIs, URL health checks
│   └── server-memory/     ← Persistent JSON knowledge base (survives restarts)
├── host/                  ← Orchestrator: registry + CLI + stdio JSON interface
├── ansible/               ← Playbook, inventory, systemd service templates
└── docs/                  ← How to add new servers (with template)
```

The architecture follows the **Model Context Protocol** pattern:
- Each server is **completely independent** — its own package, its own build
- The **registry** in the host maps `toolName → server` at runtime
- The **CLI** exposes a stdio JSON interface — any LLM integration sends `{"toolName":"...", "arguments":{...}}` on stdin, reads the result from stdout
- Adding a new server = create a package, extend `BaseMCPServer`, register in `cli.ts`

---

## Quick Start

### 1. Install & Build

```bash
git clone https://github.com/your-org/mcp-tool-hub.git
cd mcp-tool-hub
npm install
npm run build
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your paths and settings
```

### 3. Run

```bash
# Via npm
npm run start --workspace=host

# Or directly
node host/dist/cli.js
```

### 4. Call a tool

Send JSON to stdin, get JSON from stdout:

```bash
echo '{"toolName":"read_file","arguments":{"path":"hello.txt"}}' | node host/dist/cli.js
```

---

## Available Tools

### 📁 Filesystem Server

All operations sandboxed to `MCP_FS_ROOT`. Path traversal (`../`) is blocked.

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents (utf8 or base64) |
| `write_file` | Write or append to a file |
| `list_directory` | List directory contents (optionally recursive) |
| `delete_file` | Delete a file |
| `move_file` | Move or rename a file |
| `get_file_info` | Get size, dates, and type of a path |

### 🔀 Git Server

Read-only. No write operations.

| Tool | Description |
|------|-------------|
| `git_log` | Commit history for a repo or file |
| `git_show_file` | File contents at a specific commit/branch |
| `git_diff` | Diff between two refs |
| `git_status` | Working tree status |
| `git_branches` | List branches (local + optional remote) |
| `git_show_commit` | Full commit details and diff |

### 🌐 Fetch Server

Supports optional domain allowlist via `MCP_FETCH_ALLOWED_DOMAINS`.

| Tool | Description |
|------|-------------|
| `fetch_url` | Fetch HTML or text from a URL |
| `fetch_json` | Fetch and parse a JSON API response |
| `check_url` | Check if a URL is reachable (HEAD request) |

### 🧠 Memory Server

Persistent across restarts. Backed by a JSON file.

| Tool | Description |
|------|-------------|
| `memory_set` | Store a value with key, namespace, and tags |
| `memory_get` | Retrieve a value by key |
| `memory_search` | Full-text search across all entries |
| `memory_delete` | Delete an entry |
| `memory_list_namespaces` | List all namespaces with counts |
| `memory_clear_namespace` | Delete all entries in a namespace |

---

## Ansible Deployment

Deploy to all your client machines simultaneously:

```bash
cd ansible

# First time
ansible-playbook -i inventory.yml deploy-mcp-hub.yml

# Update only (rebuild + restart)
ansible-playbook -i inventory.yml deploy-mcp-hub.yml --tags update

# Deploy to specific group
ansible-playbook -i inventory.yml deploy-mcp-hub.yml --limit servers
```

The playbook:
1. Installs Node.js 20 (if not present)
2. Creates a dedicated `mcp-hub` system user
3. Copies and builds the project
4. Writes the `.env` config from your Ansible variables
5. Installs and starts a **systemd service** (auto-restart on failure)

Per-host variables in `inventory.yml` let you configure different allowed domains, log levels, and paths per machine group.

---

## Adding a New Server

See `docs/adding-a-new-server.template.ts` for the full template with comments.

In short:

```typescript
// 1. Create packages/server-myservice/src/my-server.ts
export class MyServer extends BaseMCPServer {
  constructor(options: MyOptions) {
    super(SERVER_INFO, options);
    this.registerTool("my_tool", this.handleMyTool.bind(this));
  }
  private async handleMyTool(args) {
    return this.ok({ result: "done" });
  }
}

// 2. Register in host/src/cli.ts
hub.use(new MyServer({ apiKey: process.env.MY_API_KEY! }));
```

Ideas: `server-slack`, `server-postgres`, `server-docker`, `server-ansible`, `server-ssh`, `server-jira`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_DATA_DIR` | `./mcp-data` | Root for all hub data |
| `MCP_FS_ROOT` | `./mcp-data/files` | Filesystem sandbox root |
| `MCP_GIT_WORKSPACE` | `./mcp-data/repos` | Git repos base path |
| `MCP_MEMORY_PATH` | `./mcp-data/memory.json` | Memory store file |
| `MCP_FETCH_ALLOWED_DOMAINS` | *(empty = all)* | Comma-separated domain allowlist |
| `MCP_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |

---

## Security Notes

- **Filesystem**: Strictly sandboxed. Path traversal attacks return an error, not data.
- **Git**: Read-only. No `commit`, `push`, or `clone` operations exposed.
- **Fetch**: Optional domain allowlist prevents SSRF to internal services.
- **Systemd service**: Runs as a non-root user with `PrivateTmp=true` and `NoNewPrivileges=true`.

---

## Requirements

- Node.js ≥ 18 (for native `fetch` API)
- Git (for `server-git`)
- Linux with systemd (for Ansible deployment)
