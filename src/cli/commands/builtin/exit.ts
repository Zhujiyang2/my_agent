import type { Command } from '../types.js';

export const exitCommand: Command = {
    name: 'exit',
    description: 'Exit the program',
    async execute() {
        return { type: 'exit' };
    },
};
