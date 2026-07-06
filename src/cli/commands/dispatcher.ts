// src/cli/commands/dispatcher.ts
import type { CommandRegistry } from './registry.js';
import type { CommandContext } from './types.js';

export type DispatchResult =
    | { action: 'send_to_agent'; input: string }
    | { action: 'exit' }
    | { action: 'continue' };

/**
 * Route user input: slash commands go to CommandRegistry, everything else
 * is passed through to the agent.
 *
 * @returns DispatchResult telling the caller what to do next.
 *          'send_to_agent' — pass input to agent.send()
 *          'exit'          — close the readline and exit
 *          'continue'      — command handled, re-prompt for next input
 */
export async function dispatch(
    input: string,
    registry: CommandRegistry,
    ctx: CommandContext,
): Promise<DispatchResult> {
    // Slash command path
    if (input.startsWith('/')) {
        const resolved = registry.resolve(input);

        if (resolved) {
            const result = await resolved.command.execute(ctx, input);

            if (result.type === 'exit') {
                return { action: 'exit' };
            }
            return { action: 'continue' };
        }

        // Unknown command
        ctx.output.error('Unknown command. Type /help for available commands.');
        return { action: 'continue' };
    }

    // Not a slash command — forward to agent
    return { action: 'send_to_agent', input };
}
