// src/tools/files/read-file.ts
import fs from 'node:fs';
import type { ToolDefinition } from '../types';
import { normalizePath } from '../path-utils';

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read file contents with line numbers. Supports offset and limit for pagination.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      offset: { type: 'number', description: 'Start line (0-indexed, default: 0)' },
      limit: { type: 'number', description: 'Max lines to read (default: all)' },
    },
    required: ['path'],
  },
  handler: async (params: Record<string, unknown>) => {
    const filePath = normalizePath(String(params.path ?? ''));
    const offset = typeof params.offset === 'number' ? params.offset : 0;
    const limit = typeof params.limit === 'number' ? params.limit : undefined;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, offset);
      const end = limit !== undefined ? start + limit : lines.length;
      const selected = lines.slice(start, end);
      const numbered = selected.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
      return { content: numbered };
    } catch (e) {
      return {
        content: `Error reading file: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
