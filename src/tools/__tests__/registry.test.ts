// src/tools/__tests__/registry.test.ts
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import type { ToolDefinition } from '../types';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => ({ content: `${name} done` }),
  };
}

describe('createRegistry', () => {
  it('registers tools and retrieves by name', () => {
    const registry = createRegistry();
    const tool = makeTool('test_tool');
    registry.register(tool);
    expect(registry.get('test_tool')).toBe(tool);
  });

  it('returns undefined for unknown tool', () => {
    const registry = createRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('throws on duplicate tool name', () => {
    const registry = createRegistry();
    registry.register(makeTool('dup'));
    expect(() => registry.register(makeTool('dup'))).toThrow(/already registered/i);
  });

  it('returns all registered tools', () => {
    const registry = createRegistry();
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));
    expect(registry.getAll()).toHaveLength(2);
  });
});
