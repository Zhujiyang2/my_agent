// src/mcp/types.ts
// Lightweight JSON-RPC 2.0 + MCP types — replaces @modelcontextprotocol/sdk types.

// ── JSON-RPC 2.0 ──

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

// ── Transport ──

export interface Transport {
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

// ── MCP Protocol ──

export const LATEST_PROTOCOL_VERSION = '2024-11-05';

export interface ClientInfo {
  name: string;
  version: string;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo?: { name: string; version: string };
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ListToolsResult {
  tools: ToolDef[];
}

export interface CallToolParams {
  name: string;
  arguments: Record<string, unknown>;
}

export interface CallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface ResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ListResourcesResult {
  resources: ResourceDef[];
}

export interface ResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ListResourceTemplatesResult {
  resourceTemplates: ResourceTemplateDef[];
}

export interface ReadResourceParams {
  uri: string;
}

export interface ReadResourceResult {
  contents: Array<{ text?: string; uri?: string }>;
}

// ── Connection-level types (used by MCPConnection) ──

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  content: string;
  summary: string;
  exitCode: number;
  isError?: boolean;
}

export interface ResourceSchema {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateSchema {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export type ConnectionState = 'idle' | 'connected' | 'failed';
