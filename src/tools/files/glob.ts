// src/tools/files/glob.ts
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../types';
import { normalizePath } from '../path-utils';

/**
 * Simple glob matching: converts a glob pattern to a regex.
 * Supports * (any chars except separator) and ** (any chars including separator).
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '^';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // ** matches anything including path separators
      regexStr += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      // * matches anything except path separators
      regexStr += '[^/\\\\]*';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(pattern[i])) {
      regexStr += '\\' + pattern[i];
      i += 1;
    } else {
      regexStr += pattern[i];
      i += 1;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

function collectFiles(dir: string, regex: RegExp, results: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      collectFiles(fullPath, regex, results);
    } else if (entry.isFile() && regex.test(entry.name)) {
      results.push(fullPath);
    }
  }
}

function runGlob(pattern: string, workdir: string): string {
  const s = statSync(workdir);
  if (!s.isDirectory()) return '';

  // If pattern starts with **/, search recursively with the rest as filename pattern
  const isRecursive = pattern.startsWith('**/');
  const namePattern = isRecursive ? pattern.slice(3) : pattern;
  const regex = globToRegex(namePattern);

  const results: string[] = [];

  if (isRecursive) {
    collectFiles(workdir, regex, results);
  } else {
    let entries;
    try {
      entries = readdirSync(workdir, { withFileTypes: true });
    } catch {
      return '';
    }
    for (const entry of entries) {
      if (entry.isFile() && regex.test(entry.name)) {
        results.push(join(workdir, entry.name));
      }
    }
  }

  return results.join('\n');
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
