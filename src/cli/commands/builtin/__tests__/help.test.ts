import { describe, it, expect, vi } from 'vitest';
import { createHelpCommand } from '../help';
import { CommandRegistry } from '../../registry';
import { exitCommand } from '../exit';
import { clearCommand } from '../clear';
import type { CommandContext } from '../../types';
import type { Message } from '../../../../llm/types';

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
    return {
        agent: {
            async send() { return ''; },
            get history(): Message[] { return []; },
        } as unknown as CommandContext['agent'],
        contextManager: {
            append() {},
            assemble() { return []; },
            compact() {},
            pin() {},
            unpin() {},
            findByToolCallId() { return undefined; },
            setState() {},
            getState() { return {}; },
            truncateTo() {},
            cancelAll() {},
            clear() {},
            getFlowEntries() { return []; },
        },
        output: {
            info() {},
            error() {},
        },
        ui: {
            async prompt() { return ''; },
        },
        ...overrides,
    };
}

describe('/help', () => {
    it('lists all registered commands', async () => {
        const registry = new CommandRegistry();
        registry.register(exitCommand);
        registry.register(clearCommand);
        const helpCmd = createHelpCommand(registry);

        const info = vi.fn();
        const ctx = mockContext({ output: { info, error: vi.fn() } });

        await helpCmd.execute(ctx, '/help');
        expect(info).toHaveBeenCalledOnce();

        const output = info.mock.calls[0][0];
        expect(output).toContain('/clear');
        expect(output).toContain('/exit');
        expect(output).toContain('Available commands');
    });

    it('shows single command detail when name provided', async () => {
        const registry = new CommandRegistry();
        registry.register(exitCommand);
        const helpCmd = createHelpCommand(registry);

        const info = vi.fn();
        const ctx = mockContext({ output: { info, error: vi.fn() } });

        await helpCmd.execute(ctx, '/help exit');
        expect(info).toHaveBeenCalledOnce();

        const output = info.mock.calls[0][0];
        expect(output).toContain('/exit');
        expect(output).toContain('Exit');
    });

    it('shows error for unknown command', async () => {
        const registry = new CommandRegistry();
        registry.register(exitCommand);
        const helpCmd = createHelpCommand(registry);

        const error = vi.fn();
        const ctx = mockContext({ output: { error, info: vi.fn() } });

        await helpCmd.execute(ctx, '/help unknown');
        expect(error).toHaveBeenCalledWith('Unknown command: "unknown"');
    });

    it('handles /help with no args as list', async () => {
        const registry = new CommandRegistry();
        registry.register(exitCommand);
        registry.register(clearCommand);
        const helpCmd = createHelpCommand(registry);

        const info = vi.fn();
        const ctx = mockContext({ output: { info, error: vi.fn() } });

        await helpCmd.execute(ctx, '/help');
        expect(info).toHaveBeenCalledOnce();
    });
});
