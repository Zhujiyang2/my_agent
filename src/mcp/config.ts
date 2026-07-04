// src/mcp/config.ts
import fs from 'node:fs';

export interface McpServerConfig {
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  idleTimeoutMs: number; // default 300000
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

function validateMcpServerConfig(
  name: string,
  raw: Record<string, unknown>,
): McpServerConfig | null {
  const transport = raw.transport;
  if (transport !== 'stdio' && transport !== 'sse') {
    console.warn(`[mcp] Skipping server "${name}": missing or invalid "transport" field`);
    return null;
  }

  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command === '') {
      console.warn(`[mcp] Skipping server "${name}": stdio transport requires "command"`);
      return null;
    }
  }

  if (transport === 'sse') {
    if (typeof raw.url !== 'string' || raw.url === '') {
      console.warn(`[mcp] Skipping server "${name}": sse transport requires "url"`);
      return null;
    }
  }

  const config: McpServerConfig = {
    transport,
    idleTimeoutMs:
      typeof raw.idleTimeoutMs === 'number' && raw.idleTimeoutMs > 0
        ? raw.idleTimeoutMs
        : DEFAULT_IDLE_TIMEOUT_MS,
  };

  if (typeof raw.command === 'string') {
    config.command = raw.command;
  }
  if (Array.isArray(raw.args)) {
    config.args = raw.args.filter((a): a is string => typeof a === 'string');
  }
  if (isValidStringRecord(raw.env)) {
    config.env = raw.env;
  }
  if (typeof raw.url === 'string') {
    config.url = raw.url;
  }
  if (isValidStringRecord(raw.headers)) {
    config.headers = raw.headers;
  }

  return config;
}

function isValidStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(v => typeof v === 'string');
}

export function loadMcpConfig(filePath?: string): McpConfig | null {
  const resolvedPath = filePath ?? `${process.env.HOME ?? process.env.USERPROFILE}/.my_agent/mcp.json`;

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    raw = JSON.parse(content);
  } catch {
    console.warn(`[mcp] Failed to parse ${resolvedPath}: invalid JSON`);
    return null;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn(`[mcp] ${resolvedPath} must contain a JSON object`);
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const serversRaw = obj.mcpServers;

  if (serversRaw === undefined || serversRaw === null) {
    return { mcpServers: {} };
  }

  if (typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
    console.warn(`[mcp] "mcpServers" must be an object`);
    return null;
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, serverRaw] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (typeof serverRaw !== 'object' || serverRaw === null) {
      console.warn(`[mcp] Skipping server "${name}": value is not an object`);
      continue;
    }
    const validated = validateMcpServerConfig(name, serverRaw as Record<string, unknown>);
    if (validated) {
      mcpServers[name] = validated;
    }
  }

  return { mcpServers };
}
