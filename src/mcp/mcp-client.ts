// src/mcp/mcp-client.ts
// Lightweight MCP client — replaces @modelcontextprotocol/sdk Client.
// Handles JSON-RPC message routing and MCP protocol initialization.
import type {
  Transport,
  JSONRPCMessage,
  ClientInfo,
  InitializeResult,
  ListToolsResult,
  CallToolParams,
  CallToolResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceParams,
  ReadResourceResult,
} from './types';
import { LATEST_PROTOCOL_VERSION } from './types';

export class MCPClient {
  private transport: Transport | null = null;
  private _requestId = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private _serverCapabilities?: Record<string, unknown>;

  // ── Lifecycle ──

  async connect(transport: Transport): Promise<void> {
    this.transport = transport;

    return new Promise((resolve, reject) => {
      transport.onmessage = (msg) => this._onMessage(msg);
      transport.onclose = () => {
        // Reject all pending requests when connection drops
        for (const [, p] of this.pending) {
          p.reject(new Error('MCP connection closed'));
        }
        this.pending.clear();
      };
      transport.onerror = (err) => {
        // Log but don't reject — individual requests surface errors
        console.warn(`[mcp-client] Transport error: ${err.message}`);
      };

      transport.start()
        .then(() => this._initialize())
        .then(resolve)
        .catch(async (err) => {
          await transport.close().catch(() => {});
          reject(err);
        });
    });
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.transport = null;
  }

  get serverCapabilities(): Record<string, unknown> | undefined {
    return this._serverCapabilities;
  }

  // ── MCP Methods ──

  async listTools(): Promise<ListToolsResult> {
    return this._request('tools/list', {}) as Promise<ListToolsResult>;
  }

  async callTool(params: CallToolParams): Promise<CallToolResult> {
    return this._request('tools/call', params as unknown as Record<string, unknown>) as Promise<CallToolResult>;
  }

  async listResources(): Promise<ListResourcesResult> {
    return this._request('resources/list', {}) as Promise<ListResourcesResult>;
  }

  async listResourceTemplates(): Promise<ListResourceTemplatesResult> {
    return this._request('resources/templates/list', {}) as Promise<ListResourceTemplatesResult>;
  }

  async readResource(params: ReadResourceParams): Promise<ReadResourceResult> {
    return this._request('resources/read', params as unknown as Record<string, unknown>) as Promise<ReadResourceResult>;
  }

  async ping(): Promise<void> {
    await this._request('ping', {});
  }

  // ── Private ──

  private async _initialize(): Promise<void> {
    const result = await this._request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'my-agent', version: '0.1.0' } satisfies ClientInfo,
    }) as InitializeResult;

    if (!result || typeof result.protocolVersion !== 'string') {
      throw new Error('Invalid initialize response from MCP server');
    }

    this._serverCapabilities = result.capabilities ?? {};

    await this._notify('notifications/initialized', {});
  }

  private _request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.transport) {
      return Promise.reject(new Error('MCPClient not connected'));
    }

    const id = ++this._requestId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      this.transport!.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }).catch((err) => {
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private async _notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.transport?.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private _onMessage(msg: JSONRPCMessage): void {
    // Only handle responses (not notifications or requests from server)
    if (!('id' in msg) || msg.id === undefined || msg.id === null) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    this.pending.delete(msg.id);

    if ('error' in msg && msg.error) {
      const errMsg = typeof msg.error === 'object' && msg.error !== null
        ? (msg.error as { message?: string }).message ?? 'Unknown MCP error'
        : 'Unknown MCP error';
      pending.reject(new Error(errMsg));
    } else if ('result' in msg) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error('Invalid MCP response: no result or error'));
    }
  }
}
