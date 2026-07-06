import { describe, it, expect, vi } from 'vitest';
import { clearCommand } from '../clear';
import type { CommandContext } from '../../types';
import type { Message } from '../../../../llm/types';
import type { Config } from '../../../../config/types';

const TEST_CONFIG: Config = {
    api_url: '',
    model: '',
    api_key: '',
    tools: { max_loop_rounds: 10, max_consecutive_failures: 3, command_timeout: 60, background_timeout: 0 },
    context: { max_context_tokens: 100000, recent_rounds: 3 },
    subagent: { max_concurrent: 8, default_timeout_ms: 600000, max_inbox_size: 50 },
    memory: { enabled: false, user_budget: 100, agent_budget: 100, compress_threshold: 0.8 },
    sandbox: {
        enabled: true,
        engine: 'bwrap' as const,
        extra_protect_paths: [],
        fallback_to_warn: true,
    },
};

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

describe('/clear', () => {
    it('calls contextManager.clear()', async () => {
        const clear = vi.fn();
        const ctx = mockContext({
            contextManager: {
                ...mockContext().contextManager,
                clear,
            },
        });

        await clearCommand.execute(ctx, '/clear');
        expect(clear).toHaveBeenCalledOnce();
    });

    it('returns handled result', async () => {
        const result = await clearCommand.execute(mockContext(), '/clear');
        expect(result).toEqual({ type: 'handled' });
    });

    it('outputs confirmation message', async () => {
        const info = vi.fn();
        const ctx = mockContext({
            output: { info, error: vi.fn() },
        });

        await clearCommand.execute(ctx, '/clear');
        expect(info).toHaveBeenCalledWith('Conversation cleared.');
    });
});
