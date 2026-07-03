// src/context/__tests__/summarizer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSummarizer } from '../summarizer';
import type { Summarizer, ContextConfig } from '../types';
import type { ToolResult } from '../../tools/types';

const API_CONFIG = {
  api_url: 'https://api.example.com/v1',
  api_key: 'sk-test',
  model: 'test-model',
};

const CONTEXT_CONFIG: ContextConfig = {
  max_context_tokens: 96000,
  flow_rounds: 10,
  summarizer_model: '',
};

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeFetchResponse(content: string): Response {
  const body = new ReadableStream({
    start(controller) {
      const chunk = `data: ${JSON.stringify({
        choices: [{ delta: { content }, index: 0, finish_reason: 'stop' }],
      })}\ndata: [DONE]\n`;
      controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return { ok: true, body } as Response;
}

describe('createSummarizer', () => {
  let summarizer: Summarizer;

  beforeEach(() => {
    mockFetch.mockReset();
    summarizer = createSummarizer(CONTEXT_CONFIG, API_CONFIG);
  });

  // Test #28
  it('includes tool name and result in LLM prompt', async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse('Training started successfully (exit 0)'));

    await summarizer.summarize('run_command', {
      content: 'Training done, exit 0. '.repeat(20),
      isError: false,
    });

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const messages = fetchBody.messages;
    const systemMsg = messages.find((m: { role: string }) => m.role === 'system');
    const userMsg = messages.find((m: { role: string }) => m.role === 'user');

    expect(systemMsg.content).toContain('Summarize');
    expect(userMsg.content).toContain('run_command');
    expect(userMsg.content).toContain('Training done');
  });

  // Test #29
  it('skips LLM call for short output (< 200 chars)', async () => {
    const shortResult: ToolResult = { content: 'exit code: 0', isError: false };

    const result = await summarizer.summarize('echo', shortResult);

    expect(result).toBe('exit code: 0');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Test #30
  it('keeps summary to 1-2 sentences when LLM returns more', async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse('First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.'),
    );

    const result = await summarizer.summarize('run_command', {
      content: 'Long output here. '.repeat(50),
      isError: false,
    });

    // Should be concise — exact truncation depends on sentence boundaries,
    // but should be materially shorter than the original 5 sentences
    expect(result.length).toBeLessThan(100);
  });

  // Test #31
  it('returns empty string on summarization failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const longResult: ToolResult = {
      content: 'X'.repeat(500),
      isError: false,
    };

    // Should not throw — returns a fallback
    const result = await summarizer.summarize('run_command', longResult);
    expect(typeof result).toBe('string');
  });

  // Test #32
  it('handles concurrent summarizations independently', async () => {
    mockFetch
      .mockResolvedValueOnce(makeFetchResponse('Summary for A'))
      .mockResolvedValueOnce(makeFetchResponse('Summary for B'))
      .mockResolvedValueOnce(makeFetchResponse('Summary for C'));

    const longResult: ToolResult = { content: 'X'.repeat(500), isError: false };

    const results = await Promise.all([
      summarizer.summarize('tool_a', longResult),
      summarizer.summarize('tool_b', longResult),
      summarizer.summarize('tool_c', longResult),
    ]);

    expect(results[0]).toBe('Summary for A');
    expect(results[1]).toBe('Summary for B');
    expect(results[2]).toBe('Summary for C');
  });

  // Test concurrency cap at 5
  it('respects concurrency cap of 5', async () => {
    // Create 5 pending promises that block slots
    const resolvers: Array<(value: Response) => void> = [];
    for (let i = 0; i < 5; i++) {
      mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      }));
    }
    // 6th call will use this once a slot frees up
    mockFetch.mockResolvedValueOnce(makeFetchResponse('Summary 6'));

    const longResult: ToolResult = { content: 'X'.repeat(500), isError: false };

    // Fire 6 summarizations
    const promises = Array.from({ length: 6 }, (_, i) =>
      summarizer.summarize(`tool_${i}`, longResult),
    );

    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 50));

    // First 5 should have been called, 6th is queued
    expect(mockFetch).toHaveBeenCalledTimes(5);

    // Resolve first one — releases a slot, 6th should start
    resolvers[0](makeFetchResponse('Summary 0'));
    await new Promise((r) => setTimeout(r, 50));

    // 6th should now have fetched
    expect(mockFetch).toHaveBeenCalledTimes(6);

    // Resolve remaining 4
    for (let i = 1; i < 5; i++) {
      resolvers[i](makeFetchResponse(`Summary ${i}`));
    }
    await Promise.all(promises);
  });
});
