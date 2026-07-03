// src/tools/subagent/__tests__/subagent-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubagentManager, setSubagentManager } from '../../../agent/subagent/manager';
import type { SubagentResult } from '../../../agent/subagent/types';
import type { Config } from '../../../config/types';
import { createSpawnAgentTool } from '../spawn';
import { createListAgentsTool } from '../list';
import { createKillAgentTool, createGetAgentResultTool } from '../kill';
import { createCheckMessagesTool, createSendToSubagentTool } from '../messages';

const BASE_CONFIG: Config = {
  api_url: 'https://api.example.com/v1',
  model: 'test-model',
  api_key: 'sk-test',
  tools: { max_loop_rounds: 100, max_consecutive_failures: 5, command_timeout: 60, background_timeout: 0 },
  context: { max_context_tokens: 100000, recent_rounds: 3 },
  subagent: { max_concurrent: 8, default_timeout_ms: 600000, max_inbox_size: 50 },
};

function makeFakeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    id: 'sa_test123',
    status: 'completed',
    exitCode: 0,
    llmSummary: 'All tasks completed successfully.',
    evidence: [{ tool: 'run_command', exitCode: 0, keyOutput: 'GPU OK', isError: false }],
    keyOutputs: ['GPU OK'],
    metrics: { rounds: 2, tokensUsed: 500, durationMs: 3000 },
    fullTranscriptId: 'sa_test123',
    ...overrides,
  };
}

describe('spawn_agent tool', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager(BASE_CONFIG);
    setSubagentManager(manager);
  });

  it('has correct name and requires task', () => {
    const tool = createSpawnAgentTool();
    expect(tool.name).toBe('spawn_agent');
    expect(tool.parameters.required).toContain('task');
  });

  it('returns immediately with handle (fire-and-forget)', async () => {
    const tool = createSpawnAgentTool();
    const result = await tool.handler({ task: 'check GPU on node-A' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content);
    expect(parsed.id).toBeTruthy();
    expect(parsed.status).toMatch(/^(running|pending)$/);
    expect(parsed.task).toBe('check GPU on node-A');
    expect(parsed.message).toBeDefined();
  });

  it('returns error when task is empty', async () => {
    const tool = createSpawnAgentTool();
    const result = await tool.handler({ task: '' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('task is required');
  });

  it('passes node parameter through', () => {
    const tool = createSpawnAgentTool();
    // Verify node is in the parameter schema
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props.node).toBeDefined();
  });

  it('passes tools parameter through', () => {
    const tool = createSpawnAgentTool();
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props.tools).toBeDefined();
  });
});

describe('list_agents tool', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager(BASE_CONFIG);
    setSubagentManager(manager);
  });

  it('has correct name and no required params', () => {
    const tool = createListAgentsTool();
    expect(tool.name).toBe('list_agents');
    expect(tool.parameters.required).toEqual([]);
  });

  it('returns empty list when no subagents', async () => {
    const tool = createListAgentsTool();
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content);
    expect(parsed).toEqual([]);
  });

  it('returns entries with message_count', async () => {
    manager.routeMessage({
      id: 'msg_1', from: 'sa_x', to: 'main', type: 'info',
      payload: 'test', timestamp: Date.now(),
    });
    // spawn a subagent to have something in the list
    manager.spawn({ task: 'test task' });

    const tool = createListAgentsTool();
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0].message_count).toBeDefined();
  });
});

describe('kill_agent tool', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager(BASE_CONFIG);
    setSubagentManager(manager);
  });

  it('has correct name and requires id', () => {
    const tool = createKillAgentTool();
    expect(tool.name).toBe('kill_agent');
    expect(tool.parameters.required).toContain('id');
  });

  it('returns success when kill succeeds', async () => {
    manager.spawn({ task: 'long task' });
    const list = manager.list();
    vi.spyOn(manager, 'kill').mockReturnValue(true);

    const tool = createKillAgentTool();
    const result = await tool.handler({ id: list[0].id });
    expect(result.exitCode).toBe(0);
    expect(result.content).toContain('cancelled');
  });

  it('returns error when kill fails', async () => {
    vi.spyOn(manager, 'kill').mockReturnValue(false);
    const tool = createKillAgentTool();
    const result = await tool.handler({ id: 'nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('returns error when id is empty', async () => {
    const tool = createKillAgentTool();
    const result = await tool.handler({ id: '' });
    expect(result.isError).toBe(true);
  });
});

describe('get_agent_result tool', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager(BASE_CONFIG);
    setSubagentManager(manager);
  });

  it('has correct name and requires id', () => {
    const tool = createGetAgentResultTool();
    expect(tool.name).toBe('get_agent_result');
    expect(tool.parameters.required).toContain('id');
  });

  it('returns summary by default', async () => {
    vi.spyOn(manager, 'result').mockReturnValue(makeFakeResult());
    const tool = createGetAgentResultTool();
    const result = await tool.handler({ id: 'sa_test' });
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe('completed');
    expect(parsed.detail).toBe('summary');
  });

  it('returns error for unknown id', async () => {
    vi.spyOn(manager, 'result').mockReturnValue(null);
    const tool = createGetAgentResultTool();
    const result = await tool.handler({ id: 'nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('returns full transcript when detail=full', async () => {
    vi.spyOn(manager, 'result').mockReturnValue(makeFakeResult());
    vi.spyOn(manager, 'transcript').mockReturnValue([
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'result' },
    ]);

    const tool = createGetAgentResultTool();
    const result = await tool.handler({ id: 'sa_test', detail: 'full' });
    const parsed = JSON.parse(result.content);
    expect(parsed.detail).toBe('full');
    expect(parsed.transcript).toHaveLength(2);
  });
});

describe('check_subagent_messages tool', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager(BASE_CONFIG);
    setSubagentManager(manager);
  });

  it('returns empty messages initially', async () => {
    const tool = createCheckMessagesTool();
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content);
    expect(parsed.messages).toEqual([]);
    expect(parsed.latest_id).toBeNull();
  });

  it('returns messages from subagents', async () => {
    manager.routeMessage({
      id: 'msg_1', from: 'sa_test', to: 'main',
      type: 'alert', payload: 'GPU offline!', timestamp: Date.now(),
    });

    const tool = createCheckMessagesTool();
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].payload).toBe('GPU offline!');
    expect(parsed.latest_id).toBe('msg_1');
  });

  it('supports since parameter for incremental fetch', async () => {
    manager.routeMessage({
      id: 'msg_1', from: 'sa_a', to: 'main',
      type: 'info', payload: 'first', timestamp: Date.now(),
    });
    manager.routeMessage({
      id: 'msg_2', from: 'sa_b', to: 'main',
      type: 'info', payload: 'second', timestamp: Date.now(),
    });

    const tool = createCheckMessagesTool();
    const r1 = await tool.handler({ since: 'msg_1' });
    const p1 = JSON.parse(r1.content);
    expect(p1.messages).toHaveLength(1);
    expect(p1.messages[0].payload).toBe('second');
  });

  it('invalid since returns all messages', async () => {
    manager.routeMessage({
      id: 'msg_1', from: 'sa_a', to: 'main',
      type: 'info', payload: 'test', timestamp: Date.now(),
    });

    const tool = createCheckMessagesTool();
    const result = await tool.handler({ since: 'nonexistent' });
    const parsed = JSON.parse(result.content);
    expect(parsed.messages).toHaveLength(1);
  });
});

describe('send_message_to_subagent tool', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager(BASE_CONFIG);
    setSubagentManager(manager);
  });

  it('sends message to subagent inbox', async () => {
    manager.spawn({ task: 'receiver task' });
    const list = manager.list();

    const tool = createSendToSubagentTool();
    const result = await tool.handler({
      to: list[0].id,
      type: 'info',
      payload: 'status update: please report your progress',
    });

    expect(result.exitCode).toBe(0);

    const updated = manager.list();
    expect(updated[0].messageCount).toBe(1);
  });

  it('returns error for empty to', async () => {
    const tool = createSendToSubagentTool();
    const result = await tool.handler({ to: '', type: 'info', payload: 'test' });
    expect(result.isError).toBe(true);
  });
});
