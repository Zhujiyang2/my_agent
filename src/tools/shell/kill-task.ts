// src/tools/shell/kill-task.ts
import type { ToolDefinition } from '../types';
import { getTaskRegistry } from '../../tasks/registry';

export const killTaskTool: ToolDefinition = {
  name: 'kill_task',
  description:
    'Kill a running background task. Sends SIGTERM first, escalates to SIGKILL after 5 seconds. ' +
    'Only works on tasks with status "running".',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task id to kill (e.g., job-1712345678-abc123)' },
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
    const task = reg.get(taskId);

    if (!task) {
      return {
        content: `Task "${taskId}" not found.`,
        summary: `not found: ${taskId}`,
        exitCode: 1,
        isError: true,
      };
    }

    if (task.status !== 'running') {
      return {
        content: `Task "${taskId}" is not running (status: ${task.status}). Only running tasks can be killed.`,
        summary: `${taskId}: not running`,
        exitCode: 1,
        isError: true,
      };
    }

    const killed = reg.kill(taskId);
    if (killed) {
      return {
        content: `Task "${taskId}" killed successfully (SIGTERM sent, SIGKILL will follow in 5s if process does not exit).`,
        summary: `${taskId}: killed`,
        exitCode: 0,
      };
    }

    return {
      content: `Failed to kill task "${taskId}". The process may have already exited.`,
      summary: `${taskId}: kill failed`,
      exitCode: 1,
      isError: true,
    };
  },
};
