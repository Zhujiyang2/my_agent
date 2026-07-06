// src/llm/__tests__/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatStream, chat } from '../client';
import type { Config } from '../../config/types';
import type { Message } from '../types';

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
  sandbox: {
    enabled: true,
    engine: 'bwrap' as const,
    extra_protect_paths: [],
    fallback_to_warn: true,
  },
};

const TEST_MESSAGES: Message[] = [
  { role: 'user', content: 'hello' },
];

describe('chatStream', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends POST to {api_url}/chat/completions with correct headers and body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('data: [DONE]\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    global.fetch = fetchMock;

    const tokens: string[] = [];
    await chatStream(TEST_CONFIG, TEST_MESSAGES, undefined, (t) => tokens.push(t));

    const callUrl = fetchMock.mock.calls[0][0];
    const callOptions = fetchMock.mock.calls[0][1];

    expect(callUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(callOptions.method).toBe('POST');
    expect(callOptions.headers['Content-Type']).toBe('application/json');
    expect(callOptions.headers['Authorization']).toBe('Bearer sk-test');

    const body = JSON.parse(callOptions.body);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual(TEST_MESSAGES);
    expect(body.stream).toBe(true);
  });

  it('calls onToken for each content chunk in SSE stream', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hel"},"index":0,"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo"},"index":0,"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );
    global.fetch = fetchMock;

    const tokens: string[] = [];
    await chatStream(TEST_CONFIG, TEST_MESSAGES, undefined, (t) => tokens.push(t));

    expect(tokens).toEqual(['Hel', 'lo']);
  });

  it('throws on non-2xx response with status code in message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"Unauthorized"}', { status: 401 })
    );
    global.fetch = fetchMock;

    await expect(
      chatStream(TEST_CONFIG, TEST_MESSAGES, undefined, () => {})
    ).rejects.toThrow(/401/);
  });

  it('skips empty-string tokens', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":""},"index":0,"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":null}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );
    global.fetch = fetchMock;

    const tokens: string[] = [];
    await chatStream(TEST_CONFIG, TEST_MESSAGES, undefined, (t) => tokens.push(t));

    expect(tokens).toEqual(['ok']);
  });

  it('rejects when the abort signal is triggered', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, opts?: RequestInit) =>
        new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        })
    );
    global.fetch = fetchMock;

    const promise = chatStream(TEST_CONFIG, TEST_MESSAGES, undefined, (_token) => {}, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
  });

  it('accumulates tool_calls from stream deltas', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run_command","arguments":""}}]},"index":0,"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":"}}]},"index":0,"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"echo hi\\"}"}}]},"index":0,"finish_reason":"tool_calls"}]}',
      '',
    ].join('\n');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );
    global.fetch = fetchMock;

    const tokens: string[] = [];
    const result = await chatStream(TEST_CONFIG, TEST_MESSAGES, undefined, (t) => tokens.push(t));

    expect(tokens).toEqual([]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('call_1');
    expect(result.toolCalls[0].function.name).toBe('run_command');
    expect(result.toolCalls[0].function.arguments).toBe('{"command":"echo hi"}');
  });

  it('returns empty toolCalls for text-only response', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":"stop"}]}',
      '',
    ].join('\n');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );
    global.fetch = fetchMock;

    const result = await chatStream(TEST_CONFIG, TEST_MESSAGES, undefined, () => {});
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe('Hello');
  });
});

describe('chat', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends non-streaming POST and returns content', async () => {
    const responseBody = JSON.stringify({
      choices: [{ message: { content: 'compressed result' }, finish_reason: 'stop' }],
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(responseBody, { status: 200 })
    );
    global.fetch = fetchMock;

    const messages: Message[] = [{ role: 'user', content: 'summarize please' }];
    const result = await chat(TEST_CONFIG, messages);

    const callUrl = fetchMock.mock.calls[0][0];
    const callOptions = fetchMock.mock.calls[0][1];

    expect(callUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(callOptions.method).toBe('POST');
    expect(callOptions.headers['Content-Type']).toBe('application/json');
    expect(callOptions.headers['Authorization']).toBe('Bearer sk-test');

    const body = JSON.parse(callOptions.body);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual(messages);
    expect(body.stream).toBe(false);

    expect(result).toBe('compressed result');
  });

  it('throws on non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"Server Error"}', { status: 500 })
    );
    global.fetch = fetchMock;

    await expect(
      chat(TEST_CONFIG, [{ role: 'user', content: 'hi' }])
    ).rejects.toThrow(/500/);
  });
});
