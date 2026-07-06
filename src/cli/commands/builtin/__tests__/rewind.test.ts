import { describe, it, expect, vi } from 'vitest';
import { rewindCommand, buildTurns, type FlowEntry } from '../rewind';
import type { CommandContext } from '../../types';
import type { Message } from '../../../../llm/types';

function entry(role: string, content: string, round: number): FlowEntry {
    return {
        message: { role, content } as Message,
        round,
        pinned: false,
    };
}

describe('buildTurns', () => {
    it('groups entries by user message boundaries', () => {
        const entries: FlowEntry[] = [
            entry('user', 'hello', 1),
            entry('assistant', 'hi', 1),
            entry('user', 'do thing', 2),
            entry('assistant', 'doing', 2),
            entry('tool', 'result', 2),
            entry('assistant', 'done', 2),
        ];

        const turns = buildTurns(entries);
        expect(turns).toHaveLength(2);

        // Turn 1: user("hello") + assistant("hi")
        expect(turns[0].round).toBe(1);
        expect(turns[0].startIndex).toBe(0);
        expect(turns[0].endIndex).toBe(1);
        expect(turns[0].userPreview).toBe('hello');

        // Turn 2: user("do thing") + assistant + tool + assistant
        expect(turns[1].round).toBe(2);
        expect(turns[1].startIndex).toBe(2);
        expect(turns[1].endIndex).toBe(5);
        expect(turns[1].userPreview).toBe('do thing');
    });

    it('returns empty array for empty flow', () => {
        expect(buildTurns([])).toEqual([]);
    });

    it('handles single turn with no assistant response', () => {
        const entries: FlowEntry[] = [
            entry('user', 'question', 1),
        ];
        const turns = buildTurns(entries);
        expect(turns).toHaveLength(1);
        expect(turns[0].startIndex).toBe(0);
        expect(turns[0].endIndex).toBe(0);
    });

    it('truncates userPreview to 60 characters', () => {
        const longMsg = 'a'.repeat(100);
        const entries: FlowEntry[] = [
            entry('user', longMsg, 1),
        ];
        const turns = buildTurns(entries);
        expect(turns[0].userPreview).toHaveLength(60);
    });
});

describe('/rewind', () => {
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

    it('shows error when no conversation to rewind', async () => {
        const error = vi.fn();
        const ctx = mockContext({
            contextManager: {
                ...mockContext().contextManager,
                getFlowEntries() { return []; },
            },
            output: { error, info: vi.fn() },
        });

        await rewindCommand.execute(ctx, '/rewind');
        expect(error).toHaveBeenCalledWith('No conversation to rewind.');
    });

    it('rewinds to selected turn via truncateTo', async () => {
        const entries: FlowEntry[] = [
            entry('user', 'turn 1', 1),
            entry('assistant', 'resp 1', 1),
            entry('user', 'turn 2', 2),
            entry('assistant', 'resp 2', 2),
            entry('user', 'turn 3', 3),
            entry('assistant', 'resp 3', 3),
        ];

        const truncateTo = vi.fn();
        const ctx = mockContext({
            contextManager: {
                ...mockContext().contextManager,
                getFlowEntries() { return entries; },
                truncateTo,
            },
            ui: {
                async prompt() { return '2'; },
            },
            output: {
                info: vi.fn(),
                error: vi.fn(),
            },
        });

        await rewindCommand.execute(ctx, '/rewind');

        // Turn 2: startIndex=2, endIndex=3. truncate to endIndex+1 = 4
        expect(truncateTo).toHaveBeenCalledWith(4);
    });

    it('shows error for invalid turn number', async () => {
        const entries: FlowEntry[] = [
            entry('user', 'turn 1', 1),
        ];

        const error = vi.fn();
        const ctx = mockContext({
            contextManager: {
                ...mockContext().contextManager,
                getFlowEntries() { return entries; },
            },
            ui: {
                async prompt() { return '99'; },
            },
            output: { error, info: vi.fn() },
        });

        await rewindCommand.execute(ctx, '/rewind');
        expect(error).toHaveBeenCalledWith(expect.stringContaining('Invalid turn'));
    });

    it('shows error for non-numeric input', async () => {
        const entries: FlowEntry[] = [
            entry('user', 'turn 1', 1),
        ];

        const error = vi.fn();
        const ctx = mockContext({
            contextManager: {
                ...mockContext().contextManager,
                getFlowEntries() { return entries; },
            },
            ui: {
                async prompt() { return 'abc'; },
            },
            output: { error, info: vi.fn() },
        });

        await rewindCommand.execute(ctx, '/rewind');
        expect(error).toHaveBeenCalledWith('Invalid turn number.');
    });
});
