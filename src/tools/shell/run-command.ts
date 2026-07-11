// src/tools/shell/run-command.ts
import type { ToolDefinition } from '../types';
import { getTaskRegistry } from '../../tasks/registry';
import { getSandboxManager } from '../../sandbox/sandbox-manager';

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    'Execute a shell command. Commands run asynchronously in the background. ' +
    'Use lookup_task to check on progress and read output. ' +
    'Use list_tasks to see all running/completed tasks. ' +
    'Long-running commands (training, inference) are fully supported.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (default: current)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default: no timeout)' },
    },
    required: ['command'],
  },
  handler: async (params: Record<string, unknown>) => {
    const command = String(params.command ?? '');
    const workdir = typeof params.workdir === 'string' ? params.workdir : process.cwd();
    const timeoutSec = typeof params.timeout === 'number' ? params.timeout : undefined;
    const timeoutMs = timeoutSec !== undefined ? timeoutSec * 1000 : null;

    if (!command.trim()) {
      return {
        content: 'Error: command is empty',
        summary: 'exit=error | empty command',
        exitCode: 1,
        isError: true,
      };
    }

    const reg = getTaskRegistry();
    if (!reg) {
      return {
        content: 'Error: TaskRegistry is not initialized. Cannot execute commands.',
        summary: 'error: no task registry',
        exitCode: 1,
        isError: true,
      };
    }

    // Build sandbox-wrapped command (or fallback to raw command)
    const sandbox = getSandboxManager();
    let spawnCommand: string;
    let spawnWorkdir: string;

    try {
      if (sandbox) {
        const built = await sandbox.buildCommand(command, { workdir });
        spawnCommand = built.command;
        spawnWorkdir = built.workdir;
      } else {
        spawnCommand = command;
        spawnWorkdir = workdir;
      }
    } catch (err) {
      return {
        content: `Error building sandbox command: ${err instanceof Error ? err.message : String(err)}`,
        summary: 'sandbox: blocked',
        exitCode: 1,
        isError: true,
      };
    }

    const task = reg.spawn(spawnCommand, {
      workdir: spawnWorkdir,
      timeoutMs,
    });

    const content = [
      `Task started: ${task.id}`,
      `Status: ${task.status}`,
      `PID: ${task.pid}`,
      `Command: ${command}`,
      '',
      `Use lookup_task(task_id="${task.id}") to check progress.`,
      `Use list_tasks() to see all tasks.`,
    ].join('\n');

    return {
      content,
      summary: `${task.id}: spawned | pid=${task.pid}`,
      exitCode: 0,
      keyOutput: `task ${task.id} spawned`,
    };
  },
};
