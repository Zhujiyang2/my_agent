import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compactCommand } from '../compact';
import type { CommandContext } from '../../types';
import type { Message } from '../../../../llm/types';
import type { Config } from '../../../../config/types';

const TEST_CONFIG: Config = {
    api_url: 'https://api.example.com/v1',
    model: 'test-model',
    api_key: 'sk-test',
    tools: {
        max_loop_rounds: 10,
        max_consecutive_failures: 3,
        command_timeout: 60,
        background_timeout: 0,
    },
    context: {
        max_context_tokens: 100000,
        recent_rounds: 3,
    },
    subagent: {
        max_concurrent: 8,
        default_timeout_ms: 600000,
        max_inbox_size: 50,
    },
    memory: {
        enabled: false,
        user_budget: 100,
        agent_budget: 100,
        compress_threshold: 0.8,
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

describe('/compact', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('calls contextManager.llmCompact() with LLM-generated summary', async () => {
        // Mock the LLM response
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: 'Compressed: user asked about sorting.' } }],
                }),
                { status: 200 },
            ),
        );
        global.fetch = fetchMock;

        const llmCompact = vi.fn();
        const assemble = vi.fn()
            .mockReturnValueOnce([
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi there' },
            ])
            .mockReturnValueOnce([
                { role: 'system', content: '[Compressed context]\n\nCompressed: user asked about sorting.' },
            ]);

        const info = vi.fn();
        const ctx = mockContext({
            contextManager: {
                ...mockContext().contextManager,
                llmCompact,
                assemble,
            },
            output: { info, error: vi.fn() },
        });

        await compactCommand.execute(ctx, '/compact');

        // Verify llmCompact was called with the LLM-generated summary
        expect(llmCompact).toHaveBeenCalledOnce();
        expect(llmCompact).toHaveBeenCalledWith('Compressed: user asked about sorting.');

        // Verify output message includes token estimates
        expect(info).toHaveBeenCalledWith(expect.stringContaining('Context compacted'));
    });

    it('returns handled result', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: 'summary' } }],
                }),
                { status: 200 },
            ),
        );
        global.fetch = fetchMock;

        const result = await compactCommand.execute(mockContext(), '/compact');
        expect(result).toEqual({ type: 'handled' });
    });
});
