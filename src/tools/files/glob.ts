// src/tools/files/glob.ts
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import type { ToolDefinition } from '../types';
import { normalizePath } from '../path-utils';

function runGlob(pattern: string, workdir: string): string {
  const s = statSync(workdir);
  if (!s.isDirectory()) return '';

  // Strip **/ prefix — find searches recursively by default
  const namePattern = pattern.replace(/^\*\*\//, '');

  try {
    const output = execFileSync('find', [workdir, '-type', 'f', '-name', namePattern], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return output.trim();
  } catch {
    return '';
  }
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description: 'find files matching a glob pattern. Supports * and ** wildcards.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "*.log" or "**/*.ts"' },
      workdir: { type: 'string', description: 'Directory to search in (default: current working directory)' },
    },
    required: ['pattern'],
  },
  handler: async (params: Record<string, unknown>) => {
    const pattern = String(params.pattern ?? '*');
    const workdir = normalizePath(String(params.workdir ?? process.cwd()));

    try {
      const result = runGlob(pattern, workdir);
      return { content: result };
    } catch (e) {
      return {
        content: `glob error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
