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

        // Layer -1: System identity (from config, survives /clear)
        if (config.systemPrompt) {
            result.push({ role: 'system', content: config.systemPrompt });
        }

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
        // The OpenAI API requires every assistant message with tool_calls to have
        // a matching tool response for each tool_call_id. We must never leave an
        // assistant with tool_calls without its matching tool responses.
        let currentTokens = estimateTokens(assemble(), model);
        while (currentTokens > maxTokens) {
            let removed = false;

            // Strategy 1: Remove an (assistant + its tool responses) group together.
            for (let k = 0; k < flow.length; k++) {
                if (flow[k].pinned) continue;
                const msg = flow[k].message as Record<string, unknown>;
                if (msg.role !== 'assistant') continue;
                const tcs = msg.tool_calls as Array<{ id: string }> | undefined;
                if (!tcs || tcs.length === 0) continue;

                const tcIds = new Set(tcs.map(tc => tc.id));
                let allUnpinned = true;
                let groupEnd = k;
                for (let j = k + 1; j < flow.length && tcIds.size > 0; j++) {
                    if (flow[j].pinned) { allUnpinned = false; break; }
                    const tm = flow[j].message as Record<string, unknown>;
                    if (tm.role === 'tool' && typeof tm.tool_call_id === 'string' && tcIds.has(tm.tool_call_id)) {
                        tcIds.delete(tm.tool_call_id);
                    }
                    groupEnd = j;
                }

                // Case A: all tool responses found and nothing pinned → evict entire group
                if (tcIds.size === 0 && allUnpinned) {
                    flow.splice(k, groupEnd - k + 1);
                    removed = true;
                    break;
                }

                // Case B: some tool responses are missing (already deleted by prior
                // compaction). Remove the orphaned assistant to prevent HTTP 400 errors.
                if (tcIds.size > 0 && !allUnpinned) {
                    // A pinned entry prevents group removal — skip.
                } else if (tcIds.size > 0) {
                    // Tool responses missing — delete the assistant (content loss is
                    // acceptable vs. API rejection). Also delete any remaining tool
                    // responses that were found.
                    flow.splice(k, groupEnd - k + 1);
                    removed = true;
                    break;
                }
            }

            // Strategy 2: Remove orphaned tool messages (no parent assistant).
            if (!removed) {
                const referencedIds = new Set<string>();
                for (const entry of flow) {
                    const m = entry.message as Record<string, unknown>;
                    if (m.role === 'assistant') {
                        const tcs = m.tool_calls as Array<{ id: string }> | undefined;
                        if (tcs) tcs.forEach(tc => referencedIds.add(tc.id));
                    }
                }

                for (let k = 0; k < flow.length; k++) {
                    if (flow[k].pinned) continue;
                    const tm = flow[k].message as Record<string, unknown>;
                    if (tm.role !== 'tool') continue;
                    const tcId = tm.tool_call_id as string | undefined;
                    if (!tcId || !referencedIds.has(tcId)) {
                        flow.splice(k, 1);
                        removed = true;
                        break;
                    }
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

    function clear(): void {
        flow.length = 0;
        for (const key of Object.keys(state)) {
            delete state[key];
        }
        currentRound = 0;
        cancelled = false;
    }

    function getFlowEntries(): ReadonlyArray<{
        message: Message;
        round: number;
        pinned: boolean;
    }> {
        return [...flow];
    }

    function cancelAll(): void {
        cancelled = true;
    }

    function llmCompact(summary: string): void {
        // Replace entire flow with a single system message containing the compressed summary
        flow.length = 0;
        flow.push({
            message: { role: 'system', content: `[Compressed context]\n\n${summary}` },
            round: 0,
            pinned: false,
        });
    }

    return {
        append,
        assemble,
        compact,
        llmCompact,
        pin,
        unpin,
        findByToolCallId,
        setState,
        getState,
        truncateTo,
        clear,
        getFlowEntries,
        cancelAll,
    };
}
