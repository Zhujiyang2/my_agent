// src/cli/commands/types.ts
import type { AgentSession } from '../../agent/loop.js';

export interface CommandContext {
    agent: AgentSession;
    output: {
        info(text: string): void;
        error(text: string): void;
    };
    ui: {
        /** Ask the user a question and return their answer. */
        prompt(text: string): Promise<string>;
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
