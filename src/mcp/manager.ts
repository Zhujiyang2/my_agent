// src/mcp/manager.ts
import { MCPConnection } from './connection';
import type { ConnectionState, ToolSchema } from './connection';
import type { McpConfig } from './config';
import { defaultRegistry } from '../tools/registry';
import type { ToolDefinition } from '../tools/types';

export interface McpServerStatus {
  name: string;
  state: string;
  toolsAvailable: number;
}

export interface McpConnectResult {
  server: string;
  tools: string[];
}

function stateDisplay(state: ConnectionState): string {
  if (state === 'connected') return 'connected';
  if (state === 'failed') return 'error';
  return 'idle';
}

export class MCPManager {
  private connections: Map<string, MCPConnection> = new Map();

  initialize(config: McpConfig | null): void {
    if (!config) return;

    // Register management tools (only once)
    if (!defaultRegistry.get('mcp_list_servers')) {
      defaultRegistry.register(this.createListServersTool());
    }
    if (!defaultRegistry.get('mcp_connect')) {
      defaultRegistry.register(this.createConnectTool());
    }

    // Create MCPConnection objects for each server (no connect)
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      this.connections.set(name, new MCPConnection(name, serverConfig));
    }
  }

  async connect(serverName: string): Promise<McpConnectResult> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server "${serverName}" not found in config`);
    }

    await conn.connect();

    const schemas = conn.listTools();
    const tools: string[] = [];

    for (const schema of schemas) {
      const toolName = `mcp__${serverName}__${schema.name}`;
      const toolDef = buildMcpToolDefinition(serverName, schema, this);
      try {
        defaultRegistry.register(toolDef);
      } catch {
        // Tool already registered from previous connect cycle — skip
      }
      tools.push(toolName);
    }

    return { server: serverName, tools };
  }

  async disconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server "${serverName}" not found`);
    }
    await conn.disconnect();
  }

  listServers(): McpServerStatus[] {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      state: stateDisplay(conn.state),
      toolsAvailable: conn.state === 'connected' ? conn.listTools().length : 0,
    }));
  }

  getConnection(name: string): MCPConnection | undefined {
    return this.connections.get(name);
  }

  async destroy(): Promise<void> {
    const disconnects: Promise<void>[] = [];
    for (const conn of this.connections.values()) {
      disconnects.push(conn.disconnect());
    }
    await Promise.all(disconnects);
  }

  // ── Private: management tool factories ──

  private createListServersTool(): ToolDefinition {
    return {
      name: 'mcp_list_servers',
      description:
        'List all configured MCP servers with their connection state and available tools. ' +
        'States: "connected", "idle", or "error".',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        const servers = this.listServers();
        const lines = servers.map(s =>
          `- ${s.name}: ${s.state}${s.toolsAvailable > 0 ? ` (${s.toolsAvailable} tools available)` : ''}`,
        );
        return {
          content: lines.length > 0 ? lines.join('\n') : 'No MCP servers configured.',
          summary: `Listed ${servers.length} MCP server(s)`,
          exitCode: 0,
        };
      },
    };
  }

  private createConnectTool(): ToolDefinition {
    return {
      name: 'mcp_connect',
      description: 'Connect to an MCP server and discover its tools.',
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Name of the MCP server to connect to',
          },
        },
        required: ['server'],
      },
      handler: async (params: Record<string, unknown>) => {
        const serverName = String(params.server ?? '');
        try {
          const result = await this.connect(serverName);
          return {
            content: `Connected to "${serverName}". Tools registered: ${result.tools.join(', ')}`,
            summary: `Connected to MCP server "${serverName}" with ${result.tools.length} tools`,
            exitCode: 0,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: `Error connecting to MCP server "${serverName}": ${msg}`,
            summary: `mcp_connect failed for "${serverName}": ${msg}`,
            exitCode: 1,
            isError: true,
          };
        }
      },
    };
  }
}

// ── Helper: build a dynamic ToolDefinition for an MCP tool ──

function buildMcpToolDefinition(
  serverName: string,
  schema: ToolSchema,
  manager: MCPManager,
): ToolDefinition {
  return {
    name: `mcp__${serverName}__${schema.name}`,
    description: schema.description,
    parameters: schema.inputSchema as ToolDefinition['parameters'],
    handler: async (params: Record<string, unknown>) => {
      const conn = manager.getConnection(serverName);
      if (!conn) {
        return {
          content: `Error: MCP server "${serverName}" not found in manager`,
          summary: `mcp__${serverName}__${schema.name}: server not found`,
          exitCode: 1,
          isError: true,
        };
      }

      // Auto-reconnect if not connected
      if (conn.state !== 'connected') {
        try {
          await conn.connect();
        } catch (e) {
          return {
            content: `Failed to reconnect to MCP server "${serverName}": ${e instanceof Error ? e.message : String(e)}`,
            summary: `mcp__${serverName}__${schema.name}: reconnect failed`,
            exitCode: 1,
            isError: true,
          };
        }
      }

      return conn.callTool(schema.name, params);
    },
  };
}

// ── Singleton ──

let managerInstance: MCPManager | null = null;

export function setMCPManager(mgr: MCPManager): void {
  managerInstance = mgr;
}

export function getMCPManager(): MCPManager {
  if (!managerInstance) {
    throw new Error('MCPManager not initialized. Call setMCPManager() first.');
  }
  return managerInstance;
}
