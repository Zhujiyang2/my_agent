// src/tools/shell/cleanup-tasks.ts
import type { ToolDefinition } from '../types';
import { getTaskRegistry } from '../../tasks/registry';

export const cleanupTasksTool: ToolDefinition = {
  name: 'cleanup_tasks',
  description:
    'Delete completed/failed/killed task files (stdout, stderr, exit info) older than N days. ' +
    'Frees disk space. Default: 7 days. Use older_than_days=0 to delete all finished tasks.',
  parameters: {
    type: 'object',
    properties: {
      older_than_days: {
        type: 'number',
        description: 'Delete tasks finished more than N days ago (default: 7, use 0 for all finished)',
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

    const olderThanDays = typeof params.older_than_days === 'number' ? params.older_than_days : 7;
    const result = reg.cleanup({ olderThanDays });

    const mb = (result.freedBytes / (1024 * 1024)).toFixed(2);
    return {
      content: `Cleaned up ${result.deleted} task(s), freed ${mb} MB.`,
      summary: `deleted=${result.deleted} | freed=${mb} MB`,
      exitCode: 0,
      keyOutput: `Cleaned up ${result.deleted} task(s)`,
    };
  },
};
