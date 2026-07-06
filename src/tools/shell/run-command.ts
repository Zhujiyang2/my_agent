// src/tools/shell/run-command.ts
import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types';
import { getSandboxManager } from '../../sandbox/sandbox-manager';
import type { ToolResult } from '../types';

async function executeViaSandbox(
  command: string,
  workdir: string,
  timeoutMs: number
): Promise<ToolResult> {
  const mgr = getSandboxManager();
  if (mgr) {
    return mgr.execute(command, { workdir, timeout: timeoutMs });
  }

  // No sandbox manager — execute directly (legacy path)
  return executeDirectly(command, workdir, timeoutMs);
}

function executeDirectly(
  command: string,
  workdir: string,
  timeoutMs: number
): ToolResult {
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
    const stdoutTrimmed = stdout.trim();
    const stdoutStr = stdoutTrimmed ? stdoutTrimmed + '\nexit code: 0' : 'exit code: 0';
    return {
      content: stdoutStr,
      summary: `exit=0 | ${stdoutTrimmed.slice(0, 80)}`,
      exitCode: 0,
      keyOutput: stdoutTrimmed.slice(0, 300),
    };
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
        summary: 'exit=timeout | command timed out',
        exitCode: undefined,
        keyOutput: partial?.slice(0, 300),
        isError: true,
      };
    }

    const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString('utf-8') ?? '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf-8') ?? '';
    const out = [stdout, stderr].filter(Boolean).join('\n');
    const code = err.status ?? 1;
    const fullContent = (out || err.message) + `\nexit code: ${code}`;
    return {
      content: fullContent,
      summary: `exit=${code} | ${(out || err.message).slice(0, 80)}`,
      exitCode: code,
      keyOutput: out.slice(0, 300),
      isError: true,
    };
  }
}

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
      return {
        content: 'Error: command is empty',
        summary: 'exit=error | empty command',
        exitCode: 1,
        isError: true,
      };
    }

    return executeViaSandbox(command, workdir, timeoutMs);
  },
};
