// src/mcp/connection.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerConfig } from './config';

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ResourceSchema {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: string;
  summary: string;
  exitCode: number;
  isError?: boolean;
}

export type ConnectionState = 'idle' | 'connected' | 'failed';

export class MCPConnection {
  readonly name: string;
  readonly config: McpServerConfig;

  private client: Client | null = null;
  private _state: ConnectionState = 'idle';
  private toolSchemas: ToolSchema[] = [];
  private resourceSchemas: ResourceSchema[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this._state === 'connected') return;

    try {
      const transport = this.createTransport();
      this.client = new Client(
        { name: 'my-agent', version: '0.1.0' },
        { capabilities: { tools: {} } },
      );
      await this.client.connect(transport);

      // Discover tools
      const toolsResult = await this.client.listTools();
      this.toolSchemas = (toolsResult.tools ?? []).map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as ToolSchema['inputSchema']) ?? {
          type: 'object',
          properties: {},
        },
      }));

      // Discover resources
      const resourcesResult = await this.client.listResources();
      this.resourceSchemas = (resourcesResult.resources ?? []).map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));

      this._state = 'connected';
      this.startIdleTimer();
    } catch (e) {
      this._state = 'failed';
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    this.clearIdleTimer();
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
    }
    this._state = 'idle';
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.client || this._state !== 'connected') {
      throw new Error(`MCP server "${this.name}" is not connected`);
    }

    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
      );

      const textContent = result.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      this.resetIdleTimer();
      return {
        content: textContent,
        summary: `mcp__${this.name}__${name}: ${textContent.slice(0, 100)}`,
        exitCode: 0,
      };
    } catch (e) {
      return {
        content: `MCP tool "${name}" error: ${e instanceof Error ? e.message : String(e)}`,
        summary: `mcp__${this.name}__${name}: ${e instanceof Error ? e.message : String(e)}`,
        exitCode: 1,
        isError: true,
      };
    }
  }

  async readResource(uri: string): Promise<string> {
    if (!this.client || this._state !== 'connected') {
      throw new Error(`MCP server "${this.name}" is not connected`);
    }

    const result = await this.client.readResource({ uri });
    return result.contents
      .filter((c): c is { text: string } => 'text' in c)
      .map(c => c.text)
      .join('\n');
  }

  listTools(): ToolSchema[] {
    return [...this.toolSchemas];
  }

  listResources(): ResourceSchema[] {
    return [...this.resourceSchemas];
  }

  private createTransport() {
    const { config } = this;
    if (config.transport === 'stdio') {
      return new StdioClientTransport({
        command: config.command!,
        args: config.args,
      });
    } else {
      return new SSEClientTransport(new URL(config.url!));
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.disconnect().catch(() => {});
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetIdleTimer(): void {
    this.startIdleTimer();
  }
}
