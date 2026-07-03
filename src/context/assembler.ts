// src/context/assembler.ts
import type { Message } from '../llm/types';

export interface AssembleInput {
    state: Record<string, unknown>;
    flow: Message[];
}

/**
 * Pure function: combines state and flow layers into a single Message[].
 * Layer 1 (state): if state has keys, inject as a system message.
 * Layer 2 (flow): user/assistant/tool messages directly.
 * Does NOT modify input. Does NOT enforce budget (that's compact's job).
 */
export function assembleLayers(input: AssembleInput): Message[] {
    const result: Message[] = [];

    // Layer 1: State
    if (Object.keys(input.state).length > 0) {
        result.push({ role: 'system', content: JSON.stringify(input.state) });
    }

    // Layer 2: Flow (shallow copy for safety)
    for (const msg of input.flow) {
        result.push({ ...msg });
    }

    return result;
}
