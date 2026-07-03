// src/context/__tests__/manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createContextManager } from '../manager';
import type { ContextManager, Summarizer, ContextConfig } from '../types';
import type { Message } from '../../llm/types';

const CONTEXT_CONFIG: ContextConfig = {
  max_context_tokens: 100000,
  flow_rounds: 10,
  summarizer_model: '',
};

function userMsg(content: string): Message {
  return { role: 'user', content };
}

function assistantMsg(content: string): Message {
  return { role: 'assistant', content };
}

function toolMsg(content: string, tool_call_id = 'call_1', name = 'run_command'): Message {
  return { role: 'tool', content, tool_call_id, name };
}

function createMockSummarizer(summaryText?: string): Summarizer {
  const summary = summaryText ?? 'Mock summary (exit 0)';
  return {
    summarize: vi.fn().mockResolvedValue(summary),
    cancelAll: vi.fn(),
  };
}

describe('createContextManager', () => {
  let cm: ContextManager;
  let mockSummarizer: Summarizer;

  beforeEach(() => {
    mockSummarizer = createMockSummarizer();
    cm = createContextManager(CONTEXT_CONFIG, mockSummarizer);
  });

  // === Basic Operations ===

  // Test #1
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

  // Test #2
  it('preserves all messages from multiple rounds', () => {
    for (let i = 0; i < 5; i++) {
      cm.append(userMsg(`q${i}`));
      cm.append(assistantMsg(`a${i}`));
    }
    expect(cm.assemble()).toHaveLength(10);
  });

  // Test #3
  it('accumulates across multiple append calls', () => {
    cm.append(userMsg('a'));
    cm.append(userMsg('b'));
    cm.append(assistantMsg('c'));
    expect(cm.assemble()).toHaveLength(3);
  });

  // === Async Summarization ===

  // Test #4
  it('raw output is visible immediately before summary completes', () => {
    const msg = toolMsg('X'.repeat(5000), 'call_1');
    cm.append(msg);
    cm.scheduleSummarize('call_1', 'run_command', {
      content: 'X'.repeat(5000),
      isError: false,
    });

    const result = cm.assemble();
    const toolMessages = result.filter((m) => m.role === 'tool');
    expect(toolMessages[0].content).toBe('X'.repeat(5000));
  });

  // Test #5
  it('replaces raw output with summary after flush', async () => {
    const msg = toolMsg('X'.repeat(5000), 'call_1');
    cm.append(msg);
    cm.scheduleSummarize('call_1', 'run_command', {
      content: 'X'.repeat(5000),
      isError: false,
    });

    await cm.flushPendingSummaries();

    const result = cm.assemble();
    const toolMessages = result.filter((m) => m.role === 'tool');
    expect(toolMessages[0].content).toBe('Mock summary (exit 0)');
  });

  // Test #6
  it('summary retains key information from the original output', async () => {
    (mockSummarizer.summarize as ReturnType<typeof vi.fn>).mockResolvedValue(
      'Training started on node1 (exit 0)',
    );

    cm.append(toolMsg('...', 'call_1'));
    cm.scheduleSummarize('call_1', 'run_command', {
      content: 'Training started on node1, pid=12345\n[2000 lines of logs]\nexit code: 0',
      isError: false,
    });

    await cm.flushPendingSummaries();
    const result = cm.assemble();
    const toolContent = result.find((m) => m.role === 'tool')!.content!;

    expect(toolContent).toContain('Training started on node1');
    expect(toolContent).toContain('exit 0');
  });

  // Test #7
  it('failure summary retains failure reason', async () => {
    (mockSummarizer.summarize as ReturnType<typeof vi.fn>).mockResolvedValue(
      'node3 failed: CUDA OOM at layer 12 (exit 1)',
    );

    cm.append(toolMsg('...', 'call_1'));
    cm.scheduleSummarize('call_1', 'run_command', {
      content: 'node3 failed, exit code 1\n[500 line stack trace]\nCUDA OOM at layer 12',
      isError: true,
    });

    await cm.flushPendingSummaries();
    const result = cm.assemble();
    const toolContent = result.find((m) => m.role === 'tool')!.content!;

    expect(toolContent).toContain('OOM');
    expect(toolContent).toContain('exit 1');
  });

  // Test #8
  it('each tool message gets its own summary', async () => {
    const mock = mockSummarizer.summarize as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce('Summary A')
      .mockResolvedValueOnce('Summary B')
      .mockResolvedValueOnce('Summary C');

    cm.append(toolMsg('...', 'call_a', 'tool_a'));
    cm.append(toolMsg('...', 'call_b', 'tool_b'));
    cm.append(toolMsg('...', 'call_c', 'tool_c'));

    cm.scheduleSummarize('call_a', 'tool_a', { content: 'A-'.repeat(300), isError: false });
    cm.scheduleSummarize('call_b', 'tool_b', { content: 'B-'.repeat(300), isError: false });
    cm.scheduleSummarize('call_c', 'tool_c', { content: 'C-'.repeat(300), isError: false });

    await cm.flushPendingSummaries();
    const result = cm.assemble();
    const toolContents = result.filter((m) => m.role === 'tool').map((m) => m.content);

    expect(toolContents).toEqual(['Summary A', 'Summary B', 'Summary C']);
  });

  // Test #9
  it('scheduleSummarize does not affect non-tool messages', async () => {
    cm.append(userMsg('question'));
    cm.append(toolMsg('...', 'call_1'));
    cm.append(assistantMsg('answer'));

    cm.scheduleSummarize('call_1', 'run_command', {
      content: 'X'.repeat(500),
      isError: false,
    });

    await cm.flushPendingSummaries();
    const result = cm.assemble();
    expect(result[0].content).toBe('question');
    expect(result[2].content).toBe('answer');
  });

  // Test #10
  it('assemble returns raw version when summary not yet complete', () => {
    cm.append(toolMsg('ORIGINAL_LONG_OUTPUT', 'call_1'));
    cm.scheduleSummarize('call_1', 'run_command', {
      content: 'ORIGINAL_LONG_OUTPUT',
      isError: false,
    });

    // Don't await flush — just assemble immediately
    const result = cm.assemble();
    const toolMessages = result.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(typeof toolMessages[0].content).toBe('string');
  });

  // Test #11
  it('mixed state: some summaries complete, some pending', async () => {
    let resolveDelayed!: (value: string) => void;
    const delayed = new Promise<string>((resolve) => { resolveDelayed = resolve; });

    const mock = mockSummarizer.summarize as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce('Summary fast')
      .mockReturnValueOnce(delayed);

    cm.append(toolMsg('LONG_A', 'call_a'));
    cm.append(toolMsg('LONG_B', 'call_b'));

    cm.scheduleSummarize('call_a', 'tool', { content: 'A'.repeat(500), isError: false });
    cm.scheduleSummarize('call_b', 'tool', { content: 'B'.repeat(500), isError: false });

    // Wait for only the first summary to complete (delayed second)
    await new Promise((r) => setTimeout(r, 10));

    const result = cm.assemble();
    const toolContents = result.filter((m) => m.role === 'tool').map((m) => m.content);

    // First should be summarized, second still raw
    expect(toolContents).toContain('Summary fast');
    expect(toolContents).toContain('LONG_B');

    // Clean up
    resolveDelayed('Summary delayed');
    await cm.flushPendingSummaries();
  });

  // === Token Budget Control ===

  // Test #12
  it('preserves all messages when under budget', () => {
    const cmLarge = createContextManager({ ...CONTEXT_CONFIG, max_context_tokens: 100000 }, mockSummarizer);

    for (let i = 0; i < 5; i++) {
      cmLarge.append(userMsg(`message ${i}`));
    }

    expect(cmLarge.assemble()).toHaveLength(5);
  });

  // Test #13
  it('removes old tool messages when over budget', () => {
    const cmTight = createContextManager({ ...CONTEXT_CONFIG, max_context_tokens: 200 }, mockSummarizer);

    for (let i = 0; i < 50; i++) {
      cmTight.append(toolMsg(`output ${i} `.repeat(50), `call_${i}`));
    }

    const result = cmTight.assemble();
    expect(result.length).toBeLessThan(50);
  });

  // Test #14
  it('removes oldest tool messages first', () => {
    const cmTight = createContextManager({ ...CONTEXT_CONFIG, max_context_tokens: 300 }, mockSummarizer);

    cmTight.append(toolMsg('old tool output', 'call_1'));
    cmTight.append(userMsg('important question'));
    cmTight.append(assistantMsg('important answer'));

    const result = cmTight.assemble();
    const roles = result.map((m) => m.role);

    expect(roles).not.toContain('tool');
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  // Test #15
  it('merges old user+assistant pairs into state layer when no tool messages to compress', () => {
    const cmTight = createContextManager({ ...CONTEXT_CONFIG, max_context_tokens: 300 }, mockSummarizer);

    cmTight.append(userMsg('q1'));
    cmTight.append(assistantMsg('a1'));
    cmTight.append(userMsg('q2'));
    cmTight.append(assistantMsg('a2'));
    cmTight.append(userMsg('q3'));
    cmTight.append(assistantMsg('a3'));
    cmTight.append(userMsg('q4'));
    cmTight.append(assistantMsg('a4'));

    const result = cmTight.assemble();
    const stateMsg = result.find((m) => m.role === 'system');
    expect(stateMsg).toBeDefined();
    const stateContent = JSON.parse(stateMsg!.content!);
    expect(stateContent).toHaveProperty('compressed_history');
  });

  // Test #16
  it('truncates very long single tool messages to fit budget', () => {
    const cmTight = createContextManager({ ...CONTEXT_CONFIG, max_context_tokens: 100 }, mockSummarizer);

    cmTight.append(toolMsg('X'.repeat(5000), 'call_1'));
    cmTight.append(userMsg('hello'));

    const result = cmTight.assemble();
    expect(result.some((m) => m.role === 'user')).toBe(true);
  });

  // Test #17
  it('preserves state layer when compressing tool messages', () => {
    const cmTight = createContextManager({ ...CONTEXT_CONFIG, max_context_tokens: 300 }, mockSummarizer);

    cmTight.setState('task', 'important debug session');
    cmTight.append(toolMsg('old output', 'call_1'));
    cmTight.append(toolMsg('another', 'call_2'));
    cmTight.append(toolMsg('more', 'call_3'));
    cmTight.append(userMsg('current question'));

    const result = cmTight.assemble();
    const stateMsg = result.find((m) =>
      m.role === 'system' && m.content?.includes('important debug session'),
    );
    expect(stateMsg).toBeDefined();
  });

  // Test #18
  it('token count drops after summaries complete', async () => {
    const cmTight = createContextManager({ ...CONTEXT_CONFIG, max_context_tokens: 500 }, mockSummarizer);

    cmTight.append(toolMsg('X'.repeat(2000), 'call_1'));
    cmTight.scheduleSummarize('call_1', 'tool', {
      content: 'X'.repeat(2000),
      isError: false,
    });

    const beforeTokens = cmTight.assemble().reduce((sum, m) => {
      const c = typeof m.content === 'string' ? m.content : '';
      return sum + Math.ceil(c.length / 4);
    }, 0);

    await cmTight.flushPendingSummaries();

    const afterTokens = cmTight.assemble().reduce((sum, m) => {
      const c = typeof m.content === 'string' ? m.content : '';
      return sum + Math.ceil(c.length / 4);
    }, 0);

    expect(afterTokens).toBeLessThan(beforeTokens);
  });

  // === State Layer ===

  // Test #19
  it('no state layer present when setState is never called', () => {
    cm.append(userMsg('hello'));
    const result = cm.assemble();
    expect(result.every((m) => m.role !== 'system')).toBe(true);
  });

  // Test #20
  it('setState creates a state layer system message', () => {
    cm.setState('task', 'debug OOM');
    const result = cm.assemble();
    const stateMsg = result.find((m) => m.role === 'system');
    expect(stateMsg).toBeDefined();
    expect(stateMsg!.content).toContain('debug OOM');
    expect(stateMsg!.content).toContain('task');
  });

  // Test #21
  it('multiple setState calls merge keys', () => {
    cm.setState('a', 1);
    cm.setState('b', 2);
    const state = cm.getState();
    expect(state).toEqual({ a: 1, b: 2 });
  });

  // Test #22
  it('setState overwrites same key', () => {
    cm.setState('a', 1);
    cm.setState('a', 2);
    expect(cm.getState().a).toBe(2);
  });

  // Test #23
  it('compression updates state layer with compressed history', () => {
    const cmTight = createContextManager({ ...CONTEXT_CONFIG, max_context_tokens: 200 }, mockSummarizer);

    cmTight.append(userMsg('q1'));
    cmTight.append(assistantMsg('a1'));
    cmTight.append(userMsg('q2'));
    cmTight.append(assistantMsg('a2'));
    cmTight.append(userMsg('q3'));

    cmTight.assemble(); // triggers compression

    const state = cmTight.getState();
    expect(state).toHaveProperty('compressed_history');
  });

  // Test #24
  it('getState returns current state object', () => {
    cm.setState('x', 'value');
    expect(cm.getState()).toEqual({ x: 'value' });
  });
});
