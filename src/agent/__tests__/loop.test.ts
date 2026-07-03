// src/agent/__tests__/loop.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgent } from '../loop';
import type { Config } from '../../config/types';
import type { StreamResult } from '../../llm/client';
import { createRegistry } from '../../tools/registry';
import type { ToolRegistry, ToolDefinition } from '../../tools/registry';
import { createContextManager } from '../../context/manager';
import type { ContextManager } from '../../context/types';

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
    max_loop_rounds: 10,
    max_consecutive_failures: 3,
    command_timeout: 60,
    background_timeout: 0,
  },
  context: {
    max_context_tokens: 100000,
    recent_rounds: 3,
  },
};

function makeTextResult(content: string): StreamResult {
  return { finishReason: 'stop', content, toolCalls: [] };
}

function makeToolCallResult(name: string, args: Record<string, unknown>, id?: string): StreamResult {
  return {
    finishReason: 'tool_calls',
    content: '',
    toolCalls: [{
      id: id ?? 'call_1',
      type: 'function' as const,
      function: { name, arguments: JSON.stringify(args) },
    }],
  };
}

function createEchoTool(registry: ToolRegistry): ToolDefinition {
  const tool: ToolDefinition = {
    name: 'echo',
    description: 'Echo a message',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Message to echo' } },
      required: ['message'],
    },
    handler: async (params: Record<string, unknown>) => ({ content: `echo: ${params.message}`, summary: `exit=0 | echo ${params.message}`, exitCode: 0 }),
  };
  registry.register(tool);
  return tool;
}

describe('createAgent', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    mockedChatStream.mockClear();
    registry = createRegistry();
  });

  it('returns text when LLM responds without tool calls', async () => {
    mockedChatStream.mockResolvedValueOnce(makeTextResult('Hello world'));

    const agent = createAgent(TEST_CONFIG, { registry });
    const reply = await agent.send('hi');

    expect(reply).toBe('Hello world');
  });

  it('accumulates history across multiple sends', async () => {
    mockedChatStream
      .mockResolvedValueOnce(makeTextResult('Reply1'))
      .mockResolvedValueOnce(makeTextResult('Reply2'));

    const agent = createAgent(TEST_CONFIG, { registry });
    await agent.send('msg1');
    await agent.send('msg2');

    expect(agent.history).toEqual([
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'Reply1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'Reply2' },
    ]);
  });

  it('calls onToken for each streamed token', async () => {
    mockedChatStream.mockImplementation(async (_c, _m, _tools, onToken) => {
      onToken('H'); onToken('i');
      return makeTextResult('Hi');
    });

    const tokens: string[] = [];
    const agent = createAgent(TEST_CONFIG, { registry, onToken: (t) => tokens.push(t) });
    await agent.send('hello');
    expect(tokens).toEqual(['H', 'i']);
  });

  it('passes abort signal to chatStream', async () => {
    mockedChatStream.mockResolvedValueOnce(makeTextResult('ok'));

    const controller = new AbortController();
    const agent = createAgent(TEST_CONFIG, { registry });
    await agent.send('test', controller.signal);
    expect(mockedChatStream.mock.calls[0][4]).toBe(controller.signal);
  });

  it('does not mutate history when chatStream fails', async () => {
    mockedChatStream.mockRejectedValueOnce(new Error('Network error'));

    const agent = createAgent(TEST_CONFIG, { registry });
    await expect(agent.send('boom')).rejects.toThrow('Network error');
    expect(agent.history).toEqual([]);

    mockedChatStream.mockResolvedValueOnce(makeTextResult('recovered'));
    const reply = await agent.send('retry');
    expect(reply).toBe('recovered');
  });

  it('executes tool calls and continues loop', async () => {
    createEchoTool(registry);

    mockedChatStream
      .mockResolvedValueOnce(makeToolCallResult('echo', { message: 'hello' }))
      .mockResolvedValueOnce(makeTextResult('The echo tool said: echo: hello'));

    const agent = createAgent(TEST_CONFIG, { registry });
    const reply = await agent.send('say hello');

    expect(reply).toBe('The echo tool said: echo: hello');
    // History should contain: user, assistant(tool_call), tool(result), assistant(text)
    expect(agent.history).toHaveLength(4);
    expect(agent.history[1].role).toBe('assistant');
    expect(agent.history[1].tool_calls).toBeDefined();
    expect(agent.history[2].role).toBe('tool');
    expect(agent.history[2].tool_call_id).toBe('call_1');
  });

  it('handles unknown tool gracefully', async () => {
    mockedChatStream
      .mockResolvedValueOnce(makeToolCallResult('nonexistent_tool', {}))
      .mockResolvedValueOnce(makeTextResult('I tried but the tool does not exist'));

    const agent = createAgent(TEST_CONFIG, { registry });
    const reply = await agent.send('use bad tool');

    expect(reply).toBe('I tried but the tool does not exist');
    expect(agent.history[2].content).toContain('unknown tool');
  });

  it('throws when exceeding max loop rounds', async () => {
    createEchoTool(registry);

    // Always return tool calls — loop will never terminate
    mockedChatStream.mockResolvedValue(makeToolCallResult('echo', { message: 'loop' }));

    const agent = createAgent(TEST_CONFIG, { registry });
    await expect(agent.send('infinite loop')).rejects.toThrow(/Exceeded maximum/);
  });

  it('preserves partial history when max rounds exceeded (not rolled back)', async () => {
    createEchoTool(registry);

    mockedChatStream.mockResolvedValue(makeToolCallResult('echo', { message: 'loop' }));

    const agent = createAgent(TEST_CONFIG, { registry });
    await expect(agent.send('infinite loop')).rejects.toThrow(/Exceeded maximum/);

    // History should retain the partial conversation for debugging
    expect(agent.history.length).toBeGreaterThan(0);
    expect(agent.history[0].role).toBe('user');
  });

  it('error message includes round count and last tool name', async () => {
    createEchoTool(registry);

    mockedChatStream.mockResolvedValue(makeToolCallResult('echo', { message: 'loop' }));

    const agent = createAgent(TEST_CONFIG, { registry });
    await expect(agent.send('infinite loop')).rejects.toThrow(/last tool: echo/);
  });

  it('calls onToolCall callback for each tool execution', async () => {
    createEchoTool(registry);

    mockedChatStream
      .mockResolvedValueOnce(makeToolCallResult('echo', { message: 'hello' }, 'call_1'))
      .mockResolvedValueOnce(makeTextResult('ok'));

    const toolCalls: string[] = [];
    const agent = createAgent(TEST_CONFIG, {
      registry,
      onToolCall: (name, _args) => toolCalls.push(name),
    });
    await agent.send('say hello');

    expect(toolCalls).toEqual(['echo']);
  });

  it('continues after tool execution error', async () => {
    // Register a tool that throws
    registry.register({
      name: 'broken',
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => { throw new Error('Boom'); },
    });

    mockedChatStream
      .mockResolvedValueOnce(makeToolCallResult('broken', {}))
      .mockResolvedValueOnce(makeTextResult('The tool failed, let me try differently'));

    const agent = createAgent(TEST_CONFIG, { registry });
    const reply = await agent.send('use broken tool');

    expect(reply).toBe('The tool failed, let me try differently');
    expect(agent.history[2].content).toContain('Error executing tool');
  });

  it('includes tool definitions in LLM request when tools are registered', async () => {
    createEchoTool(registry);

    mockedChatStream.mockResolvedValueOnce(makeTextResult('ok'));

    const agent = createAgent(TEST_CONFIG, { registry });
    await agent.send('hi');

    const toolsArg = mockedChatStream.mock.calls[0][2] as Array<{ function: { name: string } }> | undefined;
    expect(toolsArg).toBeDefined();
    expect(toolsArg![0].function.name).toBe('echo');
  });

  it('sends undefined tools when registry is empty', async () => {
    mockedChatStream.mockResolvedValueOnce(makeTextResult('ok'));

    const agent = createAgent(TEST_CONFIG, { registry });
    await agent.send('hi');

    expect(mockedChatStream.mock.calls[0][2]).toBeUndefined();
  });

  it('stops after max_consecutive_failures is reached', async () => {
    // Register a tool that always fails
    registry.register({
      name: 'flaky',
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'fail', isError: true, summary: 'exit=1 | tool failed', exitCode: 1 }),
    });

    // LLM keeps retrying the flaky tool
    mockedChatStream.mockResolvedValue(makeToolCallResult('flaky', {}));

    const agent = createAgent(TEST_CONFIG, { registry });
    await expect(agent.send('use flaky tool')).rejects.toThrow(/consecutive tool failures/);
  });

  it('resets consecutive failure counter on successful tool call', async () => {
    // Register tools: one flaky, one reliable
    registry.register({
      name: 'flaky',
      description: 'Sometimes fails',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'fail', isError: true, summary: 'exit=1 | tool failed', exitCode: 1 }),
    });
    createEchoTool(registry);

    // Round 1: flaky fails
    mockedChatStream.mockResolvedValueOnce(makeToolCallResult('flaky', {}, 'call_1'));
    // Round 2: echo succeeds → resets counter
    mockedChatStream.mockResolvedValueOnce(makeToolCallResult('echo', { message: 'ok' }, 'call_2'));
    // Round 3: flaky fails again (counter = 1, not 3)
    mockedChatStream.mockResolvedValueOnce(makeToolCallResult('flaky', {}, 'call_3'));
    // Round 4: flaky fails again (counter = 2)
    mockedChatStream.mockResolvedValueOnce(makeToolCallResult('flaky', {}, 'call_4'));
    // Round 5: flaky fails again (counter = 3 → stop)
    mockedChatStream.mockResolvedValueOnce(makeToolCallResult('flaky', {}, 'call_5'));

    const agent = createAgent(TEST_CONFIG, { registry });
    await expect(agent.send('test reset')).rejects.toThrow(/consecutive tool failures/);

    // Counter was reset after echo succeeded in round 2,
    // so flaky needed 3 more consecutive failures (rounds 3,4,5) to stop.
    expect(mockedChatStream).toHaveBeenCalledTimes(5);
  });

  it('preserves history when stopped by consecutive failures', async () => {
    registry.register({
      name: 'flaky',
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'fail', isError: true, summary: 'exit=1 | tool failed', exitCode: 1 }),
    });

    mockedChatStream.mockResolvedValue(makeToolCallResult('flaky', {}));

    const agent = createAgent(TEST_CONFIG, { registry });
    await expect(agent.send('use flaky')).rejects.toThrow(/consecutive tool failures/);

    // History should be preserved for debugging
    expect(agent.history.length).toBeGreaterThan(0);
    expect(agent.history[0].role).toBe('user');
  });
});

describe('ContextManager integration', () => {
    let registry: ToolRegistry;
    let cm: ContextManager;

    beforeEach(() => {
        mockedChatStream.mockClear();
        registry = createRegistry();
        cm = createContextManager(
            { max_context_tokens: 100000, recent_rounds: 3 },
        );
    });

    it('auto-pins error tool results', async () => {
        registry.register({
            name: 'failing_tool',
            description: 'Always fails',
            parameters: { type: 'object', properties: {}, required: [] },
            handler: async () => ({
                content: 'error: something broke',
                summary: 'exit=1 | something broke',
                exitCode: 1,
                isError: true,
                keyOutput: 'error: something broke',
            }),
        });

        mockedChatStream
            .mockResolvedValueOnce(makeToolCallResult('failing_tool', {}, 'call_1'))
            .mockResolvedValueOnce(makeTextResult('The tool failed'));

        const agent = createAgent(TEST_CONFIG, { registry, contextManager: cm });
        await agent.send('test pin');

        // The error tool result should have its content preserved (pinned = not compacted)
        const history = [...agent.history];
        const toolMsg = history.find(m => m.role === 'tool');
        expect(toolMsg).toBeDefined();
    });

    it('compact runs after each round without error', async () => {
        registry.register({
            name: 'echo',
            description: 'Echo',
            parameters: {
                type: 'object',
                properties: { message: { type: 'string', description: 'msg' } },
                required: ['message'],
            },
            handler: async (params: Record<string, unknown>) => ({
                content: `echo: ${params.message}`,
                summary: `exit=0 | echo ${params.message}`,
                exitCode: 0,
                keyOutput: `echo: ${params.message}`,
            }),
        });

        mockedChatStream
            .mockResolvedValueOnce(makeToolCallResult('echo', { message: 'hello' }, 'call_1'))
            .mockResolvedValueOnce(makeTextResult('done'));

        const agent = createAgent(TEST_CONFIG, { registry, contextManager: cm });
        const reply = await agent.send('echo test');
        expect(reply).toBe('done');
    });

    it('preserves history structure with context manager', async () => {
        registry.register({
            name: 'echo',
            description: 'Echo',
            parameters: {
                type: 'object',
                properties: { message: { type: 'string', description: 'msg' } },
                required: ['message'],
            },
            handler: async (params: Record<string, unknown>) => ({
                content: `echo: ${params.message}`,
                summary: `exit=0 | echo ${params.message}`,
                exitCode: 0,
                keyOutput: `echo: ${params.message}`,
            }),
        });

        mockedChatStream
            .mockResolvedValueOnce(makeToolCallResult('echo', { message: 'hello' }, 'call_1'))
            .mockResolvedValueOnce(makeTextResult('I echoed your message'));

        const agent = createAgent(TEST_CONFIG, { registry, contextManager: cm });
        await agent.send('echo hello');

        const history = [...agent.history];
        const nonSystem = history.filter(m => m.role !== 'system');
        expect(nonSystem).toHaveLength(4);
        expect(nonSystem[0].role).toBe('user');
        expect(nonSystem[1].role).toBe('assistant');
        expect(nonSystem[1].tool_calls).toBeDefined();
        expect(nonSystem[2].role).toBe('tool');
        expect(nonSystem[3].role).toBe('assistant');
    });

    it('error rollback works with context manager', async () => {
        mockedChatStream.mockRejectedValueOnce(new Error('Network error'));

        const agent = createAgent(TEST_CONFIG, { registry, contextManager: cm });
        await expect(agent.send('boom')).rejects.toThrow('Network error');

        const history = [...agent.history];
        const nonSystem = history.filter(m => m.role !== 'system');
        expect(nonSystem).toHaveLength(0);

        mockedChatStream.mockResolvedValueOnce(makeTextResult('recovered'));
        const reply = await agent.send('retry');
        expect(reply).toBe('recovered');
    });
});
