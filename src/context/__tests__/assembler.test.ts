import { describe, it, expect } from 'vitest';
import { assembleLayers } from '../assembler';
import type { Message } from '../../llm/types';

describe('assembleLayers', () => {
    it('returns empty array when flow is empty and state is empty', () => {
        const result = assembleLayers({ flow: [], state: {} });
        expect(result).toEqual([]);
    });

    it('orders state before flow', () => {
        const flow: Message[] = [{ role: 'user', content: 'hello' }];
        const state = { task: 'debugging' };

        const result = assembleLayers({ flow, state });

        expect(result[0].role).toBe('system');
        expect(result[0].content).toContain('debugging');
        expect(result[1].role).toBe('user');
        expect(result[1].content).toBe('hello');
    });

    it('no state message when state is empty', () => {
        const flow: Message[] = [{ role: 'user', content: 'hello' }];
        const result = assembleLayers({ flow, state: {} });
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
    });

    it('does not mutate input flow array', () => {
        const flow: Message[] = [{ role: 'user', content: 'hello' }];
        const original = [...flow];
        assembleLayers({ flow, state: {} });
        expect(flow).toEqual(original);
    });

    it('no knowledge layer when state has keys', () => {
        const flow: Message[] = [{ role: 'user', content: 'test' }];
        const state = { key: 'value' };
        const result = assembleLayers({ flow, state });
        // Only state system message + flow (no knowledge layer)
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('system');
        expect(result[1].role).toBe('user');
    });
});
