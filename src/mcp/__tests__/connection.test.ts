// src/mcp/__tests__/connection.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared mock state — hoisted
const mockClientConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockClientClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockClientListTools = vi.hoisted(() => vi.fn().mockResolvedValue({ tools: [] }));
const mockClientListResources = vi.hoisted(() => vi.fn().mockResolvedValue({ resources: [] }));
const mockClientListResourceTemplates = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ resourceTemplates: [] }),
);
const mockClientCallTool = vi.hoisted(() => vi.fn());
const mockClientReadResource = vi.hoisted(() => vi.fn());

// Use vi.fn with implementations that return objects so `new` works
// AND the function is a spy (so toHaveBeenCalled works)
const mockMCPClientCtor = vi.hoisted(() =>
  vi.fn(function () {
    return {
      connect: mockClientConnect,
      close: mockClientClose,
      listTools: mockClientListTools,
      listResources: mockClientListResources,
      listResourceTemplates: mockClientListResourceTemplates,
      callTool: mockClientCallTool,
      readResource: mockClientReadResource,
    };
  }),
);

const mockStdioTransportCtor = vi.hoisted(() =>
  vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
);

const mockStreamableHTTPTransportCtor = vi.hoisted(() =>
  vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
);

vi.mock('../mcp-client', () => ({
  MCPClient: mockMCPClientCtor,
}));

vi.mock('../transports/stdio', () => ({
  StdioTransport: mockStdioTransportCtor,
}));

vi.mock('../transports/streamable-http', () => ({
  StreamableHTTPTransport: mockStreamableHTTPTransportCtor,
}));

import { MCPConnection } from '../connection';
import { StdioTransport } from '../transports/stdio';
import { StreamableHTTPTransport } from '../transports/streamable-http';
import type { McpServerConfig } from '../config';

const STDIO_CONFIG: McpServerConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'test-mcp'],
  idleTimeoutMs: 300000,
  connectTimeoutMs: 30000,
};

const STREAMABLE_HTTP_CONFIG: McpServerConfig = {
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  idleTimeoutMs: 300000,
  connectTimeoutMs: 30000,
};

describe('MCPConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientListTools.mockResolvedValue({ tools: [] });
    mockClientListResources.mockResolvedValue({ resources: [] });
    mockClientListResourceTemplates.mockResolvedValue({ resourceTemplates: [] });
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
    });
  });

  describe('connect', () => {
    it('creates StdioTransport for stdio config', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      expect(StdioTransport).toHaveBeenCalledWith({
        command: 'npx',
        args: ['-y', 'test-mcp'],
        env: undefined,
        cwd: undefined,
        stderr: undefined,
      });
      expect(conn.state).toBe('connected');
    });

    it('passes all fields to StdioTransport', async () => {
      const config: McpServerConfig = {
        transport: 'stdio',
        command: 'node',
        args: ['s.js'],
        env: { KEY: 'val' },
        cwd: '/app',
        stderr: 'ignore',
        idleTimeoutMs: 300000,
        connectTimeoutMs: 30000,
      };
      const conn = new MCPConnection('test', config);
      await conn.connect();

      expect(StdioTransport).toHaveBeenCalledWith({
        command: 'node',
        args: ['s.js'],
        env: { KEY: 'val' },
        cwd: '/app',
        stderr: 'ignore',
      });
    });

    it('creates StreamableHTTPTransport for streamable-http config', async () => {
      const config: McpServerConfig = {
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        idleTimeoutMs: 300000,
        connectTimeoutMs: 30000,
      };
      const conn = new MCPConnection('test', config);
      await conn.connect();

      expect(StreamableHTTPTransport).toHaveBeenCalledWith({
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      });
      expect(conn.state).toBe('connected');
    });

    it('discovers tools and caches schemas', async () => {
      mockClientListTools.mockResolvedValue({
        tools: [
          { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
          { name: 'extract', description: 'Extract', inputSchema: { type: 'object', properties: {} } },
        ],
      });

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      expect(conn.listTools()).toHaveLength(2);
    });

    it('discovers resources and caches schemas', async () => {
      mockClientListResources.mockResolvedValue({
        resources: [{ uri: 'file:///data', name: 'Data' }],
      });

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      expect(conn.listResources()).toHaveLength(1);
    });

    it('discovers resource templates', async () => {
      mockClientListResourceTemplates.mockResolvedValue({
        resourceTemplates: [{ uriTemplate: 'file:///{p}', name: 'F' }],
      });

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      expect(conn.listResourceTemplates()).toHaveLength(1);
    });

    it('handles missing resources gracefully', async () => {
      mockClientListResources.mockRejectedValueOnce(new Error('not supported'));

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      expect(conn.listResources()).toEqual([]);
      expect(conn.state).toBe('connected');
    });

    it('handles missing resource templates gracefully', async () => {
      mockClientListResourceTemplates.mockRejectedValueOnce(new Error('not supported'));

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();

      expect(conn.listResourceTemplates()).toEqual([]);
    });

    it('transitions to failed state on connect error', async () => {
      mockClientConnect.mockRejectedValueOnce(new Error('Connection refused'));

      const conn = new MCPConnection('test', STREAMABLE_HTTP_CONFIG);
      await expect(conn.connect()).rejects.toThrow('Connection refused');
      expect(conn.state).toBe('failed');
    });

    it('does nothing if already connected', async () => {
      const conn = new MCPConnection('test', STDIO_CONFIG);
      await conn.connect();
      vi.clearAllMocks();

      await conn.connect();
      expect(StdioTransport).not.toHaveBeenCalled();
      expect(conn.state).toBe('connected');
    });

    it('reconnects if previously failed', async () => {
      mockClientConnect.mockRejectedValueOnce(new Error('fail'));

      const conn = new MCPConnection('test', STDIO_CONFIG);
      await expect(conn.connect()).rejects.toThrow('fail');
      expect(conn.state).toBe('failed');

      vi.clearAllMocks();
      await conn.connect();
      expect(conn.state).toBe('connected');
    });

    it('prevents concurrent connect() calls', async () => {
      let resolveConnect!: (v: void) => void;
      mockClientConnect.mockReturnValueOnce(
        new Promise<void>((r) => { resolveConnect = r; }),
      );

      const conn = new MCPConnection('test', STDIO_CONFIG);
      const p1 = conn.connect();
      const p2 = conn.connect();

      resolveConnect();
      await Promise.all([p1, p2]);

      expect(conn.state).toBe('connected');
      // Only one transport created (StdioTransport called once)
      expect(StdioTransport).toHaveBeenCalledTimes(1);
    });

    it('rejects with timeout error', async () => {
      mockClientConnect.mockReturnValueOnce(new Promise(() => {})); // hang forever

      const config = { ...STDIO_CONFIG, connectTimeoutMs: 50 };
      const conn = new MCPConnection('test', config);

      await expect(conn.connect()).rejects.toThrow('timed out');
      expect(conn.state).toBe('failed');
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

      expect(mockClientCallTool).toHaveBeenCalledWith({
        name: 'search',
        arguments: { query: 'hello' },
      });
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
      vi.clearAllMocks();

      vi.advanceTimersByTime(5000);
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

      vi.advanceTimersByTime(4000);
      await Promise.resolve();
      expect(mockClientClose).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(mockClientClose).toHaveBeenCalled();
    });
  });
});
