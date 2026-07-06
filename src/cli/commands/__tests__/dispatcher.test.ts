import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../dispatcher';
import { CommandRegistry } from '../registry';
import { exitCommand } from '../builtin/exit';
import { clearCommand } from '../builtin/clear';
import type { CommandContext } from '../types';
import type { Message } from '../../../llm/types';
import type { Config } from '../../../config/types';

const TEST_CONFIG: Config = {
    api_url: '',
    model: '',
    api_key: '',
    tools: { max_loop_rounds: 10, max_consecutive_failures: 3, command_timeout: 60, background_timeout: 0 },
    context: { max_context_tokens: 100000, recent_rounds: 3 },
    subagent: { max_concurrent: 8, default_timeout_ms: 600000, max_inbox_size: 50 },
    memory: { enabled: false, user_budget: 100, agent_budget: 100, compress_threshold: 0.8 },
};

function mockCtx(overrides?: Partial<CommandContext>): CommandContext {
    return {
        agent: {
            async send() { return ''; },
            get history(): Message[] { return []; },
        } as unknown as CommandContext['agent'],
        contextManager: {
            append() {},
            assemble() { return []; },
            compact() {},
            llmCompact() {},
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
        config: TEST_CONFIG,
        output: {
            info() {},
            error() {},
        },
        ui: {
            async prompt() { return ''; },
            write() {},
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
