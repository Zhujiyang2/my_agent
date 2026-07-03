// src/tools/subagent/list.ts
import type { ToolDefinition } from '../types';
import { getSubagentManager } from '../../agent/subagent/manager';

export function createListAgentsTool(): ToolDefinition {
  return {
    name: 'list_agents',
    description: 'List all sub-agents and their current status, including message counts.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const mgr = getSubagentManager();
      const list = mgr.list();
      // Convert to snake_case for LLM-friendly JSON output
      const formatted = list.map(e => ({
        id: e.id,
        status: e.status,
        task_summary: e.taskSummary,
        duration_ms: e.durationMs,
        tokens_used: e.tokensUsed,
        message_count: e.messageCount,
      }));
      return {
        content: JSON.stringify(formatted, null, 2),
        summary: `${formatted.length} subagent(s) | running=${formatted.filter(s => s.status === 'running').length} pending=${formatted.filter(s => s.status === 'pending').length} completed=${formatted.filter(s => s.status === 'completed').length}`,
        exitCode: 0,
      };
    },
  };
}
