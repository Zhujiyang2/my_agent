// src/tools/subagent/kill.ts
import type { ToolDefinition } from '../types';
import { getSubagentManager } from '../../agent/subagent/manager';

export function createKillAgentTool(): ToolDefinition {
  return {
    name: 'kill_agent',
    description: 'Cancel a running or pending sub-agent by ID.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Sub-agent ID.' } },
      required: ['id'],
    },
    handler: async (params: Record<string, unknown>) => {
      const id = typeof params.id === 'string' ? params.id.trim() : '';
      if (!id) {
        return {
          content: 'Error: id is required.',
          summary: 'kill_agent error: id required',
          exitCode: 1, isError: true,
        };
      }
      const mgr = getSubagentManager();
      const killed = mgr.kill(id);
      if (!killed) {
        return {
          content: `Error: sub-agent "${id}" not found or already in terminal state. Use list_agents to check.`,
          summary: `kill_agent: "${id}" not found`,
          exitCode: 1, isError: true,
        };
      }
      return {
        content: `Sub-agent "${id}" has been cancelled.`,
        summary: `kill_agent: "${id}" cancelled`,
        exitCode: 0,
      };
    },
  };
}

export function createGetAgentResultTool(): ToolDefinition {
  return {
    name: 'get_agent_result',
    description: "Get result of a completed sub-agent. 'summary' for overview, 'full' for complete transcript.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sub-agent ID.' },
        detail: { type: 'string', enum: ['summary', 'full'], description: "Detail level." },
      },
      required: ['id'],
    },
    handler: async (params: Record<string, unknown>) => {
      const id = typeof params.id === 'string' ? params.id.trim() : '';
      if (!id) {
        return { content: 'Error: id is required.', summary: 'error: id required', exitCode: 1, isError: true };
      }
      const mgr = getSubagentManager();

      if (params.detail === 'full') {
        const transcript = mgr.transcript(id);
        if (!transcript) {
          return {
            content: `Error: sub-agent "${id}" not found or not yet completed.`,
            summary: `get_agent_result: "${id}" not found`,
            exitCode: 1, isError: true,
          };
        }
        return {
          content: JSON.stringify({ id, detail: 'full', transcript }, null, 2),
          summary: `full transcript for "${id}" (${transcript.length} messages)`,
          exitCode: 0,
        };
      }

      const result = mgr.result(id);
      if (!result) {
        return {
          content: `Error: sub-agent "${id}" not found or not yet completed. Use list_agents to check.`,
          summary: `get_agent_result: "${id}" not found`,
          exitCode: 1, isError: true,
        };
      }
      return {
        content: JSON.stringify({
          id, detail: 'summary',
          status: result.status,
          llm_summary: result.llmSummary,
          evidence: result.evidence,
          key_outputs: result.keyOutputs,
          metrics: result.metrics,
        }, null, 2),
        summary: `result for "${id}": ${result.status}`,
        exitCode: result.exitCode,
      };
    },
  };
}
