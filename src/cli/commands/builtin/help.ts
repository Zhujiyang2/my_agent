import type { Command } from '../types.js';
import type { CommandRegistry } from '../registry.js';

export function createHelpCommand(registry: CommandRegistry): Command {
    return {
        name: 'help',
        description: 'Show available commands or help for a specific command',
        usage: '/help [command]',
        async execute(ctx, rawInput) {
            const args = rawInput.trim().slice('/help'.length).trim();

            if (!args) {
                const commands = registry.getAll();
                const lines = ['Available commands:'];
                for (const cmd of commands) {
                    lines.push(`  /${cmd.name.padEnd(12)} ${cmd.description}`);
                }
                ctx.output.info(lines.join('\n'));
                return { type: 'handled' };
            }

            const command = registry.resolve(`/${args}`)?.command;
            if (!command) {
                ctx.output.error(`Unknown command: "${args}"`);
                return { type: 'handled' };
            }

            const lines = [
                `/${command.name} — ${command.description}`,
            ];
            if (command.usage) {
                lines.push(`  Usage: ${command.usage}`);
            }
            ctx.output.info(lines.join('\n'));
            return { type: 'handled' };
        },
    };
}
