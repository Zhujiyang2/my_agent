// src/tools/memory/forget.ts
import type { ToolDefinition } from '../../tools/types';
import type { MemoryManager } from '../../memory/index';

export function createForgetTool(mm: MemoryManager): ToolDefinition {
  return {
    name: 'forget',
    description: '删除一条长期记忆。用于清理过时、错误或不再适用的记忆。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '要删除的记忆名（kebab-case）',
        },
      },
      required: ['name'],
    },
    handler: async (params: Record<string, unknown>) => {
      const name = String(params.name ?? '');

      const names = await mm.list();
      if (!names.includes(name)) {
        return {
          content: `Memory "${name}" not found. Available memories: ${names.join(', ') || '(none)'}`,
          summary: `forget failed: "${name}" not found`,
          exitCode: 1,
          isError: true,
        };
      }

      await mm.forget(name);

      return {
        content: `Memory "${name}" deleted.`,
        summary: `forgot ${name}`,
        exitCode: 0,
      };
    },
  };
}
