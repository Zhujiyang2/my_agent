import type { Message } from '../llm/types';
import type { ContextConfig } from '../config/types';

export type { ContextConfig };

export interface ContextManager {
    /** Add a message to the flow layer. */
    append(message: Message): void;

    /**
     * Queue a message for deferred insertion. Messages added via this method
     * are held in a separate queue and only appended to the flow when
     * {@link flushDeferred} is called.
     *
     * Use this for background task completion notifications that may fire
     * while we are in the middle of processing tool calls — it prevents
     * user/assistant messages from being injected between an assistant
     * message's tool_calls and their corresponding tool responses, which
     * would violate the OpenAI/DeepSeek API requirement.
     */
    appendDeferred(message: Message): void;

    /**
     * Flush all deferred messages into the main flow. After this call, the
     * deferred queue is empty and all previously deferred messages are part
     * of the flow visible to {@link assemble}.
     */
    flushDeferred(): void;

    /** Pure read: assemble the final messages for the next LLM call. No side effects. */
    assemble(): Message[];

    /** Explicit compaction: apply age-based summarization, dedup, and budget enforcement. */
    compact(): void;

    /** Replace flow with an LLM-generated compressed summary (used by /compact). */
    llmCompact(summary: string): void;

    /** Pin message at flow index — it will never be compacted. */
    pin(index: number): void;

    /** Unpin a previously pinned message. */
    unpin(index: number): void;

    /** Find the flow index of a tool message by its tool_call_id. Returns undefined if not found. */
    findByToolCallId(toolCallId: string): number | undefined;

    /** Update a key in the state layer. */
    setState(key: string, value: unknown): void;

    /** Get the current state layer object (shallow copy). */
    getState(): Record<string, unknown>;

    /** Remove all messages after the first `count` messages (for error rollback). */
    truncateTo(count: number): void;

    /** Reset flow, state, round counter, and cancelled flag. Memory layer is preserved. */
    clear(): void;

    /** Read-only view of flow entries. */
    getFlowEntries(): ReadonlyArray<{
        message: Message;
        round: number;
        pinned: boolean;
    }>;

    /** Cancel pending work (for Ctrl+C). */
    cancelAll(): void;
}
