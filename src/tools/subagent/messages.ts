// src/tools/subagent/messages.ts
import type { ToolDefinition } from '../types';
import { getSubagentManager } from '../../agent/subagent/manager';
import type { SubagentMessage } from '../../agent/subagent/types';

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── Main agent tools ──

export function createCheckMessagesTool(): ToolDefinition {
  return {
    name: 'check_subagent_messages',
    description:
      'Read messages sent by sub-agents to the main agent. ' +
      'Without arguments, returns all messages. ' +
      'Pass `since` (message ID) to get only newer messages — use the `latest_id` from the previous response to avoid re-processing.',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Optional. Return only messages after this ID.' },
      },
      required: [],
    },
    handler: async (params: Record<string, unknown>) => {
      const mgr = getSubagentManager();
      const since = typeof params.since === 'string' ? params.since : undefined;
      const result = mgr.getMainInboxSince(since);

      return {
        content: JSON.stringify({
          messages: result.messages,
          latest_id: result.latestId,
        }, null, 2),
        summary: `${result.messages.length} message(s) from subagents`,
        exitCode: 0,
      };
    },
  };
}

export function createSendToSubagentTool(): ToolDefinition {
  return {
    name: 'send_message_to_subagent',
    description: "Send a message from main agent to a sub-agent or broadcast to all ('all').",
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "Target sub-agent ID, or 'all'." },
        type: { type: 'string', enum: ['info', 'alert', 'request', 'response'], description: 'Message type.' },
        payload: { type: 'string', description: 'Message body.' },
      },
      required: ['to', 'type', 'payload'],
    },
    handler: async (params: Record<string, unknown>) => {
      const to = typeof params.to === 'string' ? params.to.trim() : '';
      if (!to) {
        return { content: 'Error: to is required.', summary: 'error: to required', exitCode: 1, isError: true };
      }

      const mgr = getSubagentManager();
      const msg: SubagentMessage = {
        id: generateMessageId(),
        from: 'main',
        to,
        type: (params.type as SubagentMessage['type']) ?? 'info',
        payload: String(params.payload ?? ''),
        timestamp: Date.now(),
      };
      mgr.routeMessage(msg);

      return {
        content: `Message sent to ${to}.`,
        summary: `sent ${msg.type} to ${to}`,
        exitCode: 0,
      };
    },
  };
}
