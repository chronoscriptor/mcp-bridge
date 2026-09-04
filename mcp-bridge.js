#!/usr/bin/env node

/**
 * agent-stack MCP Bridge
 * Zero-dependency MCP server exposing agent-stack services as MCP tools.
 * Communicates via JSON-RPC 2.0 over stdio.
 *
 * Protocol: https://spec.modelcontextprotocol.io/
 * Architecture: pi (MCP client) <-> this server (MCP server) <-> service APIs + n8n
 *
 * Run: node mcp-bridge.js
 * Connect from pi: pi connects via stdio subprocess
 */

import { createInterface } from 'node:readline';
import { request, createServer } from 'node:http';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Parse CLI flags ──────────────────────────────────────────────────

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '0');

// ─── Configuration ────────────────────────────────────────────────────

const CONFIG_PATH = resolve(__dirname, '..', 'profiles', 'default', 'secrets', 'mcp-bridge.json');
const LOG_PATH = resolve(__dirname, '..', 'logs', 'mcp-bridge.log');

const SERVICES = {
  mattermost: { host: 'localhost', port: 8065, protocol: 'http', base: '/api/v4' },
  vikunja:    { host: 'localhost', port: 3456, protocol: 'http', base: '/api/v1' },
  wordpress:  { host: 'localhost', port: 8088, protocol: 'http', base: '/wp-json/wp/v2' },
  wiki:       { host: 'localhost', port: 3002, protocol: 'http', base: '/api' },
  gitea:      { host: 'localhost', port: 3003, protocol: 'http', base: '/api/v1' },
  baserow:    { host: 'localhost', port: 3004, protocol: 'http', base: '/api' },
  crm:        { host: 'localhost', port: 3001, protocol: 'http', base: '/api/v1' },
  plane:      { host: 'localhost', port: 8081, protocol: 'http', base: '/api/v1' },
  whisper:    { host: 'localhost', port: 8866, protocol: 'http', base: '' },
  n8n:        { host: 'localhost', port: 5678, protocol: 'http', base: '/rest' },
};

// ─── Tool definitions ─────────────────────────────────────────────────

const TOOLS = {
  // — Service health (Tier 0, no auth needed) —
  'service.status': {
    description: 'Check if a service is alive and responding',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: Object.keys(SERVICES), description: 'Service name to check' }
      },
      required: ['service']
    },
    capability: 'infrastructure.health',
    handler: async ({ service }) => {
      const svc = SERVICES[service];
      if (!svc) return { error: `Unknown service: ${service}. Available: ${Object.keys(SERVICES).join(', ')}` };
      const { status, data } = await httpGet(svc, '/');
      return { service, status, reachable: status < 500, raw: typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200) };
    }
  },

  // — Tasks (Vikunja - Tier 0/1) —
  'tasks.info': {
    description: 'Get Vikunja task system info and version',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    capability: 'tasks.info',
    handler: async () => {
      const { status, data } = await httpGet(SERVICES.vikunja, '/info');
      if (status >= 400) return { error: 'Vikunja unreachable', status };
      return { service: 'vikunja', version: data.version, features: Object.keys(data).filter(k => k !== 'version') };
    }
  },

  'tasks.projects.list': {
    description: 'List all Vikunja projects',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    capability: 'tasks.projects.list',
    handler: async () => {
      const cfg = loadConfig();
      if (!cfg.vikunja?.token) return { error: 'Vikunja token not configured in mcp-bridge.json' };
      const { status, data } = await httpGet(SERVICES.vikunja, '/namespaces', {
        Authorization: `Bearer ${cfg.vikunja.token}`
      });
      if (status >= 400) return { error: `Vikunja error: ${status}` };
      return { projects: Array.isArray(data) ? data : data };
    }
  },

  // — Chat (Mattermost - Tier 0) —
  'chat.system.status': {
    description: 'Get Mattermost system status',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    capability: 'chat.system',
    handler: async () => {
      const { status, data } = await httpGet(SERVICES.mattermost, '/system/ping');
      if (status >= 400) return { error: `Mattermost unreachable: ${status}` };
      return { status: 'ok', service: 'mattermost', ping: data };
    }
  },

  'chat.channels.list': {
    description: 'List Mattermost channels (requires auth token)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    capability: 'chat.channels.list',
    handler: async () => {
      const cfg = loadConfig();
      if (!cfg.mattermost?.token) return { error: 'Mattermost token not configured in mcp-bridge.json' };
      const { status, data } = await httpGet(SERVICES.mattermost, '/channels', {
        Authorization: `Bearer ${cfg.mattermost.token}`
      });
      if (status >= 400) return { error: `Mattermost error: ${status}`, data };
      return { channels: Array.isArray(data) ? data.map(c => ({ id: c.id, name: c.name, display_name: c.display_name })) : [] };
    }
  },

  // — Web (WordPress - Tier 0/1) —
  'web.posts.list': {
    description: 'List WordPress posts',
    inputSchema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 10, description: 'Posts per page (max 100)' },
        status: { type: 'string', enum: ['publish', 'draft', 'pending', 'any'], default: 'publish' }
      },
      required: []
    },
    capability: 'web.posts.list',
    handler: async ({ per_page = 10, status = 'publish' }) => {
      const { status: httpStatus, data } = await httpGet(SERVICES.wordpress, `/posts?per_page=${Math.min(per_page, 100)}&status=${status}`);
      if (httpStatus >= 400) return { error: `WordPress error: ${httpStatus}`, data };
      return {
        count: Array.isArray(data) ? data.length : 0,
        posts: Array.isArray(data) ? data.map(p => ({
          id: p.id, title: p.title?.rendered, slug: p.slug,
          status: p.status, date: p.date, link: p.link
        })) : data
      };
    }
  },

  'web.pages.list': {
    description: 'List WordPress pages',
    inputSchema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 10 }
      },
      required: []
    },
    capability: 'web.pages.list',
    handler: async ({ per_page = 10 }) => {
      const { status, data } = await httpGet(SERVICES.wordpress, `/pages?per_page=${Math.min(per_page, 100)}`);
      if (status >= 400) return { error: `WordPress error: ${status}` };
      return {
        count: Array.isArray(data) ? data.length : 0,
        pages: Array.isArray(data) ? data.map(p => ({
          id: p.id, title: p.title?.rendered, slug: p.slug,
          status: p.status, date: p.date, link: p.link
        })) : data
      };
    }
  },

  // — Knowledge (Wiki.js - Tier 0) —
  'knowledge.pages.search': {
    description: 'Search Wiki.js pages',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', default: 10 }
      },
      required: ['query']
    },
    capability: 'knowledge.search',
    handler: async ({ query, limit = 10 }) => {
      const cfg = loadConfig();
      if (!cfg.wiki?.apiKey) return { error: 'Wiki.js API key not configured in mcp-bridge.json' };
      const { status, data } = await httpGet(SERVICES.wiki, '/pages/search', {
        Authorization: `Bearer ${cfg.wiki.apiKey}`
      }, { query, limit });
      if (status >= 400) return { error: `Wiki.js error: ${status}` };
      return { results: Array.isArray(data) ? data.slice(0, limit) : data };
    }
  },

  // — Code (Gitea - Tier 0/1) —
  'code.repos.list': {
    description: 'List Gitea repositories',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    capability: 'code.repos.list',
    handler: async () => {
      const cfg = loadConfig();
      if (!cfg.gitea?.token) return { error: 'Gitea token not configured in mcp-bridge.json' };
      const { status, data } = await httpGet(SERVICES.gitea, '/repos', {
        Authorization: `token ${cfg.gitea.token}`
      });
      if (status >= 400) return { error: `Gitea error: ${status}` };
      return { repos: Array.isArray(data) ? data.map(r => ({ id: r.id, name: r.name, owner: r.owner?.login, private: r.private, description: r.description })) : [] };
    }
  },

  // — Infrastructure (n8n - Tier 0) —
  'automation.workflows.list': {
    description: 'List n8n workflows (requires n8n API key)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    capability: 'automation.workflows',
    handler: async () => {
      const cfg = loadConfig();
      if (!cfg.n8n?.apiKey) return { error: 'n8n API key not configured in mcp-bridge.json' };
      const { status, data } = await httpGet(SERVICES.n8n, '/workflows', {
        'X-N8N-API-KEY': cfg.n8n.apiKey
      });
      if (status >= 400) return { error: `n8n error: ${status}` };
      return { workflows: Array.isArray(data) ? data.map(w => ({ id: w.id, name: w.name, active: w.active, created: w.createdAt })) : data };
    }
  },

  // — Generic HTTP probe tool for troubleshooting —
  'probe.http': {
    description: 'Send an HTTP request to any service (read-only, safe methods only)',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: Object.keys(SERVICES), description: 'Service to probe' },
        path: { type: 'string', description: 'API path (e.g. /api/v1/info)' }
      },
      required: ['service', 'path']
    },
    capability: 'infrastructure.diagnose',
    handler: async ({ service, path }) => {
      const svc = SERVICES[service];
      if (!svc) return { error: `Unknown service: ${service}` };
      const { status, data, headers } = await httpGet(svc, path);
      return {
        service, path, status, reachable: status > 0,
        headers: Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !['set-cookie', 'authorization'].includes(k.toLowerCase()))),
        data: typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500)
      };
    }
  }
};

// ─── HTTP helper (Node built-ins only, no dependencies) ───────────────

function httpGet(svc, path, headers = {}, query = {}) {
  return new Promise((resolve) => {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const fullPath = svc.base + path + (qs ? (path.includes('?') ? '&' : '?') + qs : '');
    const options = {
      hostname: svc.host, port: svc.port, path: fullPath, method: 'GET',
      headers: { 'Accept': 'application/json', ...headers },
      timeout: 10000
    };
    const req = request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { data = body; }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', (err) => resolve({ status: 0, data: err.message, headers: {} }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: 'timeout', headers: {} }); });
    req.end();
  });
}

// ─── Config ──────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch { return {}; }
}

function saveConfig(cfg) {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// ─── Logging ─────────────────────────────────────────────────────────

function log(level, msg, data = '') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const entry = `${ts} [${level}] ${msg}${data ? ' ' + JSON.stringify(data).slice(0, 500) : ''}`;
  try {
    const dir = dirname(LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(LOG_PATH, entry + '\n', { flag: 'a' });
  } catch { /* best effort */ }
  if (level !== 'debug') console.error(entry);
}

// ─── JSON-RPC 2.0 over stdio ───────────────────────────────────────────

const toolsList = Object.entries(TOOLS).map(([name, def]) => ({
  name,
  description: def.description,
  inputSchema: def.inputSchema,
  annotations: { capability: def.capability }
}));

const toolHandlers = Object.fromEntries(
  Object.entries(TOOLS).map(([name, def]) => [name, def.handler])
);

function jsonRpc(id, method, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = { code: error.code || -32603, message: error.message };
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\n');
  log('debug', `→ ${method}`, { id, result: error ? 'error' : 'success' });
}

async function handleInitialize(id) {
  jsonRpc(id, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'agent-stack-mcp-bridge', version: '0.1.0' }
  });
  log('info', 'Initialized');
}

async function handleListTools(id) {
  jsonRpc(id, 'tools/list', { tools: toolsList });
}

async function handleCallTool(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  log('info', `tools/call: ${name}`, args);

  const handler = toolHandlers[name];
  if (!handler) {
    return jsonRpc(id, 'tools/call', null, {
      code: -32602, message: `Unknown tool: ${name}. Available: ${Object.keys(toolHandlers).join(', ')}`
    });
  }

  try {
    const result = await handler(args);
    jsonRpc(id, 'tools/call', result);
  } catch (err) {
    log('error', `tools/call failed: ${name}`, err.message);
    jsonRpc(id, 'tools/call', null, {
      code: -32603, message: err.message
    });
  }
}

function handleNotification(method, params) {
  if (method === 'notifications/initialized') {
    log('info', 'Client initialized');
  }
}

// ─── Request router (shared between stdio and HTTP) ────────────────────

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (!method) {
    log('warn', 'Message without method', { id });
    return null;
  }

  log('debug', `← ${method}`, { id, hasParams: !!params });

  // Notifications (no id)
  if (id === undefined || id === null) {
    handleNotification(method, params);
    return null;
  }

  switch (method) {
    case 'initialize':
      return { id, method, result: await handleInitializeResult() };
    case 'tools/list':
      return { id, method, result: { tools: toolsList } };
    case 'tools/call':
      return await handleCallToolResult(id, params);
    default:
      return { id, method, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function formatResponse(response) {
  const msg = { jsonrpc: '2.0', id: response.id };
  if (response.error) msg.error = response.error;
  else msg.result = response.result;
  return JSON.stringify(msg);
}

async function handleInitializeResult() {
  return {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'agent-stack-mcp-bridge', version: '0.1.0' }
  };
}

async function handleCallToolResult(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  log('info', `tools/call: ${name}`, args);

  const handler = toolHandlers[name];
  if (!handler) {
    return { id, error: { code: -32602, message: `Unknown tool: ${name}. Available: ${Object.keys(toolHandlers).join(', ')}` } };
  }

  try {
    const result = await handler(args);
    return { id, result };
  } catch (err) {
    log('error', `tools/call failed: ${name}`, err.message);
    return { id, error: { code: -32603, message: err.message } };
  }
}

// ─── Start server ────────────────────────────────────────────────────

if (PORT > 0) {
  // HTTP mode
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: Object.keys(TOOLS).length }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body);
        const response = await handleMessage(msg);
        if (response) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(formatResponse(response));
        } else {
          res.writeHead(202); // Accepted (notification)
          res.end();
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
      }
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    log('info', `MCP Bridge listening on http://127.0.0.1:${PORT}`);
    console.error(`MCP Bridge ready on http://127.0.0.1:${PORT}`);
  });
} else {
  // Stdio mode (MCP protocol over stdin/stdout)
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // First message should be initialize
  let initialized = false;

  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;

    try {
      const msg = JSON.parse(line);
      const response = await handleMessage(msg);
      if (response) {
        const formatted = formatResponse(response);
        process.stdout.write(formatted + '\n');
        log('debug', `→ ${response.method}`, { id: response.id, result: response.error ? 'error' : 'success' });
      }
    } catch {
      log('error', 'Invalid JSON-RPC', line.slice(0, 200));
    }
  });

  process.stderr.write('MCP Bridge ready on stdin/stdout\n');
}
