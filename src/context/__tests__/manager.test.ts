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

    it('removes oldest unpinned tool messages when over budget', { timeout: 15000 }, () => {
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

    // === clear ===

    it('clear resets flow and state', () => {
        cm.append(userMsg('hello'));
        cm.append(assistantMsg('hi'));
        cm.setState('key', 'value');
        cm.clear();

        expect(cm.assemble()).toHaveLength(0);
        expect(cm.getState()).toEqual({});
    });

    it('clear preserves system prompt from config', () => {
        const cmWithPrompt = createContextManager({
            ...CONTEXT_CONFIG,
            systemPrompt: 'You are a helpful assistant.',
        });
        cmWithPrompt.append(userMsg('hello'));
        cmWithPrompt.append(assistantMsg('hi'));
        cmWithPrompt.clear();

        const messages = cmWithPrompt.assemble();
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toBe('You are a helpful assistant.');
    });

    it('clear resets round counter', () => {
        cm.append(userMsg('q1'));  // round 1
        cm.append(assistantMsg('a1'));
        cm.append(userMsg('q2'));  // round 2
        cm.clear();
        cm.append(userMsg('after clear'));

        const entries = cm.getFlowEntries();
        expect(entries[0].round).toBe(1);
    });

    // === getFlowEntries ===

    it('getFlowEntries returns all flow entries with metadata', () => {
        cm.append(userMsg('hello'));
        cm.append(assistantMsg('hi'));

        const entries = cm.getFlowEntries();
        expect(entries).toHaveLength(2);
        expect(entries[0].message.role).toBe('user');
        expect(entries[0].round).toBe(1);
        expect(entries[0].pinned).toBe(false);
        expect(entries[1].message.role).toBe('assistant');
    });

    it('getFlowEntries returns empty array when flow is empty', () => {
        expect(cm.getFlowEntries()).toEqual([]);
    });

    // === llmCompact ===

    it('llmCompact replaces flow with a compressed system message', () => {
        cm.append(userMsg('hello'));
        cm.append(assistantMsg('hi'));
        cm.append(userMsg('do something'));
        cm.append(assistantMsg('done'));

        cm.llmCompact('User asked to do something, assistant completed it.');

        const messages = cm.assemble();
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('[Compressed context]');
        expect(messages[0].content).toContain('User asked to do something');
    });

    // === Deferred message queue ===

    it('appendDeferred does not affect assemble until flushDeferred is called', () => {
        cm.append(userMsg('hello'));
        cm.appendDeferred(userMsg('deferred message'));
        cm.append(assistantMsg('response'));

        const messages = cm.assemble();
        expect(messages).toHaveLength(2);
        expect(messages[0].content).toBe('hello');
        expect(messages[1].content).toBe('response');
    });

    it('flushDeferred appends all deferred messages to flow', () => {
        cm.append(userMsg('hello'));
        cm.appendDeferred(userMsg('deferred 1'));
        cm.appendDeferred(userMsg('deferred 2'));
        cm.flushDeferred();

        const messages = cm.assemble();
        expect(messages).toHaveLength(3);
        expect(messages[0].content).toBe('hello');
        expect(messages[1].content).toBe('deferred 1');
        expect(messages[2].content).toBe('deferred 2');
    });

    it('flushDeferred clears the deferred queue', () => {
        cm.appendDeferred(userMsg('first batch'));
        cm.flushDeferred();
        cm.flushDeferred(); // second flush should be a no-op

        const messages = cm.assemble();
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe('first batch');
    });

    it('multiple appendDeferred + flushDeferred cycles work correctly', () => {
        cm.append(userMsg('round 1'));
        cm.appendDeferred(userMsg('bg task a done'));
        cm.flushDeferred();

        cm.append(userMsg('round 2'));
        cm.appendDeferred(userMsg('bg task b done'));
        cm.appendDeferred(userMsg('bg task c done'));
        cm.flushDeferred();

        const messages = cm.assemble();
        expect(messages).toHaveLength(5);
        expect(messages[0].content).toBe('round 1');
        expect(messages[1].content).toBe('bg task a done');
        expect(messages[2].content).toBe('round 2');
        expect(messages[3].content).toBe('bg task b done');
        expect(messages[4].content).toBe('bg task c done');
    });

    it('flushDeferred when queue is empty is a no-op', () => {
        cm.append(userMsg('hello'));
        cm.flushDeferred();

        const messages = cm.assemble();
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe('hello');
    });

    it('clear resets the deferred queue', () => {
        cm.append(userMsg('hello'));
        cm.appendDeferred(userMsg('deferred'));
        cm.clear();

        cm.flushDeferred();
        const messages = cm.assemble();
        expect(messages).toHaveLength(0);
    });

    // === Tool call invariant preservation ===

    it('deferred user messages never appear between assistant tool_calls and its tool responses', () => {
        // Simulate the race condition: a background task completes during tool
        // execution, but its notification should NOT appear between the
        // assistant's tool_calls and their tool responses.

        // Round: LLM responds with two tool_calls
        cm.append(assistantMsg('')); // placeholder, we need tool_calls
        // Manually construct the flow to simulate the race:
        // 1. Append assistant with tool_calls
        cm.append({
            role: 'assistant',
            content: null,
            tool_calls: [
                { id: 'tc_1', type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"rm file"}' } },
                { id: 'tc_2', type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"rmdir dir"}' } },
            ],
        });

        // 2. Append tool response for tc_1
        cm.append({
            role: 'tool',
            content: 'Task started: job-1',
            tool_call_id: 'tc_1',
            name: 'run_command',
        } as Message);

        // 3. Simulate: background task completes during tc_2's confirmation await
        // Use appendDeferred so it won't interleave
        cm.appendDeferred({
            role: 'user',
            content: 'Background task job-1 finished.',
        });

        // 4. Append tool response for tc_2
        cm.append({
            role: 'tool',
            content: 'Task started: job-2',
            tool_call_id: 'tc_2',
            name: 'run_command',
        } as Message);

        // 5. Flush deferred — should place the notification AFTER tc_2's response
        cm.flushDeferred();

        const messages = cm.assemble();
        // Find positions of tool_calls assistant, tool responses, and user notification
        const assistantIdx = messages.findIndex(m => m.role === 'assistant' && m.tool_calls);
        const tc1Idx = messages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'tc_1');
        const tc2Idx = messages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'tc_2');
        const userIdx = messages.findIndex(m => m.role === 'user' && m.content?.includes('Background task'));

        // The user notification must come AFTER both tool responses (after tc_2),
        // NOT between the assistant and its tool responses
        expect(userIdx).toBeGreaterThan(tc2Idx);
        // Both tool responses must come after the assistant
        expect(tc1Idx).toBeGreaterThan(assistantIdx);
        expect(tc2Idx).toBeGreaterThan(assistantIdx);
        // tc_1 and tc_2 must both be between assistant and user notification
        expect(assistantIdx).toBeLessThan(tc1Idx);
        expect(tc1Idx).toBeLessThan(tc2Idx);
        expect(tc2Idx).toBeLessThan(userIdx);
    });

    it('llmCompact still allows new messages to be appended', () => {
        cm.append(userMsg('old'));
        cm.llmCompact('summary');

        cm.append(userMsg('new question'));
        cm.append(assistantMsg('new answer'));

        const messages = cm.assemble();
        expect(messages).toHaveLength(3);
        expect(messages[0].role).toBe('system');  // compressed summary
        expect(messages[1].role).toBe('user');
        expect(messages[1].content).toBe('new question');
        expect(messages[2].role).toBe('assistant');
        expect(messages[2].content).toBe('new answer');
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
