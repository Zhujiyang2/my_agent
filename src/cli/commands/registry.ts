import type { Command } from './types.js';

interface ResolvedCommand {
    command: Command;
    args: string;
}

export class CommandRegistry {
    private commands = new Map<string, Command>();

    register(command: Command): void {
        this.commands.set(command.name, command);
    }

    resolve(input: string): ResolvedCommand | null {
        const trimmed = input.trim();
        if (!trimmed.startsWith('/')) return null;

        const spaceIdx = trimmed.indexOf(' ');
        const name = spaceIdx === -1
            ? trimmed.slice(1)
            : trimmed.slice(1, spaceIdx);
        const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

        if (!name) return null;

        const command = this.commands.get(name);
        if (!command) return null;

        return { command, args };
    }

    getAll(): Command[] {
        return [...this.commands.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
        );
    }
}
