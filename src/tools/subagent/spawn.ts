// src/tools/subagent/spawn.ts
import type { ToolDefinition } from '../types';
import { getSubagentManager } from '../../agent/subagent/manager';

export function createSpawnAgentTool(): ToolDefinition {
  return {
    name: 'spawn_agent',
    description:
      'Spawn an independent sub-agent to handle a task in the background. ' +
      'Returns immediately with a sub-agent ID. The sub-agent runs asynchronously — ' +
      'use list_agents to check status, get_agent_result to retrieve results, ' +
      'and check_subagent_messages to receive messages from sub-agents. ' +
      'Spawn multiple in one round for true parallel execution.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: "Task description — becomes the sub-agent's initial prompt." },
        tools: {
          type: 'array', items: { type: 'string' },
          description: "Tool list. Default: ['run_command','read_file','write_file','glob']. send_message is always included.",
        },
        model: { type: 'string', description: 'Model override.' },
        timeout_ms: { type: 'number', description: 'Hard timeout in ms. Default: 600000.' },
        node: { type: 'string', description: 'Optional SSH target (user@host).' },
        max_tokens: { type: 'number', description: 'Token budget.' },
      },
      required: ['task'],
    },
    handler: async (params: Record<string, unknown>) => {
      const task = typeof params.task === 'string' ? params.task.trim() : '';
      if (!task) {
        return {
          content: 'Error: task is required and must be a non-empty string.',
          summary: 'spawn_agent error: task required',
          exitCode: 1,
          isError: true,
        };
      }

      const mgr = getSubagentManager();
      const result = mgr.spawn({
        task,
        tools: Array.isArray(params.tools) ? params.tools as string[] : undefined,
        model: typeof params.model === 'string' ? params.model : undefined,
        timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined,
        node: typeof params.node === 'string' ? params.node : undefined,
        maxTokens: typeof params.max_tokens === 'number' ? params.max_tokens : undefined,
      });

      return {
        content: JSON.stringify({
          id: result.id,
          status: result.status,
          task,
          message: result.status === 'pending'
            ? 'Sub-agent queued. Monitor with list_agents, retrieve results with get_agent_result.'
            : 'Sub-agent spawned and running. Monitor with list_agents, retrieve results with get_agent_result.',
        }, null, 2),
        summary: `subagent ${result.status}: ${task.slice(0, 80)}`,
        exitCode: 0,
      };
    },
  };
}
