// src/tools/context/manage-context.ts
import type { ContextManager } from '../../context/types';
import type { ToolDefinition } from '../types';

export function createManageContextTool(contextManager: ContextManager): ToolDefinition {
  return {
    name: 'manage_context',
    description:
      'Pin or unpin a message in context. Pinned messages are protected from compression. ' +
      'Use this after a previously failed tool succeeds — unpin the old error to free context space. ' +
      'Use this to protect important diagnostic output from being summarized.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pin', 'unpin'],
          description: 'pin = protect from compression; unpin = allow compression again',
        },
        tool_call_id: {
          type: 'string',
          description: 'The tool_call_id of the tool message to manage',
        },
      },
      required: ['action', 'tool_call_id'],
    },
    handler: async (params: Record<string, unknown>) => {
      const action = String(params.action ?? '');
      const toolCallId = String(params.tool_call_id ?? '');

      if (action !== 'pin' && action !== 'unpin') {
        return {
          content: `Unknown action: "${action}". Valid actions are: pin, unpin.`,
          summary: `manage_context: unknown action "${action}"`,
          exitCode: 1,
          isError: true,
        };
      }

      const idx = contextManager.findByToolCallId(toolCallId);

      if (idx === undefined) {
        return {
          content: `Error: no tool message found with tool_call_id "${toolCallId}".`,
          summary: `manage_context failed: tool_call_id "${toolCallId}" not found`,
          exitCode: 1,
          isError: true,
        };
      }

      if (action === 'pin') {
        contextManager.pin(idx);
        return {
          content: `Message with tool_call_id "${toolCallId}" is now pinned (protected from compression).`,
          summary: `pinned ${toolCallId}`,
          exitCode: 0,
        };
      } else {
        contextManager.unpin(idx);
        return {
          content: `Message with tool_call_id "${toolCallId}" is now unpinned (can be compressed).`,
          summary: `unpinned ${toolCallId}`,
          exitCode: 0,
        };
      }
    },
  };
}
