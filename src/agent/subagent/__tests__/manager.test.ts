// src/agent/subagent/__tests__/manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubagentManager, setSubagentManager } from '../manager';
import type { SubagentMessage } from '../types';
import type { Config } from '../../../config/types';
import type { Message } from '../../../llm/types';

vi.mock('../../loop', () => ({ createAgent: vi.fn() }));
import { createAgent } from '../../loop';
const mockedCreateAgent = vi.mocked(createAgent);

const BASE_CONFIG: Config = {
  api_url: 'https://api.example.com/v1',
  model: 'test-model',
  api_key: 'sk-test',
  tools: { max_loop_rounds: 100, max_consecutive_failures: 5, command_timeout: 60, background_timeout: 0 },
  context: { max_context_tokens: 100000, recent_rounds: 3 },
  subagent: { max_concurrent: 2, default_timeout_ms: 30000, max_inbox_size: 50 },
};

function makeMockAgent(finalText: string, history?: Message[]) {
  return {
    send: vi.fn().mockResolvedValue(finalText),
    history: history ?? [],
  };
}

function makeNeverResolvingAgent() {
  return {
    send: vi.fn().mockImplementation(() => new Promise(() => {})),
    history: [],
  };
}

describe('SubagentManager', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedCreateAgent.mockClear();
    manager = new SubagentManager(BASE_CONFIG);
    setSubagentManager(manager);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('spawn', () => {
    it('returns immediately with running status (non-blocking)', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());

      const result = await manager.spawn({ task: 'long task' });
      expect(result.status).toBe('running');
      expect(result.id).toBeTruthy();
      expect(result.llmSummary).toContain('spawned');
    });

    it('returns pending status when all slots are taken', async () => {
      // max_concurrent=2, so 3rd spawn should be pending
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());

      await manager.spawn({ task: 'task1' });
      await manager.spawn({ task: 'task2' });
      const result3 = await manager.spawn({ task: 'task3' });

      expect(result3.status).toBe('pending');
    });

    it('eventually completes when subagent finishes in background', async () => {
      mockedCreateAgent.mockReturnValue(
        makeMockAgent('Task done: GPUs healthy', [
          { role: 'user', content: 'check GPU' },
          {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'call_1', type: 'function' as const,
              function: { name: 'run_command', arguments: '{"command":"nvidia-smi"}' },
            }],
          },
          { role: 'tool', content: 'GPU OK | exit code: 0', tool_call_id: 'call_1', name: 'run_command' },
          { role: 'assistant', content: 'Task done: GPUs healthy' },
        ]),
      );

      const spawnResult = await manager.spawn({ task: 'check GPU' });
      expect(spawnResult.status).toBe('running');

      // Advance timers to allow background execution to complete
      await vi.advanceTimersByTimeAsync(100);

      // Now the result should be available
      const stored = manager.result(spawnResult.id)!;
      expect(stored.status).toBe('completed');
      expect(stored.llmSummary).toBe('Task done: GPUs healthy');
      expect(stored.evidence).toHaveLength(1);
      expect(stored.metrics.tokensUsed).toBeGreaterThanOrEqual(0);
    });

    it('captures tool evidence from completed subagent', async () => {
      mockedCreateAgent.mockReturnValue(
        makeMockAgent('Done', [
          { role: 'user', content: 'check' },
          { role: 'assistant', content: null, tool_calls: [{
            id: 'call_1', type: 'function' as const,
            function: { name: 'run_command', arguments: '{"command":"nvidia-smi"}' },
          }]},
          { role: 'tool', content: 'GPU OK | exit code: 0', tool_call_id: 'call_1', name: 'run_command' },
          { role: 'assistant', content: 'Done' },
        ]),
      );

      await manager.spawn({ task: 'check' });
      await vi.advanceTimersByTimeAsync(100);

      const list = manager.list();
      const stored = manager.result(list[0].id)!;
      expect(stored.evidence).toHaveLength(1);
      expect(stored.evidence[0].tool).toBe('run_command');
      expect(stored.evidence[0].exitCode).toBe(0);
    });

    it('handles createAgent throwing', async () => {
      mockedCreateAgent.mockImplementation(() => {
        throw new Error('API key invalid');
      });

      const result = await manager.spawn({ task: 'do' });
      expect(result.status).toBe('failed');
      expect(result.llmSummary).toContain('API key invalid');
    });

    it('transitions from pending to running when slot frees up', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());

      const r1 = await manager.spawn({ task: 'task1' }); // running
      const r2 = await manager.spawn({ task: 'task2' }); // running
      const r3 = await manager.spawn({ task: 'task3' }); // pending

      expect(r1.status).toBe('running');
      expect(r2.status).toBe('running');
      expect(r3.status).toBe('pending');

      // Kill r1 to free a slot
      manager.kill(r1.id);
      await vi.advanceTimersByTimeAsync(100);

      // r3 should now be running
      const list = manager.list();
      const r3entry = list.find(s => s.id === r3.id)!;
      expect(r3entry.status).toBe('running');
    });
  });

  describe('kill', () => {
    it('cancels a running subagent and returns true', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());

      const result = await manager.spawn({ task: 'long task' });
      expect(result.status).toBe('running');

      const killed = manager.kill(result.id);
      expect(killed).toBe(true);

      await vi.advanceTimersByTimeAsync(100);
      const stored = manager.result(result.id)!;
      expect(stored.status).toBe('cancelled');
    });

    it('cancels a pending subagent and returns true', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());

      await manager.spawn({ task: 'task1' });
      await manager.spawn({ task: 'task2' });
      const r3 = await manager.spawn({ task: 'task3' });
      expect(r3.status).toBe('pending');

      expect(manager.kill(r3.id)).toBe(true);
    });

    it('returns false for non-existent id', () => {
      expect(manager.kill('nonexistent')).toBe(false);
    });

    it('returns false for already completed subagent', async () => {
      mockedCreateAgent.mockReturnValue(makeMockAgent('done'));
      const result = await manager.spawn({ task: 'quick' });
      await vi.advanceTimersByTimeAsync(100);

      expect(manager.kill(result.id)).toBe(false);
    });
  });

  describe('list', () => {
    it('returns empty array initially', () => {
      expect(manager.list()).toEqual([]);
    });

    it('returns entries with status and message count', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());

      const r1 = await manager.spawn({ task: 'task1' });
      await manager.spawn({ task: 'task2' });
      await manager.spawn({ task: 'task3' });

      const list = manager.list();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe(r1.id);
      expect(list[0].status).toBe('running');
      expect(list[0].messageCount).toBe(0);
      expect(list[2].status).toBe('pending');
    });
  });

  describe('result', () => {
    it('returns null for still-running subagent', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());
      const result = await manager.spawn({ task: 'long' });
      expect(manager.result(result.id)).toBeNull();
    });

    it('returns result for completed subagent', async () => {
      mockedCreateAgent.mockReturnValue(makeMockAgent('all done'));
      const result = await manager.spawn({ task: 'do' });
      await vi.advanceTimersByTimeAsync(100);

      const stored = manager.result(result.id)!;
      expect(stored.status).toBe('completed');
    });

    it('returns null for unknown id', () => {
      expect(manager.result('unknown')).toBeNull();
    });
  });

  describe('message routing', () => {
    it('routeMessage delivers to subagent inbox', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());
      const r1 = await manager.spawn({ task: 'receiver' });

      const msg: SubagentMessage = {
        id: 'msg_1', from: 'sa_sender', to: r1.id,
        type: 'info', payload: 'hello', timestamp: Date.now(),
      };
      manager.routeMessage(msg);

      // The message should be in r1's inbox
      const list = manager.list();
      const entry = list.find(s => s.id === r1.id)!;
      expect(entry.messageCount).toBe(1);
    });

    it('routeMessage with to="main" delivers to mainInbox', () => {
      const msg: SubagentMessage = {
        id: 'msg_1', from: 'sa_sender', to: 'main',
        type: 'alert', payload: 'GPU offline', timestamp: Date.now(),
      };
      manager.routeMessage(msg);

      const mainMsgs = manager.getMainInbox();
      expect(mainMsgs).toHaveLength(1);
      expect(mainMsgs[0].payload).toBe('GPU offline');
    });

    it('routeMessage with to="all" delivers to all subagents and main', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());
      await manager.spawn({ task: 'sub1' });
      await manager.spawn({ task: 'sub2' });

      const msg: SubagentMessage = {
        id: 'msg_1', from: 'sa_sender', to: 'all',
        type: 'info', payload: 'broadcast', timestamp: Date.now(),
      };
      manager.routeMessage(msg);

      const list = manager.list();
      expect(list.every(s => s.messageCount === 1)).toBe(true);
      expect(manager.getMainInbox()).toHaveLength(1);
    });

    it('silently drops messages to unknown subagent', () => {
      const msg: SubagentMessage = {
        id: 'msg_1', from: 'sa_sender', to: 'sa_nonexistent',
        type: 'info', payload: 'hello', timestamp: Date.now(),
      };
      // Should not throw
      expect(() => manager.routeMessage(msg)).not.toThrow();
    });

    it('enforces max_inbox_size by dropping oldest', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());
      const r1 = await manager.spawn({ task: 'receiver' });

      // Fill inbox beyond capacity (max_inbox_size=50)
      for (let i = 0; i < 55; i++) {
        manager.routeMessage({
          id: `msg_${i}`, from: 'sa_sender', to: r1.id,
          type: 'info', payload: `message ${i}`, timestamp: Date.now(),
        });
      }

      const list = manager.list();
      const entry = list.find(s => s.id === r1.id)!;
      expect(entry.messageCount).toBeLessThanOrEqual(50);
    });
  });

  describe('timeout', () => {
    it('transitions to timeout after specified duration', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());

      await manager.spawn({ task: 'slow', timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(10000);

      const list = manager.list();
      expect(list[0].status).toBe('timeout');
      const stored = manager.result(list[0].id)!;
      expect(stored.status).toBe('timeout');
    });
  });

  describe('cleanup', () => {
    it('destroy aborts all running and pending subagents', async () => {
      mockedCreateAgent.mockReturnValue(makeNeverResolvingAgent());
      await manager.spawn({ task: 't1' });
      await manager.spawn({ task: 't2' });

      manager.destroy();

      const list = manager.list();
      expect(list.every(s => s.status === 'cancelled')).toBe(true);
    });
  });
});
