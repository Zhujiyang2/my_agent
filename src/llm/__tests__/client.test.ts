// src/llm/__tests__/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatStream } from '../client';
import type { Config } from '../../config/types';
import type { Message } from '../types';

const TEST_CONFIG: Config = {
  api_url: 'https://api.example.com/v1',
  model: 'test-model',
  api_key: 'sk-test',
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
    await chatStream(TEST_CONFIG, TEST_MESSAGES, (t) => tokens.push(t));

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
    await chatStream(TEST_CONFIG, TEST_MESSAGES, (t) => tokens.push(t));

    expect(tokens).toEqual(['Hel', 'lo']);
  });

  it('throws on non-2xx response with status code in message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"Unauthorized"}', { status: 401 })
    );
    global.fetch = fetchMock;

    await expect(
      chatStream(TEST_CONFIG, TEST_MESSAGES, () => {})
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
    await chatStream(TEST_CONFIG, TEST_MESSAGES, (t) => tokens.push(t));

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

    const promise = chatStream(TEST_CONFIG, TEST_MESSAGES, (token) => {}, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
  });
});
