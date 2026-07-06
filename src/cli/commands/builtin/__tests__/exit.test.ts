import { describe, it, expect } from 'vitest';
import { exitCommand } from '../exit';
import type { CommandContext } from '../../types';
import type { Message } from '../../../../llm/types';

function mockContext(): CommandContext {
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
    };
}

describe('/exit', () => {
    it('returns exit result', async () => {
        const result = await exitCommand.execute(mockContext(), '/exit');
        expect(result).toEqual({ type: 'exit' });
    });

    it('ignores extra arguments', async () => {
        const result = await exitCommand.execute(mockContext(), '/exit now');
        expect(result).toEqual({ type: 'exit' });
    });
});
