// src/agent/__tests__/loop.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgent } from '../loop';
import type { Config } from '../../config/types';

vi.mock('../../llm/client', () => ({
  chatStream: vi.fn(),
}));

import { chatStream } from '../../llm/client';

const mockedChatStream = vi.mocked(chatStream);

const TEST_CONFIG: Config = {
  api_url: 'https://api.example.com/v1',
  model: 'test-model',
  api_key: 'sk-test',
  tools: {
    safety_mode: 'auto',
    max_loop_rounds: 10,
    command_timeout: 60,
    background_timeout: 0,
  },
};

describe('createAgent', () => {
  beforeEach(() => {
    mockedChatStream.mockClear();
  });

  it('returns an agent with send() and empty history', () => {
    const agent = createAgent(TEST_CONFIG);
    expect(typeof agent.send).toBe('function');
    expect(agent.history).toEqual([]);
  });

  it('send() adds user message, calls chatStream, adds assistant reply', async () => {
    mockedChatStream.mockImplementation(async (_config, _messages, onToken) => {
      onToken('Hello');
      onToken(' world');
    });

    const agent = createAgent(TEST_CONFIG);
    const reply = await agent.send('hi there');

    expect(reply).toBe('Hello world');
    expect(agent.history).toEqual([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'Hello world' },
    ]);

    expect(mockedChatStream.mock.calls[0][1]).toEqual([
      { role: 'user', content: 'hi there' },
    ]);
  });

  it('accumulates history across multiple sends', async () => {
    mockedChatStream
      .mockImplementationOnce(async (_c, _m, onToken) => { onToken('Reply1'); })
      .mockImplementationOnce(async (_c, _m, onToken) => { onToken('Reply2'); });

    const agent = createAgent(TEST_CONFIG);
    await agent.send('msg1');
    await agent.send('msg2');

    expect(agent.history).toEqual([
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'Reply1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'Reply2' },
    ]);
  });

  it('passes abort signal to chatStream', async () => {
    mockedChatStream.mockImplementation(async () => {});

    const controller = new AbortController();
    const agent = createAgent(TEST_CONFIG);
    await agent.send('test', controller.signal);

    expect(mockedChatStream.mock.calls[0][3]).toBe(controller.signal);
  });

  it('calls onToken callback for each streamed token', async () => {
    mockedChatStream.mockImplementation(async (_c, _m, onToken) => {
      onToken('H');
      onToken('i');
    });

    const tokens: string[] = [];
    const agent = createAgent(TEST_CONFIG, {
      onToken: (t) => tokens.push(t),
    });

    await agent.send('hello');
    expect(tokens).toEqual(['H', 'i']);
  });

  it('does not mutate history when chatStream fails', async () => {
    mockedChatStream.mockRejectedValueOnce(new Error('Network error'));

    const agent = createAgent(TEST_CONFIG);

    await expect(agent.send('boom')).rejects.toThrow('Network error');

    // History must remain empty — no orphaned user message
    expect(agent.history).toEqual([]);

    // Subsequent send should still work
    mockedChatStream.mockImplementationOnce(async (_c, _m, onToken) => {
      onToken('recovered');
    });

    const reply = await agent.send('retry');
    expect(reply).toBe('recovered');
    expect(agent.history).toEqual([
      { role: 'user', content: 'retry' },
      { role: 'assistant', content: 'recovered' },
    ]);
  });
});
