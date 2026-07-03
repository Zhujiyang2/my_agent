// src/agent/loop.ts
import type { Config } from '../config/types';
import type { Message } from '../llm/types';
import { chatStream } from '../llm/client';
import { isHighRisk, getExecutorCallbacks } from '../tools/executor';
import type { ToolRegistry } from '../tools/registry';
import { defaultRegistry } from '../tools/registry';
import { createContextManager } from '../context/manager';
import { createSummarizer } from '../context/summarizer';
import type { ContextManager } from '../context/types';

export interface AgentOptions {
  onToken?: (token: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  registry?: ToolRegistry;
  contextManager?: ContextManager;
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
  const registry = options.registry ?? defaultRegistry;

  const contextManager: ContextManager = options.contextManager ?? createContextManager(
    config.context,
    createSummarizer(config.context, {
      api_url: config.api_url,
      api_key: config.api_key,
      model: config.model,
    }),
  );

  async function send(input: string, signal?: AbortSignal): Promise<string> {
    const snapshotLength = contextManager.assemble().length;
    contextManager.append({ role: 'user', content: input });

    const maxRounds = config.tools.max_loop_rounds;
    const maxConsecutiveFailures = config.tools.max_consecutive_failures;
    const allTools = registry.getAll();
    const toolDefs = allTools.length > 0 ? toolsToOpenAI(allTools) : undefined;

    let lastResult: { toolCalls: Array<{ function: { name: string } }> } | undefined;
    let consecutiveFailures = 0;

    try {
      for (let round = 0; round < maxRounds; round++) {
        const result = await chatStream(
          config,
          contextManager.assemble(),
          toolDefs,
          (token) => options.onToken?.(token),
          signal,
        );
        lastResult = result;

        if (result.toolCalls.length === 0) {
          contextManager.append({ role: 'assistant', content: result.content });
          return result.content;
        }

        // Record assistant message with tool calls
        contextManager.append({
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
              options.onToolCall?.(tc.function.name, args);

              // High-risk safety check for run_command — always enforced
              if (
                tc.function.name === 'run_command' &&
                typeof args.command === 'string' &&
                isHighRisk(args.command)
              ) {
                const cbs = getExecutorCallbacks();
                if (!cbs.onConfirm) {
                  toolResult = { content: 'Error: high-risk command blocked — no confirmation handler registered.' };
                  contextManager.append({
                    role: 'tool',
                    content: toolResult.content,
                    tool_call_id: tc.id,
                    name: tc.function.name,
                  });
                  continue;
                }
                const approved = await cbs.onConfirm(args.command, 'high_risk');
                if (!approved) {
                  toolResult = { content: 'Command was rejected by user.' };
                  contextManager.append({
                    role: 'tool',
                    content: toolResult.content,
                    tool_call_id: tc.id,
                    name: tc.function.name,
                  });
                  continue;
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

          contextManager.append({
            role: 'tool',
            content: toolResult.content,
            tool_call_id: tc.id,
            name: tc.function.name,
          });

          contextManager.scheduleSummarize(tc.id, tc.function.name, toolResult);

          // Track consecutive failures to detect when agent is stuck
          if (toolResult.isError) {
            consecutiveFailures++;
            if (consecutiveFailures >= maxConsecutiveFailures) {
              throw new Error(
                `Stopped: ${consecutiveFailures} consecutive tool failures, ` +
                `last tool: ${tc.function.name}`,
              );
            }
          } else {
            consecutiveFailures = 0;
          }
        }
      }

      const lastTool = lastResult?.toolCalls[lastResult.toolCalls.length - 1];
      throw new Error(
        `Exceeded maximum tool calling rounds (${maxRounds}), ` +
        `last tool: ${lastTool?.function.name ?? 'unknown'}`,
      );
    } catch (e) {
      // Preserve history for limit errors (rounds/failures) — work was valid, just incomplete.
      // Rollback only for unexpected errors (network, API, etc.)
      const isLimitError = e instanceof Error &&
        (e.message.startsWith('Exceeded maximum') || e.message.startsWith('Stopped:'));
      if (!isLimitError) {
        contextManager.truncateTo(snapshotLength);
      }
      throw e;
    }
  }

  return {
    send,
    get history() {
      return [...contextManager.assemble()];
    },
  };
}
