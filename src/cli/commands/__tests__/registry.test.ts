import { describe, it, expect, beforeEach } from 'vitest';
import { CommandRegistry } from '../registry';
import type { Command } from '../types';

function makeCommand(name: string, description = `${name} command`): Command {
    return {
        name,
        description,
        async execute() {
            return { type: 'handled' as const };
        },
    };
}

describe('CommandRegistry', () => {
    let registry: CommandRegistry;

    beforeEach(() => {
        registry = new CommandRegistry();
    });

    describe('register', () => {
        it('registers a command', () => {
            registry.register(makeCommand('test'));
            expect(registry.getAll()).toHaveLength(1);
        });

        it('overwrites command with same name', () => {
            registry.register(makeCommand('test', 'first'));
            registry.register(makeCommand('test', 'second'));
            expect(registry.getAll()).toHaveLength(1);
            expect(registry.getAll()[0].description).toBe('second');
        });
    });

    describe('resolve', () => {
        it('matches exact command name', () => {
            registry.register(makeCommand('clear'));
            const result = registry.resolve('/clear');
            expect(result).not.toBeNull();
            expect(result!.command.name).toBe('clear');
        });

        it('returns null for unknown command', () => {
            registry.register(makeCommand('clear'));
            expect(registry.resolve('/unknown')).toBeNull();
        });

        it('returns null for non-slash input', () => {
            registry.register(makeCommand('clear'));
            expect(registry.resolve('hello world')).toBeNull();
            expect(registry.resolve('  hello')).toBeNull();
        });

        it('extracts args after command name', () => {
            registry.register(makeCommand('help'));
            const result = registry.resolve('/help rewind');
            expect(result).not.toBeNull();
            expect(result!.args).toBe('rewind');
        });

        it('handles no args', () => {
            registry.register(makeCommand('clear'));
            const result = registry.resolve('/clear');
            expect(result).not.toBeNull();
            expect(result!.args).toBe('');
        });

        it('trims whitespace from input', () => {
            registry.register(makeCommand('clear'));
            expect(registry.resolve('  /clear  ')).not.toBeNull();
        });

        it('handles extra whitespace between name and args', () => {
            registry.register(makeCommand('help'));
            const result = registry.resolve('/help   rewind');
            expect(result).not.toBeNull();
            expect(result!.args).toBe('rewind');
        });
    });

    describe('getAll', () => {
        it('returns commands sorted by name', () => {
            registry.register(makeCommand('rewind'));
            registry.register(makeCommand('clear'));
            registry.register(makeCommand('exit'));

            const all = registry.getAll();
            expect(all.map(c => c.name)).toEqual(['clear', 'exit', 'rewind']);
        });

        it('returns empty array when no commands registered', () => {
            expect(registry.getAll()).toEqual([]);
        });
    });
});
