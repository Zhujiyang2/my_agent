import type { Command } from '../types.js';

export const clearCommand: Command = {
    name: 'clear',
    description: 'Clear conversation history and start fresh',
    async execute(ctx) {
        ctx.agent.clearContext();
        ctx.output.info('Conversation cleared.');
        return { type: 'handled' };
    },
};
