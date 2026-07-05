import { describe, it, expect } from 'vitest';
import { exitCommand } from '../exit';
import type { CommandContext } from '../../types';
import type { Message } from '../../../../llm/types';

function mockContext(): CommandContext {
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
