// src/cli/commands/types.ts
import type { AgentSession } from '../../agent/loop.js';
import type { ContextManager } from '../../context/types.js';
import type { Config } from '../../config/types.js';

export interface CommandContext {
    agent: AgentSession;
    contextManager: ContextManager;
    config: Config;
    output: {
        info(text: string): void;
        error(text: string): void;
    };
    ui: {
        /** Ask the user a question and return their answer. */
        prompt(text: string): Promise<string>;
        /** Pre-fill the input line (for /rewind to show the rewound-to message). */
        write(text: string): void;
    };
}

export interface Command {
    name: string;
    description: string;
    usage?: string;
    execute(ctx: CommandContext, rawInput: string): Promise<CommandResult>;
}

export type CommandResult =
    | { type: 'handled' }
    | { type: 'exit' }
    | { type: 'passthrough' };
