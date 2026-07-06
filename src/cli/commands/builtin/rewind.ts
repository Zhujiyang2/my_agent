import type { Command } from '../types.js';
import type { Message } from '../../../llm/types.js';

export interface FlowEntry {
    message: Message;
    round: number;
    pinned: boolean;
}

export interface Turn {
    round: number;
    startIndex: number;
    endIndex: number;
    userPreview: string;
}

const DEFAULT_TURN_COUNT = 5;

export function buildTurns(entries: ReadonlyArray<FlowEntry>): Turn[] {
    const turns: Turn[] = [];
    let current: Turn | null = null;

    for (let i = 0; i < entries.length; i++) {
        if (entries[i].message.role === 'user') {
            if (current) {
                current.endIndex = i - 1;
                turns.push(current);
            }
            const content = String(entries[i].message.content ?? '');
            current = {
                round: entries[i].round,
                startIndex: i,
                endIndex: i,
                userPreview: content.length > 60 ? content.slice(0, 60) : content,
            };
        }
    }
    if (current) {
        current.endIndex = entries.length - 1;
        turns.push(current);
    }
    return turns;
}

export const rewindCommand: Command = {
    name: 'rewind',
    description: 'Rewind conversation to a previous turn',
    usage: '/rewind',
    async execute(ctx, _rawInput) {
        const entries = ctx.contextManager.getFlowEntries();
        const turns = buildTurns(entries);

        if (turns.length === 0) {
            ctx.output.error('No conversation to rewind.');
            return { type: 'handled' };
        }

        // Show last N turns
        const startIdx = Math.max(0, turns.length - DEFAULT_TURN_COUNT);
        const recentTurns = turns.slice(startIdx);

        const lines = ['Recent conversation turns:'];
        for (const turn of recentTurns) {
            const label = `[${turn.round}]`;
            const preview = turn.userPreview.includes('\n')
                ? turn.userPreview.split('\n')[0] + '...'
                : turn.userPreview;
            lines.push(`  ${label} "${preview}"`);
        }
        lines.push(`Enter turn number to rewind to (${recentTurns[0].round}-${recentTurns[recentTurns.length - 1].round}):`);
        ctx.output.info(lines.join('\n'));

        const answer = await ctx.ui.prompt('> ');
        const targetRound = parseInt(answer.trim(), 10);

        if (isNaN(targetRound)) {
            ctx.output.error('Invalid turn number.');
            return { type: 'handled' };
        }

        const targetTurn = turns.find(t => t.round === targetRound);
        if (!targetTurn) {
            ctx.output.error(`Invalid turn number: ${targetRound}. Valid range: 1-${turns[turns.length - 1].round}`);
            return { type: 'handled' };
        }

        // Keep only up to the user message (not the assistant response),
        // so the user can re-ask or the agent will re-respond.
        ctx.contextManager.truncateTo(targetTurn.startIndex + 1);
        ctx.output.info(`Rewound to just after: "${targetTurn.userPreview}"`);
        // Pre-fill the input line with the rewound-to message
        ctx.ui.write(targetTurn.userPreview);
        return { type: 'handled' };
    },
};
