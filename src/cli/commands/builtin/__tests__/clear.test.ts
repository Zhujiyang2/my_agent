import { describe, it, expect, vi } from 'vitest';
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
