import type { Command } from '../types.js';
import { llmCompact } from '../../../context/llm-compact.js';

export const compactCommand: Command = {
    name: 'compact',
    description: 'LLM-powered full context compression',
    async execute(ctx) {
        const messages = ctx.contextManager.assemble();

        // Estimate token count before compression (rough: using message count as proxy)
        const beforeCount = messages.length;

        // Only call LLM if there's actually content to compress
        let summary: string;
        if (messages.length === 0) {
            summary = 'No prior context.';
        } else {
            summary = await llmCompact(ctx.config, messages);
        }

        ctx.contextManager.llmCompact(summary);

        const afterCount = ctx.contextManager.assemble().length;
        ctx.output.info(`Context compacted. (${beforeCount} → ${afterCount} messages)`);

        return { type: 'handled' };
    },
};
