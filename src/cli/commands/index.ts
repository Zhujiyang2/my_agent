// src/cli/commands/index.ts
import { CommandRegistry } from './registry.js';
import { exitCommand } from './builtin/exit.js';
import { clearCommand } from './builtin/clear.js';
import { compactCommand } from './builtin/compact.js';
import { rewindCommand } from './builtin/rewind.js';
import { createHelpCommand } from './builtin/help.js';

export function createCommandRegistry(): CommandRegistry {
    const registry = new CommandRegistry();

    registry.register(exitCommand);
    registry.register(clearCommand);
    registry.register(compactCommand);
    registry.register(rewindCommand);
    registry.register(createHelpCommand(registry));

    return registry;
}

export { CommandRegistry } from './registry.js';
export type { Command, CommandContext, CommandResult } from './types.js';
