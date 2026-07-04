// src/mcp/__tests__/manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpConfig } from '../config';

// Mock MCPConnection — use vi.hoisted so these survive vi.mock hoisting
const mockConnect = vi.hoisted(() => vi.fn());
const mockDisconnect = vi.hoisted(() => vi.fn());
const mockCallTool = vi.hoisted(() => vi.fn());
const mockListTools = vi.hoisted(() => vi.fn());
const mockListResources = vi.hoisted(() => vi.fn());
const mockStateRef = vi.hoisted(() => ({ value: 'idle' as string }));

vi.mock('../connection', () => ({
  MCPConnection: vi.fn().mockImplementation(function (this: unknown, name: string) {
    return {
      name,
      config: {},
      get state() { return mockStateRef.value; },
      connect: mockConnect,
      disconnect: mockDisconnect,
      callTool: mockCallTool,
      readResource: vi.fn(),
      listTools: mockListTools,
      listResources: mockListResources,
    };
  }),
}));

import { MCPManager, setMCPManager, getMCPManager } from '../manager';
import { defaultRegistry } from '../../tools/registry';

const MCP_CONFIG: McpConfig = {
  mcpServers: {
    tavily: {
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@anthropic/tavily-mcp'],
      idleTimeoutMs: 300000,
    },
    filesystem: {
      transport: 'stdio' as const,
      command: 'node',
      idleTimeoutMs: 300000,
    },
  },
};

describe('MCPManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStateRef.value = 'idle';

    // Clean up any MCP-related tools registered by previous tests
    // to ensure test isolation with the singleton defaultRegistry.
    for (const tool of defaultRegistry.getAll()) {
      if (tool.name.startsWith('mcp_')) {
        defaultRegistry.remove(tool.name);
      }
    }
  });

  describe('initialize', () => {
    it('registers mcp_list_servers and mcp_connect into defaultRegistry', () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      expect(defaultRegistry.get('mcp_list_servers')).toBeDefined();
      expect(defaultRegistry.get('mcp_connect')).toBeDefined();
    });

    it('creates MCPConnection objects for each server (not connected)', () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      const servers = manager.listServers();
      expect(servers).toHaveLength(2);
      expect(servers[0].name).toBe('tavily');
      expect(servers[0].state).toBe('idle');
      expect(servers[1].name).toBe('filesystem');
    });

    it('no-ops when mcpConfig is null', () => {
      const manager = new MCPManager();
      manager.initialize(null);
      expect(manager.listServers()).toHaveLength(0);
    });

    it('does not double-register tools on repeated initialize', () => {
      const manager1 = new MCPManager();
      manager1.initialize(MCP_CONFIG);
      const manager2 = new MCPManager();
      // Should not throw on second initialize
      manager2.initialize(MCP_CONFIG);
      expect(defaultRegistry.get('mcp_list_servers')).toBeDefined();
    });
  });

  describe('singleton', () => {
    it('throws if getMCPManager called before setMCPManager', () => {
      expect(() => getMCPManager()).toThrow();
    });

    it('getMCPManager returns the set instance', () => {
      const manager = new MCPManager();
      setMCPManager(manager);
      expect(getMCPManager()).toBe(manager);
    });
  });

  describe('connect', () => {
    it('connects and returns registered tool names', async () => {
      mockListTools.mockReturnValue([
        { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
      ]);
      mockStateRef.value = 'connected';

      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      const result = await manager.connect('tavily');
      expect(mockConnect).toHaveBeenCalled();
      expect(result.tools).toContain('mcp__tavily__search');
    });

    it('throws if server name not found in config', async () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      await expect(manager.connect('unknown')).rejects.toThrow('not found');
    });

    it('does not throw on duplicate tool registration (reconnect scenario)', async () => {
      mockListTools.mockReturnValue([
        { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
      ]);
      mockStateRef.value = 'connected';

      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      await manager.connect('tavily'); // First connect
      // Simulate disconnect
      mockStateRef.value = 'idle';
      // Reconnect — tools should already exist in registry, should not throw
      mockStateRef.value = 'connected';
      await expect(manager.connect('tavily')).resolves.toBeDefined();
    });
  });

  describe('disconnect', () => {
    it('disconnects by server name', async () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      await manager.disconnect('tavily');
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('throws if server not found', async () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      await expect(manager.disconnect('unknown')).rejects.toThrow('not found');
    });
  });

  describe('listServers', () => {
    it('returns all configured servers with their state', () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      const servers = manager.listServers();
      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual({ name: 'tavily', state: 'idle', toolsAvailable: 0 });
    });
  });

  describe('getConnection', () => {
    it('returns the connection for a given server name', () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);

      const conn = manager.getConnection('tavily');
      expect(conn).toBeDefined();
      expect(conn!.name).toBe('tavily');
    });

    it('returns undefined for unknown server', () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);
      expect(manager.getConnection('unknown')).toBeUndefined();
    });
  });

  describe('dynamic tool registration', () => {
    it('registers mcp__<server>__<tool> tools on connect', async () => {
      mockListTools.mockReturnValue([
        { name: 'search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Query' } }, required: ['query'] } },
      ]);
      mockStateRef.value = 'connected';

      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);
      await manager.connect('tavily');

      const tool = defaultRegistry.get('mcp__tavily__search');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('mcp__tavily__search');
      expect(tool!.description).toContain('Search the web');
    });

    it('tool handler auto-reconnects if disconnected', async () => {
      mockListTools.mockReturnValue([
        { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
      ]);
      mockStateRef.value = 'connected';

      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);
      await manager.connect('tavily');

      const tool = defaultRegistry.get('mcp__tavily__search')!;

      // Simulate disconnect
      mockStateRef.value = 'idle';
      mockCallTool.mockResolvedValueOnce({
        content: 'result from search',
        summary: 'search: result',
        exitCode: 0,
      });

      await tool.handler({ query: 'test' });
      expect(mockConnect).toHaveBeenCalled();
      expect(mockCallTool).toHaveBeenCalledWith('search', { query: 'test' });
    });

    it('tool handler returns error if reconnect fails', async () => {
      mockListTools.mockReturnValue([
        { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
      ]);
      mockStateRef.value = 'connected';

      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);
      await manager.connect('tavily');

      const tool = defaultRegistry.get('mcp__tavily__search')!;

      // Simulate disconnect + reconnect failure
      mockStateRef.value = 'idle';
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await tool.handler({ query: 'test' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Connection refused');
    });
  });

  describe('destroy', () => {
    it('disconnects all connections', async () => {
      const manager = new MCPManager();
      manager.initialize(MCP_CONFIG);
      await manager.destroy();
      expect(mockDisconnect).toHaveBeenCalledTimes(2);
    });
  });
});
