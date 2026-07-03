// src/agent/loop.ts
import type { Config } from '../config/types';
import type { Message } from '../llm/types';
import { chatStream } from '../llm/client';
import { isHighRisk, getExecutorCallbacks } from '../tools/executor';
import type { ToolRegistry } from '../tools/registry';
import { defaultRegistry } from '../tools/registry';

export interface AgentOptions {
  onToken?: (token: string) => void;
  registry?: ToolRegistry;
}

export interface AgentSession {
  send(input: string, signal?: AbortSignal): Promise<string>;
  readonly history: ReadonlyArray<Message>;
}

function toolsToOpenAI(
  tools: Array<{ name: string; description: string; parameters: unknown }>,
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function createAgent(config: Config, options: AgentOptions = {}): AgentSession {
  const history: Message[] = [];
  const registry = options.registry ?? defaultRegistry;

  async function send(input: string, signal?: AbortSignal): Promise<string> {
    const snapshotLength = history.length;
    history.push({ role: 'user', content: input });

    const maxRounds = config.tools.max_loop_rounds;
    const allTools = registry.getAll();
    const toolDefs = allTools.length > 0 ? toolsToOpenAI(allTools) : undefined;

    try {
      for (let round = 0; round < maxRounds; round++) {
        const result = await chatStream(
        config,
        history,
        toolDefs,
        (token) => options.onToken?.(token),
        signal,
      );

      if (result.toolCalls.length === 0) {
        history.push({ role: 'assistant', content: result.content });
        return result.content;
      }

      // Record assistant message with tool calls
      history.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls,
      });

      // Execute each tool call
      for (const tc of result.toolCalls) {
        const tool = registry.get(tc.function.name);
        let toolResult;

        if (!tool) {
          toolResult = {
            content: `Error: unknown tool "${tc.function.name}"`,
            isError: true,
          };
        } else {
          try {
            const args = JSON.parse(tc.function.arguments || '{}');

            // High-risk safety check for run_command
            if (
              tc.function.name === 'run_command' &&
              typeof args.command === 'string' &&
              isHighRisk(args.command) &&
              config.tools.safety_mode === 'confirm'
            ) {
              const cbs = getExecutorCallbacks();
              if (cbs.onConfirm) {
                const approved = await cbs.onConfirm(args.command, 'high_risk');
                if (!approved) {
                  toolResult = { content: 'Command was rejected by user.' };
                  history.push({
                    role: 'tool',
                    content: toolResult.content,
                    tool_call_id: tc.id,
                    name: tc.function.name,
                  });
                  continue;
                }
              }
            }

            toolResult = await tool.handler(args);
          } catch (e) {
            toolResult = {
              content: `Error executing tool: ${e instanceof Error ? e.message : String(e)}`,
              isError: true,
            };
          }
        }

        history.push({
          role: 'tool',
          content: toolResult.content,
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }
      }

      throw new Error(`Exceeded maximum tool calling rounds (${maxRounds})`);
    } catch (e) {
      // Rollback — keep history unchanged on failure
      history.length = snapshotLength;
      throw e;
    }
  }

  return {
    send,
    get history() {
      return [...history];
    },
  };
}
