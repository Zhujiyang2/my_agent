// src/context/manager.ts
import type { ContextManager, ContextConfig } from './types';
import type { Message } from '../llm/types';
import type { MemoryManager } from '../memory/index';
import { estimateTokens } from './token-counter';

interface FlowEntry {
    message: Message;
    round: number;
    pinned: boolean;
}

export class BudgetError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = 'BudgetError';
    }
}

export function createContextManager(config: ContextConfig, model = 'gpt-4o', memoryManager?: MemoryManager): ContextManager {
    const flow: FlowEntry[] = [];
    const state: Record<string, unknown> = {};
    let currentRound = 0;
    let cancelled = false;

    const maxTokens = config.max_context_tokens > 0
        ? config.max_context_tokens
        : 102400;

    function append(message: Message): void {
        if (message.role === 'user') {
            currentRound++;
        }
        flow.push({ message: { ...message }, round: currentRound, pinned: false });
    }

    function assemble(): Message[] {
        const result: Message[] = [];

        // Layer 0: Memory
        const memSystemMsg = memoryManager?.assemble();
        if (memSystemMsg) {
            result.push({ role: 'system', content: memSystemMsg });
        }

        // Layer 1: State
        if (Object.keys(state).length > 0) {
            result.push({ role: 'system', content: JSON.stringify(state) });
        }

        // Layer 2: Flow
        for (const entry of flow) {
            result.push({ ...entry.message });
        }

        return result;
    }

    function compact(): void {
        if (cancelled) return;

        // Phase 1: Age-based summarization — switch old tool messages to summary
        for (const entry of flow) {
            if (entry.pinned) continue;
            if (entry.message.role !== 'tool') continue;
            if (currentRound - entry.round < config.recent_rounds) continue;

            const msgAny = entry.message as unknown as Record<string, unknown>;
            const summary = msgAny.summary as string | undefined;
            const keyOutput = msgAny.keyOutput as string | undefined;
            if (summary) {
                if (entry.message.content) {
                    msgAny._originalContent = entry.message.content;
                }
                entry.message.content = summary + (keyOutput ? ` | ${keyOutput.slice(0, 200)}` : '');
            }
        }

        // Phase 2: Dedup — merge tool messages with identical summaries
        // Walk forward, collecting tool messages; when one matches the last seen
        // summary, drop the earlier one and insert a merge note.
        let lastToolSummary: string | undefined;
        let lastToolIdx = -1;

        for (let i = 0; i < flow.length; i++) {
            if (flow[i].pinned || flow[i].message.role !== 'tool') continue;

            const summary = (flow[i].message as unknown as Record<string, unknown>).summary as string | undefined;
            if (!summary) {
                lastToolSummary = undefined;
                lastToolIdx = -1;
                continue;
            }

            if (lastToolSummary !== undefined && summary === lastToolSummary) {
                // Found duplicate — summarise the earlier one in-place instead of
                // removing it, so that any assistant message referencing its
                // tool_call_id still has a matching tool response. The OpenAI API
                // requires every assistant tool_calls to be followed by tool
                // messages for each tool_call_id.

                // Keep the earlier entry but replace content with merge note.
                // Preserves tool_call_id, name, and other required fields.
                const earlierEntry = flow[lastToolIdx];
                const earlierMsg = earlierEntry.message as unknown as Record<string, unknown>;
                earlierMsg.content = `[merged] ${earlierMsg.content}`;
                // Ensure the earlier entry is no longer treated as a distinct match
                (earlierEntry.message as unknown as Record<string, unknown>).summary = undefined;

                // Update tracking to point at the current (kept) tool
                lastToolSummary = summary;
                lastToolIdx = i;
            } else {
                lastToolSummary = summary;
                lastToolIdx = i;
            }
        }

        // Phase 3: Budget enforcement
        let currentTokens = estimateTokens(assemble(), model);
        while (currentTokens > maxTokens) {
            // Find oldest unpinned tool message
            let removed = false;
            for (let k = 0; k < flow.length; k++) {
                if (flow[k].pinned) continue;
                if (flow[k].message.role === 'tool') {
                    flow.splice(k, 1);
                    removed = true;
                    break;
                }
            }

            if (!removed) {
                throw new BudgetError(
                    `BudgetError: Context budget exceeded (${currentTokens} > ${maxTokens}) with no removable tool messages. ` +
                    `Try increasing max_context_tokens or reducing recent_rounds.`,
                );
            }

            currentTokens = estimateTokens(assemble(), model);
        }
    }

    function pin(index: number): void {
        if (index >= 0 && index < flow.length) {
            flow[index].pinned = true;
        }
    }

    function unpin(index: number): void {
        if (index >= 0 && index < flow.length) {
            flow[index].pinned = false;
        }
    }

    function findByToolCallId(toolCallId: string): number | undefined {
        for (let i = flow.length - 1; i >= 0; i--) {
            const msg = flow[i].message;
            if (msg.role !== 'tool') continue;
            if (msg.tool_call_id === toolCallId) return i;
        }
        return undefined;
    }

    function setState(key: string, value: unknown): void {
        state[key] = value;
    }

    function getState(): Record<string, unknown> {
        return { ...state };
    }

    function truncateTo(count: number): void {
        if (count < flow.length) {
            flow.length = count;
        }
    }

    function cancelAll(): void {
        cancelled = true;
    }

    return {
        append,
        assemble,
        compact,
        pin,
        unpin,
        findByToolCallId,
        setState,
        getState,
        truncateTo,
        cancelAll,
    };
}
