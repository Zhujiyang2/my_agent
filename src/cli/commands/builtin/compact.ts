import type { Command } from '../types.js';

export const compactCommand: Command = {
    name: 'compact',
    description: 'Manually trigger context compaction',
    async execute(ctx) {
        ctx.contextManager.compact();
        ctx.output.info('Context compacted.');
        return { type: 'handled' };
    },
};
