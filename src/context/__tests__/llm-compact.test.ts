// src/context/__tests__/llm-compact.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { llmCompact } from '../llm-compact';
import type { Config } from '../../config/types';
import type { Message } from '../../llm/types';

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

describe('llmCompact', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('calls the LLM with a compression prompt and returns the summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Compressed: user asked to sort an array...' } }],
        }),
        { status: 200 },
      ),
    );
    global.fetch = fetchMock;

    const messages: Message[] = [
      { role: 'user', content: 'Help me write a sorting function' },
      { role: 'assistant', content: 'Here is a sorting function: function sort(arr) { ... }' },
      { role: 'user', content: 'Add unit tests' },
      { role: 'assistant', content: "Here are the tests: test('sort', ...)" },
    ];

    const result = await llmCompact(TEST_CONFIG, messages);

    // Verify the LLM was called
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.model).toBe(TEST_CONFIG.model);
    expect(callBody.stream).toBe(false);

    // The messages sent should include a system prompt for compression
    const sentMessages = callBody.messages as Message[];
    expect(sentMessages.length).toBeGreaterThan(0);
    const systemMsg = sentMessages.find((m: Message) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('compress');
    expect(systemMsg!.content).toContain('conversation');

    // The last message should contain the conversation to compress
    const userMsg = sentMessages[sentMessages.length - 1];
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toContain('sorting function');
    expect(userMsg.content).toContain('unit tests');

    // Should return the compressed result
    expect(result).toBe('Compressed: user asked to sort an array...');
  });

  it('throws when the LLM returns an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"Internal Server Error"}', { status: 500 }),
    );
    global.fetch = fetchMock;

    const messages: Message[] = [{ role: 'user', content: 'hi' }];

    await expect(llmCompact(TEST_CONFIG, messages)).rejects.toThrow(/500/);
  });
});
