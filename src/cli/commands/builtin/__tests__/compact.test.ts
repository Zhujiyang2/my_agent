import { describe, it, expect, vi } from 'vitest';
import { compactCommand } from '../compact';
import type { CommandContext } from '../../types';
import type { Message } from '../../../../llm/types';

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
    return {
        agent: {
            async send() { return ''; },
            get history(): Message[] { return []; },
            clearContext() {},
            compactContext() {},
            getContextFlow() { return []; },
            truncateContextTo() {},
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
    it('calls agent.compactContext()', async () => {
        const compactContext = vi.fn();
        const ctx = mockContext({
            agent: {
                ...mockContext().agent,
                compactContext,
            },
        });

        await compactCommand.execute(ctx, '/compact');
        expect(compactContext).toHaveBeenCalledOnce();
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
