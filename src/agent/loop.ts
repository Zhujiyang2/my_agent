// src/agent/loop.ts
import type { Config } from '../config/types';
import type { Message } from '../llm/types';
import { chatStream } from '../llm/client';
import { isHighRisk, getExecutorCallbacks } from '../tools/executor';
import type { ToolRegistry } from '../tools/registry';
import { defaultRegistry } from '../tools/registry';
import { createContextManager } from '../context/manager';
import type { ContextManager } from '../context/types';
import { createManageContextTool } from '../tools/context/manage-context';

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
        config.model,
    );

    // Register manage_context tool if not already present (e.g., shared defaultRegistry)
    if (!registry.get('manage_context')) {
        registry.register(createManageContextTool(contextManager));
    }

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
                const currentMessages = contextManager.assemble();

                const result = await chatStream(
                    config,
                    currentMessages,
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
                            summary: `unknown tool: ${tc.function.name}`,
                            exitCode: 1,
                            isError: true,
                        };
                    } else {
                        try {
                            const args = JSON.parse(tc.function.arguments || '{}');
                            options.onToolCall?.(tc.function.name, args);

                            // High-risk safety check
                            if (
                                tc.function.name === 'run_command' &&
                                typeof args.command === 'string' &&
                                isHighRisk(args.command)
                            ) {
                                const cbs = getExecutorCallbacks();
                                if (!cbs.onConfirm) {
                                    toolResult = {
                                        content: 'Error: high-risk command blocked — no confirmation handler registered.',
                                        summary: 'blocked: high-risk, no confirm handler',
                                        exitCode: undefined,
                                    };
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
                                    toolResult = {
                                        content: 'Command was rejected by user.',
                                        summary: 'rejected: user denied high-risk command',
                                        exitCode: undefined,
                                    };
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
                                summary: `tool error: ${e instanceof Error ? e.message : String(e)}`,
                                exitCode: 1,
                                isError: true,
                            };
                        }
                    }

                    // Append tool result with structured fields for compact
                    const toolMsg: Message & { summary?: string; exitCode?: number; keyOutput?: string } = {
                        role: 'tool',
                        content: toolResult.content,
                        tool_call_id: tc.id,
                        name: tc.function.name,
                    };
                    if ('summary' in toolResult) toolMsg.summary = toolResult.summary;
                    if ('exitCode' in toolResult) toolMsg.exitCode = toolResult.exitCode;
                    if ('keyOutput' in toolResult) toolMsg.keyOutput = toolResult.keyOutput;

                    contextManager.append(toolMsg as Message);

                    // Auto-pin error results
                    if (toolResult.isError) {
                        const flowIdx = contextManager.assemble().length - 1;
                        contextManager.pin(flowIdx);
                    }

                    // Track consecutive failures
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

                // Compact after each round of tool calls
                contextManager.compact();
            }

            const lastTool = lastResult?.toolCalls[lastResult.toolCalls.length - 1];
            throw new Error(
                `Exceeded maximum tool calling rounds (${maxRounds}), ` +
                `last tool: ${lastTool?.function.name ?? 'unknown'}`,
            );
        } catch (e) {
            const isLimitError =
                e instanceof Error &&
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
