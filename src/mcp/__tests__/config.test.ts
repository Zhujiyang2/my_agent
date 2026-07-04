// src/mcp/__tests__/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadMcpConfig } from '../config';

describe('loadMcpConfig', () => {
  it('returns null when mcp.json does not exist', () => {
    const result = loadMcpConfig('/nonexistent/path/mcp.json');
    expect(result).toBeNull();
  });

  it('loads a valid mcp.json with stdio server', () => {
    const result = loadMcpConfig('src/mcp/__tests__/fixtures/valid-stdio.json');
    expect(result).not.toBeNull();
    expect(result!.mcpServers).toHaveProperty('tavily');
    expect(result!.mcpServers['tavily']).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/tavily-mcp'],
      env: { TAVILY_API_KEY: 'test-key' },
      idleTimeoutMs: 300000,
    });
  });

  it('loads a valid mcp.json with sse server', () => {
    const result = loadMcpConfig('src/mcp/__tests__/fixtures/valid-sse.json');
    expect(result).not.toBeNull();
    expect(result!.mcpServers['remote-db']).toEqual({
      transport: 'sse',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer xxx' },
      idleTimeoutMs: 600000,
    });
  });

  it('returns empty McpConfig when mcpServers is empty', () => {
    const result = loadMcpConfig('src/mcp/__tests__/fixtures/empty.json');
    expect(result).toEqual({ mcpServers: {} });
  });

  it('returns null and logs warning for invalid JSON', () => {
    const result = loadMcpConfig('src/mcp/__tests__/fixtures/invalid.json');
    expect(result).toBeNull();
  });

  it('skips invalid server configs, keeps valid ones', () => {
    const result = loadMcpConfig('src/mcp/__tests__/fixtures/partial-invalid.json');
    expect(result).not.toBeNull();
    // Only the valid server is kept
    expect(Object.keys(result!.mcpServers)).toEqual(['tavily']);
  });

  it('applies default idleTimeoutMs (300000) when not specified', () => {
    const result = loadMcpConfig('src/mcp/__tests__/fixtures/valid-stdio.json');
    expect(result!.mcpServers['tavily'].idleTimeoutMs).toBe(300000);
  });
});
