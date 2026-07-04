// src/context/__tests__/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createContextManager } from '../manager';
import type { ContextManager, ContextConfig } from '../types';
import type { Message } from '../../llm/types';
import { createMemoryManager, type MemoryManager } from '../../memory/index';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const CONTEXT_CONFIG: ContextConfig = {
    max_context_tokens: 100000,
    recent_rounds: 3,
};

function userMsg(content: string): Message {
    return { role: 'user', content };
}

function assistantMsg(content: string): Message {
    return { role: 'assistant', content };
}

function toolMsg(
    content: string,
    tool_call_id = 'call_1',
    name = 'run_command',
    summary?: string,
    exitCode?: number,
    keyOutput?: string,
): Message {
    return {
        role: 'tool',
        content,
        tool_call_id,
        name,
        summary: summary ?? 'summary',
        exitCode,
        keyOutput,
    } as Message & { summary?: string; exitCode?: number; keyOutput?: string };
}

describe('createContextManager', () => {
    let cm: ContextManager;

    beforeEach(() => {
        cm = createContextManager(CONTEXT_CONFIG);
    });

    // === Basic Operations ===

    it('returns appended messages from assemble', () => {
        cm.append(userMsg('hello'));
        cm.append(assistantMsg('hi there'));
        const result = cm.assemble();
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('user');
        expect(result[0].content).toBe('hello');
        expect(result[1].role).toBe('assistant');
        expect(result[1].content).toBe('hi there');
    });

    it('assemble is pure — repeated calls return same result when no compact', () => {
        cm.append(userMsg('hello'));
        const r1 = cm.assemble();
        const r2 = cm.assemble();
        expect(r1).toEqual(r2);
    });

    it('preserves all messages from multiple rounds', () => {
        for (let i = 0; i < 5; i++) {
            cm.append(userMsg(`q${i}`));
            cm.append(assistantMsg(`a${i}`));
        }
        expect(cm.assemble()).toHaveLength(10);
    });

    // === Compact: age-based ===

    it('compact leaves recent tool messages intact', () => {
        cm.append(userMsg('q1'));
        cm.append(assistantMsg('a1'));
        cm.append(toolMsg('full output content here', 'call_1', 'run_command', 'exit=0 | ok', 0, 'full output'));
        cm.append(assistantMsg('a2'));

        cm.compact();

        const result = cm.assemble();
        const toolMessages = result.filter(m => m.role === 'tool');
        expect(toolMessages[0].content).toBe('full output content here');
    });

    it('compact switches old tool messages to summary', () => {
        for (let r = 0; r < 5; r++) {
            cm.append(userMsg(`q${r}`));
            cm.append(assistantMsg(`a${r}`));
            cm.append(toolMsg(
                `round-${r}-output-here-very-long`,
                `call_${r}`,
                'run_command',
                `exit=0 | round ${r} summary`,
                0,
                `key: round-${r}`,
            ));
        }

        cm.compact();
        const result = cm.assemble();
        const toolMessages = result.filter(m => m.role === 'tool');

        // Oldest tool (r=0) should be switched to summary
        expect(toolMessages[0].content).toContain('exit=0 | round 0 summary');
        // Latest tool (r=4) should be intact
        expect(toolMessages[4].content).toBe('round-4-output-here-very-long');
    });

    // === Compact: pin ===

    it('pinned messages are never compacted', () => {
        for (let r = 0; r < 5; r++) {
            cm.append(userMsg(`q${r}`));
            cm.append(assistantMsg(`a${r}`));
            cm.append(toolMsg(
                `round-${r}-output`,
                `call_${r}`,
                'run_command',
                `exit=0 | round ${r} summary`,
                0,
                `key: round-${r}`,
            ));
        }

        // Pin the oldest tool message (index 2 in flow: user=0, asst=1, tool=2)
        cm.pin(2);

        cm.compact();
        const result = cm.assemble();
        const toolMessages = result.filter(m => m.role === 'tool');

        // Pinned message (oldest) should still have full content
        expect(toolMessages[0].content).toBe('round-0-output');
        // Unpinned old messages should be summarized
        expect(toolMessages[1].content).toContain('exit=0 | round 1 summary');
    });

    it('unpin allows compaction again', () => {
        for (let r = 0; r < 5; r++) {
            cm.append(userMsg(`q${r}`));
            cm.append(assistantMsg(`a${r}`));
            cm.append(toolMsg(`round-${r}-output`, `call_${r}`, 'run_command', `summary-${r}`, 0));
        }

        cm.pin(2);
        cm.unpin(2);
        cm.compact();

        const result = cm.assemble();
        const toolMessages = result.filter(m => m.role === 'tool');
        // Now the oldest should be summarized since it's unpinned
        expect(toolMessages[0].content).toContain('summary-0');
    });

    // === findByToolCallId ===

    it('finds tool message by tool_call_id', () => {
        cm.append(userMsg('q'));
        cm.append(toolMsg('output', 'call_abc', 'run_command'));
        cm.append(userMsg('q2'));
        cm.append(toolMsg('output2', 'call_xyz', 'glob'));

        expect(cm.findByToolCallId('call_abc')).toBe(1);
        expect(cm.findByToolCallId('call_xyz')).toBe(3);
    });

    it('returns undefined when tool_call_id not found', () => {
        cm.append(userMsg('q'));
        cm.append(toolMsg('output', 'call_1', 'run_command'));

        expect(cm.findByToolCallId('nonexistent')).toBeUndefined();
    });

    it('returns the most recent match when tool_call_id appears multiple times', () => {
        cm.append(userMsg('q1'));
        cm.append(toolMsg('first', 'call_same', 'run_command'));
        cm.append(userMsg('q2'));
        cm.append(toolMsg('second', 'call_same', 'run_command'));

        expect(cm.findByToolCallId('call_same')).toBe(3);
    });

    it('returns undefined when flow is empty', () => {
        expect(cm.findByToolCallId('anything')).toBeUndefined();
    });

    it('only matches tool messages, not other roles', () => {
        // A non-tool message with the same tool_call_id should NOT match
        cm.append({ role: 'user', content: 'hello', tool_call_id: 'call_same' } as any);
        cm.append(toolMsg('real tool', 'call_same', 'run_command'));

        const idx = cm.findByToolCallId('call_same');
        expect(idx).toBe(1); // should find the tool message at index 1, not the user message at index 0
        expect(cm.assemble()[idx!].role).toBe('tool');
    });

    // === Compact: dedup ===

    it('deduplicates adjacent tool messages with same summary', () => {
        cm.append(userMsg('q'));
        cm.append(assistantMsg('a'));
        cm.append(toolMsg('output-1', 'call_1', 'run_command', 'exit=0 | GPU 78%'));
        cm.append(assistantMsg('a2'));
        cm.append(toolMsg('output-2', 'call_2', 'run_command', 'exit=0 | GPU 78%'));
        cm.append(assistantMsg('a3'));
        cm.append(toolMsg('output-3', 'call_3', 'run_command', 'exit=0 | GPU 78%'));
        cm.append(assistantMsg('a4'));
        cm.append(toolMsg('output-4', 'call_4', 'run_command', 'exit=0 | GPU 78%'));

        cm.compact();
        const result = cm.assemble();
        const toolMessages = result.filter(m => m.role === 'tool');

        // All 4 tool messages preserved (tool_call_ids must not be orphaned),
        // but earlier duplicates have [merged] prefix
        expect(toolMessages).toHaveLength(4);
        const mergedTools = toolMessages.filter(
          m => m.content?.startsWith('[merged]'),
        );
        expect(mergedTools).toHaveLength(3); // first 3 merged, last kept original
        expect(toolMessages[3].content).toBe('output-4'); // last one intact
    });

    it('does not deduplicate different summaries', () => {
        cm.append(userMsg('q'));
        cm.append(assistantMsg('a'));
        cm.append(toolMsg('output-1', 'call_1', 'run_command', 'exit=0 | GPU 78%'));
        cm.append(assistantMsg('a2'));
        cm.append(toolMsg('output-2', 'call_2', 'run_command', 'exit=1 | CUDA OOM'));
        cm.append(assistantMsg('a3'));

        cm.compact();
        const result = cm.assemble();
        const toolMessages = result.filter(m => m.role === 'tool');
        // Different summaries, should not dedup
        expect(toolMessages).toHaveLength(2);
    });

    // === Compact: budget ===

    it('removes oldest unpinned tool messages when over budget', () => {
        const cmTight = createContextManager({ max_context_tokens: 50, recent_rounds: 3 });

        for (let i = 0; i < 10; i++) {
            cmTight.append(toolMsg(`output ${i} `.repeat(20), `call_${i}`, 'run_command', `summary-${i}`));
        }

        cmTight.compact();
        const result = cmTight.assemble();
        expect(result.length).toBeLessThan(10);
    });

    it('throws BudgetError when no more tool messages to remove', () => {
        const cmTight = createContextManager({ max_context_tokens: 1, recent_rounds: 3 });

        // Add only user+assistant (no tool messages to evict)
        cmTight.append(userMsg('important question that cannot be removed'));

        expect(() => cmTight.compact()).toThrow(/BudgetError/);
    });

    it('user/assistant messages are never removed', () => {
        const cmTight = createContextManager({ max_context_tokens: 100, recent_rounds: 3 });

        cmTight.append(userMsg('important'));
        cmTight.append(assistantMsg('response'));
        cmTight.append(toolMsg('big output '.repeat(50), 'call_1', 'run_command', 'summary'));

        cmTight.compact();
        const result = cmTight.assemble();
        const roles = result.map(m => m.role);
        expect(roles).toContain('user');
        expect(roles).toContain('assistant');
    });

    // === State Layer ===

    it('no state layer present when setState is never called', () => {
        cm.append(userMsg('hello'));
        const result = cm.assemble();
        expect(result.every(m => m.role !== 'system')).toBe(true);
    });

    it('setState creates a state layer system message', () => {
        cm.setState('task', 'debug OOM');
        const result = cm.assemble();
        const stateMsg = result.find(m => m.role === 'system');
        expect(stateMsg).toBeDefined();
        expect(stateMsg!.content).toContain('debug OOM');
    });

    it('multiple setState calls merge keys', () => {
        cm.setState('a', 1);
        cm.setState('b', 2);
        const state = cm.getState();
        expect(state).toEqual({ a: 1, b: 2 });
    });

    it('setState overwrites same key', () => {
        cm.setState('a', 1);
        cm.setState('a', 2);
        expect(cm.getState().a).toBe(2);
    });

    it('getState returns a shallow copy', () => {
        cm.setState('x', 'value');
        const s1 = cm.getState();
        s1.x = 'mutated';
        expect(cm.getState().x).toBe('value');
    });

    // === Rollback ===

    it('truncateTo removes messages beyond count', () => {
        cm.append(userMsg('a'));
        cm.append(userMsg('b'));
        cm.append(userMsg('c'));
        cm.truncateTo(2);
        expect(cm.assemble()).toHaveLength(2);
    });

    it('truncateTo with count >= length does nothing', () => {
        cm.append(userMsg('a'));
        cm.truncateTo(5);
        expect(cm.assemble()).toHaveLength(1);
    });
});

describe('createContextManager with MemoryManager', () => {
  let cm: ContextManager;
  let mm: MemoryManager;
  const testDir = path.join(os.tmpdir(), `ctx-memory-test-${Date.now()}`);

  beforeEach(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    mm = createMemoryManager({
      enabled: true,
      user_budget: 4000,
      agent_budget: 2000,
      compress_threshold: 5,
      memoryDir: testDir,
    });
    cm = createContextManager(CONTEXT_CONFIG, 'gpt-4o', mm);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('injects memory as first system message when memories exist', async () => {
    await mm.remember({
      name: 'test-memory',
      description: 'A test memory',
      content: 'Test memory content.',
      type: 'user',
    });

    cm.append(userMsg('hello'));
    const messages = cm.assemble();

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('## User Memories');
    expect(messages[0].content).toContain('test-memory');
  });

  it('does not inject memory when no memories exist', async () => {
    cm.append(userMsg('hello'));
    const messages = cm.assemble();

    expect(messages[0].role).toBe('user');
  });

  it('injects memory before state layer', async () => {
    await mm.remember({
      name: 'test-memory',
      description: 'Test',
      content: 'Memory content.',
      type: 'user',
    });

    cm.setState('key', 'value');
    cm.append(userMsg('hello'));
    const messages = cm.assemble();

    // First: memory system message
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('User Memories');

    // Second: state system message
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('"key":"value"');

    // Third: user message
    expect(messages[2].role).toBe('user');
  });
});
