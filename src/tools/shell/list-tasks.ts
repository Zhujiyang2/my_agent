// src/tools/shell/list-tasks.ts
import type { ToolDefinition } from '../types';
import { getTaskRegistry } from '../../tasks/registry';
import type { TaskStatus } from '../../tasks/types';

export const listTasksTool: ToolDefinition = {
  name: 'list_tasks',
  description:
    'List background tasks managed by the agent. ' +
    'Use status filter to find running/completed/failed tasks. ' +
    'Returns task id, command, status, and runtime for each task.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Filter by status: running, completed, failed, timeout, killed, lost',
      },
    },
    required: [],
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

    const status = typeof params.status === 'string' ? (params.status as TaskStatus) : undefined;
    const tasks = reg.list(status ? { status } : undefined);

    if (tasks.length === 0) {
      return {
        content: 'No tasks found.',
        summary: '0 tasks',
        exitCode: 0,
      };
    }

    const lines = tasks.map((t) => {
      const elapsed = ((t.finishedAt ?? Date.now()) - t.createdAt) / 1000;
      return [
        `[${t.id}]`,
        `status=${t.status}`,
        `elapsed=${elapsed.toFixed(1)}s`,
        `exitCode=${t.exitCode ?? 'N/A'}`,
        `cmd: ${t.command.slice(0, 120)}`,
      ].join(' ');
    });

    const content = `Tasks (${tasks.length}):\n${lines.join('\n')}`;
    return {
      content,
      summary: `${tasks.length} task(s)`,
      exitCode: 0,
      keyOutput: lines.slice(0, 5).join('\n'),
    };
  },
};
