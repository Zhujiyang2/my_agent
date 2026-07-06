import { describe, it, expect } from 'vitest';
import { exitCommand } from '../exit';
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
};

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
