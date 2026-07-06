import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../dispatcher';
import { CommandRegistry } from '../registry';
import { exitCommand } from '../builtin/exit';
import { clearCommand } from '../builtin/clear';
import type { CommandContext } from '../types';
import type { Message } from '../../../llm/types';

function mockCtx(overrides?: Partial<CommandContext>): CommandContext {
    return {
        agent: {
            async send() { return ''; },
            get history(): Message[] { return []; },
        },
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

describe('dispatch', () => {
    it('returns send_to_agent for non-slash input', async () => {
        const registry = new CommandRegistry();
        const result = await dispatch('hello world', registry, mockCtx());
        expect(result).toEqual({ action: 'send_to_agent', input: 'hello world' });
    });

    it('routes /exit to command and returns exit action', async () => {
        const registry = new CommandRegistry();
        registry.register(exitCommand);
        const result = await dispatch('/exit', registry, mockCtx());
        expect(result).toEqual({ action: 'exit' });
    });

    it('routes /clear to command and returns continue action', async () => {
        const registry = new CommandRegistry();
        registry.register(clearCommand);
        const result = await dispatch('/clear', registry, mockCtx());
        expect(result).toEqual({ action: 'continue' });
    });

    it('shows error for unknown slash command', async () => {
        const registry = new CommandRegistry();
        const error = vi.fn();
        const ctx = mockCtx({ output: { error, info: vi.fn() } });

        const result = await dispatch('/unknown', registry, ctx);
        expect(result).toEqual({ action: 'continue' });
        expect(error).toHaveBeenCalledWith('Unknown command. Type /help for available commands.');
    });

    it('call clear command actually invokes contextManager.clear()', async () => {
        const registry = new CommandRegistry();
        registry.register(clearCommand);
        const clear = vi.fn();
        const ctx = mockCtx({
            contextManager: {
                ...mockCtx().contextManager,
                clear,
            },
        });

        const result = await dispatch('/clear', registry, ctx);
        expect(result).toEqual({ action: 'continue' });
        expect(clear).toHaveBeenCalledOnce();
    });

    it('empty slash name is treated as unknown command', async () => {
        const registry = new CommandRegistry();
        registry.register(exitCommand);
        const error = vi.fn();
        const ctx = mockCtx({ output: { error, info: vi.fn() } });

        // Just a lone "/" — no command name
        const result = await dispatch('/', registry, ctx);
        expect(result).toEqual({ action: 'continue' });
        expect(error).toHaveBeenCalled();
    });
});
