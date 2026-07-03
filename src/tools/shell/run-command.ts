// src/tools/shell/run-command.ts
import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types';

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    'Execute a Linux shell command. Safe read-only commands run automatically. ' +
    'Long-running commands (training, inference) should use background=true. ' +
    'Output is truncated after the timeout (default 60s).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (default: current)' },
      background: { type: 'boolean', description: 'Run as background job (default: false)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default: 60)' },
    },
    required: ['command'],
  },
  handler: async (params: Record<string, unknown>) => {
    const command = String(params.command ?? '');
    const workdir = typeof params.workdir === 'string' ? params.workdir : process.cwd();
    const timeoutMs = typeof params.timeout === 'number' ? params.timeout * 1000 : 60_000;

    if (!command.trim()) {
      return { content: 'Error: command is empty', isError: true };
    }

    try {
      const stdout = execSync(command, {
        cwd: workdir,
        timeout: timeoutMs,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
          ? (process.env.ComSpec || 'cmd.exe')
          : (process.env.SHELL || '/bin/sh'),
      });
      return { content: stdout.trim() ? stdout.trim() + '\nexit code: 0' : 'exit code: 0' };
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException & {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        status?: number;
        killed?: boolean;
      };

      if (err.killed) {
        const partial = (
          (typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString('utf-8') ?? '') +
          '\n' +
          (typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf-8') ?? '')
        ).trim();
        return {
          content: partial
            ? partial + '\n[TRUNCATED: command timed out]'
            : '[TRUNCATED: command timed out, no output captured]',
        };
      }

      const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString('utf-8') ?? '';
      const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf-8') ?? '';
      const out = [stdout, stderr].filter(Boolean).join('\n');
      return { content: (out || err.message) + `\nexit code: ${err.status ?? 1}` };
    }
  },
};
