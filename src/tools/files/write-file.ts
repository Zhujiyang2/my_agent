// src/tools/files/write-file.ts
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../types';
import { normalizePath } from '../path-utils';

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file with the provided content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  handler: async (params: Record<string, unknown>) => {
    const filePath = normalizePath(String(params.path ?? ''));
    const content = String(params.content ?? '');

    try {
      const dir = path.dirname(filePath);
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, content, 'utf-8');
      const bytes = Buffer.byteLength(content, 'utf-8');
      const action = existed ? 'Overwritten' : 'Created';
      const msg = `${action} ${filePath} (${bytes} bytes)`;
      return {
        content: msg,
        summary: `wrote ${content.split('\n').length} lines to ${filePath}`,
        exitCode: 0,
        keyOutput: msg,
      };
    } catch (e) {
      return {
        content: `Error writing file: ${e instanceof Error ? e.message : String(e)}`,
        summary: `write error: ${e instanceof Error ? e.message : String(e)}`,
        exitCode: 1,
        isError: true,
      };
    }
  },
};
