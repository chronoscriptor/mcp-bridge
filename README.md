# MCP Bridge — Agent-Stack Action Gateway

> **Status:** v0.1.0 · 2026-09-04  
> **Purpose:** Thin MCP server exposing all agent-stack services as discoverable tools.  
> **Protocol:** JSON-RPC 2.0 over stdio (MCP standard)  
> **Architecture:** pi (MCP client) ↔ this bridge (MCP server) ↔ service APIs + n8n webhooks

## How to run

```bash
# Start (foreground)
cd ~/projects/agent-stack/mcp-bridge
node mcp-bridge.js

# Systemd (auto-start with stack)
systemctl --user start agent-mcp-bridge.service
```

## How pi connects

pi connects via stdio subprocess. In pi config:

```json
{
  "mcpServers": {
    "agent-stack": {
      "command": "node",
      "args": ["/home/steven/projects/agent-stack/mcp-bridge/mcp-bridge.js"]
    }
  }
}
```

Or run directly: `just mcp-bridge`

## Tools available

| Tool | Capability | Auth needed | Tier |
|---|---|---|---|
| `service.status` | infrastructure.health | No | 0 |
| `tasks.info` | tasks.info | No | 0 |
| `tasks.projects.list` | tasks.projects.list | Vikunja token | 1 |
| `chat.system.status` | chat.system | No | 0 |
| `chat.channels.list` | chat.channels.list | Mattermost token | 1 |
| `web.posts.list` | web.posts.list | No | 0 |
| `web.pages.list` | web.pages.list | No | 0 |
| `knowledge.pages.search` | knowledge.search | Wiki.js API key | 0 |
| `code.repos.list` | code.repos.list | Gitea token | 1 |
| `automation.workflows.list` | automation.workflows | n8n API key | 0 |
| `probe.http` | infrastructure.diagnose | No | 0 |

## Config

Secrets stored at `profiles/default/secrets/mcp-bridge.json` (chmod 600):

```json
{
  "mattermost": { "token": "..." },
  "vikunja": { "token": "..." },
  "wiki": { "apiKey": "..." },
  "gitea": { "token": "..." },
  "n8n": { "apiKey": "..." }
}
```

## Adding tools

Edit `mcp-bridge.js` — add entry to `TOOLS` object with handler function. Each tool needs:
- `name` (key in TOOLS)
- `description` — shown to agent
- `inputSchema` — JSON Schema for arguments
- `handler` — async function returning result object

## Logs

`logs/mcp-bridge.log` — all tool calls and errors

## Architecture position

```
                          pi (agent session)
                               │
                     ┌─────────▼─────────┐
                     │  MCP Bridge        │
                     │  (this server)     │
                     └─────────┬─────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
     Docker services      n8n webhooks        Official MCPs
     (direct API)         (credentials)       (future: connect)
```

Built alongside old per-service AGENTS.md artifacts (preserved as rollback).
