import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../token-counter';

describe('estimateTokens (tiktoken)', () => {
    it('returns 0 for empty array', () => {
        expect(estimateTokens([], 'gpt-4o')).toBe(0);
    });

    it('returns positive count for a single message', () => {
        const tokens = estimateTokens(
            [{ role: 'user', content: 'hello world' }],
            'gpt-4o',
        );
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(20);
    });

    it('counts increase with longer content', () => {
        const short = estimateTokens(
            [{ role: 'user', content: 'hi' }],
            'gpt-4o',
        );
        const long = estimateTokens(
            [{ role: 'user', content: 'hello world this is a longer message with more words' }],
            'gpt-4o',
        );
        expect(long).toBeGreaterThan(short);
    });

    it('counts tool_calls JSON in assistant messages', () => {
        const plainAssistant = estimateTokens(
            [{ role: 'assistant', content: 'hello' }],
            'gpt-4o',
        );
        const withToolCalls = estimateTokens(
            [{
                role: 'assistant',
                content: 'let me run that',
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'run_command', arguments: '{"command":"ls -la"}' },
                }],
            }],
            'gpt-4o',
        );
        expect(withToolCalls).toBeGreaterThan(plainAssistant);
    });

    it('defaults to gpt-4o when model not recognized', () => {
        const tokens = estimateTokens(
            [{ role: 'user', content: 'hello' }],
            'unknown-model-xyz',
        );
        expect(tokens).toBeGreaterThan(0);
    });

    it('counts multiple messages with framing overhead', () => {
        const oneMsg = estimateTokens(
            [{ role: 'user', content: 'test' }],
            'gpt-4o',
        );
        const twoMsg = estimateTokens(
            [
                { role: 'user', content: 'test' },
                { role: 'assistant', content: 'test' },
            ],
            'gpt-4o',
        );
        expect(twoMsg).toBeGreaterThan(oneMsg);
    });
});
