// src/mcp/__tests__/connection.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to create mock variables that survive vi.mock hoisting
const mockClientConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockClientClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockClientCallTool = vi.hoisted(() => vi.fn());
const mockClientListTools = vi.hoisted(() => vi.fn());
const mockClientListResources = vi.hoisted(() => vi.fn());
const mockClientReadResource = vi.hoisted(() => vi.fn());
const mockStdioClientTransport = vi.hoisted(() => vi.fn());
const mockSSEClientTransport = vi.hoisted(() => vi.fn());

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function() {
    return {
      connect: mockClientConnect,
      close: mockClientClose,
      callTool: mockClientCallTool,
      listTools: mockClientListTools,
      listResources: mockClientListResources,
      readResource: mockClientReadResource,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mockStdioClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: mockSSEClientTransport,
}));

import { MCPConnection } from '../connection';
import type { McpServerConfig } from '../config';

const STDIO_CONFIG: McpServerConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'test-mcp'],
  idleTimeoutMs: 300000,
};

const SSE_CONFIG: McpServerConfig = {
  transport: 'sse',
  url: 'https://example.com/mcp',
  idleTimeoutMs: 300000,
};

function makeToolsResponse(tools: Array<{ name: string; description?: string }>) {
  return {
    tools: tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: { type: 'object' as const, properties: {} },
    })),
  };
}

describe('MCPConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientListTools.mockResolvedValue(makeToolsResponse([]));
    mockClientListResources.mockResolvedValue({ resources: [] });
    mockClientCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'result' }],
    });
    mockClientReadResource.mockResolvedValue({
      contents: [{ text: 'resource content' }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    it('starts in idle state', () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      expect(conn.state).toBe('idle');
      expect(conn.name).toBe('test');
    });
  });

  describe('connect', () => {
    it('creates StdioClientTransport for stdio config', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      expect(mockStdioClientTransport).toHaveBeenCalledWith({
        command: 'npx',
        args: ['-y', 'test-mcp'],
      });
      expect(mockClientConnect).toHaveBeenCalled();
      expect(conn.state).toBe('connected');
    });

    it('creates SSEClientTransport for sse config', async () => {
      const conn = new MCPConnection('test', SSE_CONFIG);
      await conn.connect();

      expect(mockSSEClientTransport).toHaveBeenCalled();
      expect(mockClientConnect).toHaveBeenCalled();
      expect(conn.state).toBe('connected');
    });

    it('discovers tools and caches schemas', async () => {
      mockClientListTools.mockResolvedValue(makeToolsResponse([
        { name: 'search', description: 'Search the web' },
        { name: 'extract', description: 'Extract content' },
      ]));

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      const tools = conn.listTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('search');
      expect(tools[1].name).toBe('extract');
    });

    it('discovers resources and caches schemas', async () => {
      mockClientListResources.mockResolvedValue({
        resources: [{ uri: 'file:///data', name: 'Data' }],
      });

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      const resources = conn.listResources();
      expect(resources).toHaveLength(1);
      expect(resources[0].uri).toBe('file:///data');
    });

    it('transitions to failed state on connect error', async () => {
      mockClientConnect.mockRejectedValueOnce(new Error('Connection refused'));

      const conn = new MCPConnection('test', SSE_CONFIG);
      await expect(conn.connect()).rejects.toThrow('Connection refused');
      expect(conn.state).toBe('failed');
    });

    it('does nothing if already connected', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();
      vi.clearAllMocks();

      await conn.connect();
      expect(mockClientConnect).not.toHaveBeenCalled();
    });

    it('reconnects if previously failed', async () => {
      mockClientConnect.mockRejectedValueOnce(new Error('fail'));

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await expect(conn.connect()).rejects.toThrow('fail');
      expect(conn.state).toBe('failed');

      vi.clearAllMocks();
      mockClientConnect.mockResolvedValueOnce(undefined);

      await conn.connect();
      expect(mockClientConnect).toHaveBeenCalled();
      expect(conn.state).toBe('connected');
    });
  });

  describe('disconnect', () => {
    it('closes the client and returns to idle', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();
      await conn.disconnect();

      expect(mockClientClose).toHaveBeenCalled();
      expect(conn.state).toBe('idle');
    });

    it('does nothing if already idle', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.disconnect();
      expect(mockClientClose).not.toHaveBeenCalled();
    });
  });

  describe('callTool', () => {
    it('calls client.callTool with name and args', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      const result = await conn.callTool('search', { query: 'hello' });

      expect(mockClientCallTool).toHaveBeenCalledWith(
        { name: 'search', arguments: { query: 'hello' } },
        undefined,
      );
      expect(result.content).toBe('result');
      expect(result.exitCode).toBe(0);
    });

    it('throws if not connected', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await expect(conn.callTool('search', {})).rejects.toThrow('not connected');
    });

    it('returns error ToolResult when MCP call fails', async () => {
      mockClientCallTool.mockRejectedValueOnce(new Error('Tool error'));

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      const result = await conn.callTool('search', {});
      expect(result.isError).toBe(true);
      expect(result.summary).toContain('Tool error');
    });
  });

  describe('readResource', () => {
    it('reads a resource and returns text content', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      const result = await conn.readResource('file:///data');

      expect(mockClientReadResource).toHaveBeenCalledWith({ uri: 'file:///data' });
      expect(result).toBe('resource content');
    });

    it('throws if not connected', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await expect(conn.readResource('file:///data')).rejects.toThrow('not connected');
    });
  });

  describe('idle timeout', () => {
    it('disconnects after idleTimeoutMs', async () => {
      vi.useFakeTimers();
      const conn = new MCPConnection('test', { ...STDIO_CONFIG, idleTimeoutMs: 5000 });
      await conn.connect();
      vi.clearAllMocks(); // Clear connect-related calls

      vi.advanceTimersByTime(5000);
      // Allow pending microtasks to flush
      await Promise.resolve();

      expect(mockClientClose).toHaveBeenCalled();
      expect(conn.state).toBe('idle');
    });

    it('resets idle timer on callTool', async () => {
      vi.useFakeTimers();
      const conn = new MCPConnection('test', { ...STDIO_CONFIG, idleTimeoutMs: 5000 });
      await conn.connect();

      vi.advanceTimersByTime(4000);
      await conn.callTool('search', {});
      vi.clearAllMocks();

      // Timer was reset, so 4000ms later it shouldn't fire yet
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
      expect(mockClientClose).not.toHaveBeenCalled();

      // After full 5000ms from the reset, it fires
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(mockClientClose).toHaveBeenCalled();
    });
  });
});
