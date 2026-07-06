// src/context/llm-compact.ts
import { chat } from '../llm/client';
import type { Config } from '../config/types';
import type { Message } from '../llm/types';

const COMPACT_SYSTEM_PROMPT = `You are a context compression assistant. Your job is to compress a conversation history into a concise but lossless summary.

Rules:
1. Preserve ALL key decisions, code changes, file paths modified, and important findings
2. Preserve the current task/goal the user is working on
3. Preserve error messages and their resolutions
4. Drop redundant tool output — keep only the essential results
5. Output format: a narrative summary in plain text, no markdown headers

The compressed output will replace the entire conversation history, so nothing important should be lost.`;

/**
 * Use an LLM to compress a full conversation into a condensed summary.
 *
 * @param config - Agent config (model, api_url, api_key)
 * @param messages - The full assembled conversation to compress
 * @returns The compressed summary string
 */
export async function llmCompact(config: Config, messages: Message[]): Promise<string> {
    // Serialize messages into a single user message for the compression request
    const conversationText = messages
        .map((m) => {
            const role = m.role;
            // For tool messages, include name for context
            if (role === 'tool' && m.name) {
                return `[${role}:${m.name}]: ${m.content ?? '(empty)'}`;
            }
            // Truncate very long content for the compression prompt itself
            const content = m.content ?? '(empty)';
            const truncated = content.length > 4000 ? content.slice(0, 4000) + '...[truncated]' : content;
            return `[${role}]: ${truncated}`;
        })
        .join('\n\n');

    const compactMessages: Message[] = [
        { role: 'system', content: COMPACT_SYSTEM_PROMPT },
        { role: 'user', content: `Compress the following conversation:\n\n${conversationText}` },
    ];

    return chat(config, compactMessages);
}
