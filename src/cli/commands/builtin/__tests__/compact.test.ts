import { describe, it, expect, vi } from 'vitest';
import { compactCommand } from '../compact';
import type { CommandContext } from '../../types';
import type { Message } from '../../../../llm/types';

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
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

describe('/compact', () => {
    it('calls contextManager.compact()', async () => {
        const compact = vi.fn();
        const ctx = mockContext({
            contextManager: {
                ...mockContext().contextManager,
                compact,
            },
        });

        await compactCommand.execute(ctx, '/compact');
        expect(compact).toHaveBeenCalledOnce();
    });

    it('returns handled result', async () => {
        const result = await compactCommand.execute(mockContext(), '/compact');
        expect(result).toEqual({ type: 'handled' });
    });

    it('outputs confirmation message', async () => {
        const info = vi.fn();
        const ctx = mockContext({
            output: { info, error: vi.fn() },
        });

        await compactCommand.execute(ctx, '/compact');
        expect(info).toHaveBeenCalledWith('Context compacted.');
    });
});
