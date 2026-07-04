// src/tools/registry.ts
import type { ToolDefinition } from './types';

export type { ToolDefinition };

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  remove(name: string): void;
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered`);
      }
      tools.set(tool.name, tool);
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },

    getAll(): ToolDefinition[] {
      return Array.from(tools.values());
    },

    remove(name: string): void {
      tools.delete(name);
    },
  };
}

// Singleton default registry — tools register themselves into this.
export const defaultRegistry: ToolRegistry = createRegistry();
