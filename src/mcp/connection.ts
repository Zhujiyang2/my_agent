// src/mcp/connection.ts
import { MCPClient } from './mcp-client';
import { StdioTransport } from './transports/stdio';
import { StreamableHTTPTransport } from './transports/streamable-http';
import type { McpServerConfig } from './config';
import type { ToolSchema, ToolResult, ResourceSchema, ResourceTemplateSchema, ConnectionState } from './types';

// Re-export types used by manager.ts
export type { ToolSchema, ToolResult, ResourceSchema, ResourceTemplateSchema, ConnectionState };

export class MCPConnection {
  readonly name: string;
  readonly config: McpServerConfig;

  private client: MCPClient | null = null;
  private _state: ConnectionState = 'idle';
  private toolSchemas: ToolSchema[] = [];
  private resourceSchemas: ResourceSchema[] = [];
  private resourceTemplateSchemas: ResourceTemplateSchema[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this._state === 'connected') return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
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

    this.clearIdleTimer();

    try {
      const result = await this.client.callTool({ name, arguments: args });

      const textContent = (result.content ?? [])
        .filter((c): c is { type: string; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n');

      this.startIdleTimer();
      return {
        content: textContent,
        summary: `mcp__${this.name}__${name}: ${textContent.slice(0, 100)}`,
        exitCode: 0,
        isError: result.isError,
      };
    } catch (e) {
      this.startIdleTimer();
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
    this.resetIdleTimer();
    const contents = result.contents as Array<{ text?: string; uri?: string }>;
    return contents
      .filter(c => typeof c.text === 'string')
      .map(c => c.text!)
      .join('\n');
  }

  listTools(): ToolSchema[] {
    return [...this.toolSchemas];
  }

  listResources(): ResourceSchema[] {
    return [...this.resourceSchemas];
  }

  listResourceTemplates(): ResourceTemplateSchema[] {
    return [...this.resourceTemplateSchemas];
  }

  // ── Private ──

  private async doConnect(): Promise<void> {
    try {
      if (this.client) {
        try { await this.client.close(); } catch { /* ignore */ }
        this.client = null;
      }

      const transport = this.createTransport();
      transport.onclose = () => {
        if (this.client) {
          this.client.close().catch(() => {});
          this.client = null;
        }
        this._state = 'idle';
        this.clearIdleTimer();
      };
      transport.onerror = (err: Error) => {
        console.warn(`[mcp] Transport error for "${this.name}":`, err.message);
      };

      const client = new MCPClient();

      await this.withTimeout(
        () => client.connect(transport),
        this.config.connectTimeoutMs,
        `Connection to MCP server "${this.name}" timed out after ${this.config.connectTimeoutMs}ms`,
      );

      // Discover tools
      const toolsResult = await this.withTimeout(
        () => client.listTools(),
        this.config.connectTimeoutMs,
        `Listing tools from "${this.name}" timed out`,
      );
      this.toolSchemas = (toolsResult.tools ?? []).map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: this.validateInputSchema(t.inputSchema, t.name),
      }));

      // Discover resources (optional)
      try {
        const resourcesResult = await client.listResources();
        this.resourceSchemas = (resourcesResult.resources ?? []).map(r => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
      } catch {
        this.resourceSchemas = [];
      }

      // Discover resource templates (optional)
      try {
        const templatesResult = await client.listResourceTemplates();
        this.resourceTemplateSchemas = (templatesResult.resourceTemplates ?? []).map(t => ({
          uriTemplate: t.uriTemplate,
          name: t.name,
          description: t.description,
          mimeType: t.mimeType,
        }));
      } catch {
        this.resourceTemplateSchemas = [];
      }

      this.client = client;
      this._state = 'connected';
      this.startIdleTimer();
    } catch (e) {
      if (this.client) {
        try { await this.client.close(); } catch { /* ignore */ }
        this.client = null;
      }
      this._state = 'failed';
      throw e;
    }
  }

  private validateInputSchema(
    raw: unknown,
    toolName: string,
  ): ToolSchema['inputSchema'] {
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'type' in raw &&
      (raw as Record<string, unknown>).type === 'object' &&
      'properties' in raw &&
      typeof (raw as Record<string, unknown>).properties === 'object'
    ) {
      const obj = raw as Record<string, unknown>;
      return {
        type: 'object' as const,
        properties: obj.properties as Record<string, unknown>,
        required: Array.isArray(obj.required)
          ? (obj.required as string[]).filter((r): r is string => typeof r === 'string')
          : undefined,
      };
    }
    console.warn(
      `[mcp] Tool "${toolName}" from server "${this.name}" has non-standard inputSchema, using empty schema`,
    );
    return { type: 'object', properties: {} };
  }

  private createTransport() {
    const { config } = this;

    switch (config.transport) {
      case 'stdio':
        return new StdioTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
          stderr: config.stderr,
        });

      case 'streamable-http':
        return new StreamableHTTPTransport({
          url: config.url,
          headers: config.headers,
        });

      case 'sse':
        // SSE is deprecated; streamable-http is preferred. We fall back to
        // stdio for SSE since the eventsource-based transport is unreliable.
        throw new Error(
          'SSE transport is not supported. Use "streamable-http" instead.',
        );

      default:
        throw new Error(`Unknown transport: ${(config as McpServerConfig).transport}`);
    }
  }

  private withTimeout<T>(
    fn: () => Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(message));
      }, ms);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
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
