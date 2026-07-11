// src/tools/shell/lookup-task.ts
import type { ToolDefinition } from '../types';
import { getTaskRegistry } from '../../tasks/registry';
import { filterProgressBars } from '../../tasks/types';

export const lookupTaskTool: ToolDefinition = {
  name: 'lookup_task',
  description:
    'Look up a background task by id. Returns current status, the last N lines of stdout/stderr, ' +
    'and the exit code if the task has finished. Use this to check on long-running commands.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task id to look up (e.g., job-1712345678-abc123)' },
      lines: { type: 'number', description: 'Number of tail lines to return (default: 50)' },
    },
    required: ['task_id'],
  },
  handler: async (params: Record<string, unknown>) => {
    const reg = getTaskRegistry();
    if (!reg) {
      return {
        content: 'TaskRegistry is not initialized',
        summary: 'error: no registry',
        exitCode: 1,
        isError: true,
      };
    }

    const taskId = String(params.task_id ?? '');
    const tailLines = typeof params.lines === 'number' ? params.lines : 50;
    const task = reg.get(taskId);

    if (!task) {
      return {
        content: `Task "${taskId}" not found. Use list_tasks to see all tasks.`,
        summary: `not found: ${taskId}`,
        exitCode: 1,
        isError: true,
      };
    }

    const [stdout, stderr] = await Promise.all([
      reg.readOutput(taskId, 'stdout', tailLines),
      reg.readOutput(taskId, 'stderr', tailLines),
    ]);

    const elapsed = ((task.finishedAt ?? Date.now()) - task.createdAt) / 1000;
    const filteredStdout = filterProgressBars(stdout);
    const filteredStderr = filterProgressBars(stderr);

    const parts: string[] = [
      `Task: ${task.id}`,
      `Status: ${task.status}`,
      `Command: ${task.command}`,
      `Elapsed: ${elapsed.toFixed(1)}s`,
      `Exit code: ${task.exitCode ?? 'N/A'}`,
      `Signal: ${task.signal ?? 'none'}`,
    ];

    if (filteredStdout) {
      parts.push(`\n--- stdout (last ${tailLines} lines) ---\n${filteredStdout}`);
    }
    if (filteredStderr) {
      parts.push(`\n--- stderr (last ${tailLines} lines) ---\n${filteredStderr}`);
    }

    const content = parts.join('\n');
    return {
      content,
      summary: `${task.id}: ${task.status} | exit=${task.exitCode ?? '?'} | ${elapsed.toFixed(0)}s`,
      exitCode: task.status === 'failed' ? 1 : 0,
      keyOutput: filteredStdout.slice(0, 300) || filteredStderr.slice(0, 300),
    };
  },
};
