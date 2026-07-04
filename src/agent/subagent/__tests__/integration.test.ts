// src/agent/subagent/__tests__/integration.test.ts
//
// Multi-agent integration tests: full lifecycle, inter-agent messaging,
// broadcast, concurrency, and coordination scenarios.
//
// Uses mocked createAgent so no real LLM calls are made.
// Focuses on the SubagentManager orchestration, message routing,
// and the context-decorator message injection pipeline.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubagentManager, setSubagentManager } from '../manager';
import type { SubagentMessage } from '../types';
import type { Config } from '../../../config/types';
import type { Message } from '../../../llm/types';
import { createContextManager } from '../../../context/manager';
import { createMessageInjector } from '../context-decorator';

vi.mock('../../loop', () => ({ createAgent: vi.fn() }));
import { createAgent } from '../../loop';
const mockedCreateAgent = vi.mocked(createAgent);

// ── Helpers ──

function configWithSlots(maxConcurrent: number): Config {
  return {
    api_url: 'https://api.example.com/v1',
    model: 'test-model',
    api_key: 'sk-test',
    tools: { max_loop_rounds: 100, max_consecutive_failures: 5, command_timeout: 60, background_timeout: 0 },
    context: { max_context_tokens: 100000, recent_rounds: 3 },
    subagent: { max_concurrent: maxConcurrent, default_timeout_ms: 30000, max_inbox_size: 50 },
    memory: { enabled: false, user_budget: 100, agent_budget: 100, compress_threshold: 0.8 },
  };
}

function mockAgent(finalText: string, history?: Message[]) {
  return {
    send: vi.fn().mockResolvedValue(finalText),
    history: history ?? [],
  };
}

function neverResolvingAgent() {
  return {
    send: vi.fn().mockImplementation(() => new Promise(() => {})),
    history: [],
  };
}

function failingAgent(errorMsg: string) {
  return {
    send: vi.fn().mockRejectedValue(new Error(errorMsg)),
    history: [],
  };
}

function throwingCreateAgent(errorMsg: string) {
  mockedCreateAgent.mockImplementation(() => {
    throw new Error(errorMsg);
  });
}

function makeMsg(overrides: Partial<SubagentMessage> & { id: string }): SubagentMessage {
  return {
    from: 'sa_sender',
    to: 'main',
    type: 'info',
    payload: 'default',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Tests ──

describe('Multi-Agent Integration', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedCreateAgent.mockClear();
    manager = new SubagentManager(configWithSlots(4));
    setSubagentManager(manager);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 1: Directed inter-agent messaging
  // ═══════════════════════════════════════════════════════════════
  describe('directed inter-agent messaging', () => {
    it('agents can send directed messages to each other via routeMessage', () => {
      // Spawn 3 agents
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const a = manager.spawn({ task: 'agent A - coordinator' });
      const b = manager.spawn({ task: 'agent B - worker' });
      const c = manager.spawn({ task: 'agent C - monitor' });

      // Agent A sends a request to Agent B
      manager.routeMessage(makeMsg({
        id: 'msg_1', from: a.id, to: b.id, type: 'request',
        payload: 'Please check GPU on node-3',
      }));

      // Agent C sends an alert to Agent A
      manager.routeMessage(makeMsg({
        id: 'msg_2', from: c.id, to: a.id, type: 'alert',
        payload: 'Disk at 95% on node-7',
      }));

      // Agent B responds to Agent A
      manager.routeMessage(makeMsg({
        id: 'msg_3', from: b.id, to: a.id, type: 'response',
        payload: 'GPU healthy, 45°C',
      }));

      // Verify each agent's message count
      const list = manager.list();
      const entryA = list.find(s => s.id === a.id)!;
      const entryB = list.find(s => s.id === b.id)!;
      const entryC = list.find(s => s.id === c.id)!;

      expect(entryA.messageCount).toBe(2); // alert from C + response from B
      expect(entryB.messageCount).toBe(1); // request from A
      expect(entryC.messageCount).toBe(0); // no one messaged C
    });

    it('directed messages do NOT leak to main inbox', () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const a = manager.spawn({ task: 'agent A' });
      const b = manager.spawn({ task: 'agent B' });

      manager.routeMessage(makeMsg({
        id: 'msg_1', from: a.id, to: b.id, type: 'info',
        payload: 'private message',
      }));

      // Main inbox should be empty — message was directed
      expect(manager.getMainInbox()).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 2: Broadcast messaging
  // ═══════════════════════════════════════════════════════════════
  describe('broadcast messaging', () => {
    it('broadcast (to="all") reaches every agent and main inbox', () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      manager.spawn({ task: 'agent-1' });
      manager.spawn({ task: 'agent-2' });
      manager.spawn({ task: 'agent-3' });

      manager.routeMessage(makeMsg({
        id: 'msg_bc', from: 'sa_coordinator', to: 'all', type: 'alert',
        payload: 'URGENT: cluster partition detected!',
      }));

      // All 3 agents should have the broadcast
      const list = manager.list();
      expect(list).toHaveLength(3);
      for (const entry of list) {
        expect(entry.messageCount).toBe(1);
      }
      // Main inbox also receives broadcast
      expect(manager.getMainInbox()).toHaveLength(1);
    });

    it('main agent can send broadcast to all subagents', () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const a = manager.spawn({ task: 'worker-1' });
      const b = manager.spawn({ task: 'worker-2' });

      manager.routeMessage(makeMsg({
        id: 'msg_main', from: 'main', to: 'all', type: 'info',
        payload: 'All workers: report status.',
      }));

      const list = manager.list();
      expect(list.find(s => s.id === a.id)!.messageCount).toBe(1);
      expect(list.find(s => s.id === b.id)!.messageCount).toBe(1);
      // "all" from main also copies to main inbox
      expect(manager.getMainInbox()).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 3: Main inbox message polling (check_subagent_messages)
  // ═══════════════════════════════════════════════════════════════
  describe('main inbox polling with since cursor', () => {
    it('getMainInboxSince returns all messages when no cursor', () => {
      manager.routeMessage(makeMsg({ id: 'm1', from: 'sa_a', to: 'main', payload: 'first' }));
      manager.routeMessage(makeMsg({ id: 'm2', from: 'sa_b', to: 'main', payload: 'second' }));
      manager.routeMessage(makeMsg({ id: 'm3', from: 'sa_c', to: 'main', payload: 'third' }));

      const result = manager.getMainInboxSince();
      expect(result.messages).toHaveLength(3);
      expect(result.latestId).toBe('m3');
    });

    it('getMainInboxSince returns only messages after cursor', () => {
      manager.routeMessage(makeMsg({ id: 'm1', from: 'sa_a', to: 'main', payload: 'first' }));
      manager.routeMessage(makeMsg({ id: 'm2', from: 'sa_b', to: 'main', payload: 'second' }));
      manager.routeMessage(makeMsg({ id: 'm3', from: 'sa_c', to: 'main', payload: 'third' }));

      const result = manager.getMainInboxSince('m1');
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].payload).toBe('second');
      expect(result.messages[1].payload).toBe('third');
      expect(result.latestId).toBe('m3');
    });

    it('getMainInboxSince with latest cursor returns empty', () => {
      manager.routeMessage(makeMsg({ id: 'm1', from: 'sa_a', to: 'main', payload: 'first' }));
      manager.routeMessage(makeMsg({ id: 'm2', from: 'sa_a', to: 'main', payload: 'second' }));

      const result = manager.getMainInboxSince('m2');
      expect(result.messages).toHaveLength(0);
      expect(result.latestId).toBeNull();
    });

    it('getMainInboxSince with unknown cursor returns all messages', () => {
      manager.routeMessage(makeMsg({ id: 'm1', from: 'sa_a', to: 'main', payload: 'only' }));

      const result = manager.getMainInboxSince('nonexistent');
      expect(result.messages).toHaveLength(1);
    });

    it('main inbox with only "to=main" messages excludes subagent-directed ones', () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const a = manager.spawn({ task: 'agent A' });

      // Directed message — should NOT go to main inbox
      manager.routeMessage(makeMsg({ id: 'd1', from: 'sa_x', to: a.id, payload: 'private' }));
      // Main message — SHOULD go to main inbox
      manager.routeMessage(makeMsg({ id: 'm1', from: a.id, to: 'main', payload: 'report done' }));

      expect(manager.getMainInbox()).toHaveLength(1);
      expect(manager.getMainInbox()[0].payload).toBe('report done');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 4: Full lifecycle — spawn → complete → evidence
  // ═══════════════════════════════════════════════════════════════
  describe('full agent lifecycle', () => {
    it('completes with evidence extracted from tool history', async () => {
      mockedCreateAgent.mockReturnValue(mockAgent('All checks passed.', [
        { role: 'user', content: 'run health checks' },
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call_1', type: 'function' as const,
          function: { name: 'run_command', arguments: '{"command":"nvidia-smi"}' },
        }]},
        { role: 'tool', content: 'GPU temp: 45°C | exit code: 0', tool_call_id: 'call_1', name: 'run_command' },
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call_2', type: 'function' as const,
          function: { name: 'run_command', arguments: '{"command":"df -h"}' },
        }]},
        { role: 'tool', content: 'disk usage: 80% | exit code: 0', tool_call_id: 'call_2', name: 'run_command' },
        { role: 'assistant', content: 'All checks passed.' },
      ]));

      const spawnResult = manager.spawn({ task: 'health check' });
      await vi.advanceTimersByTimeAsync(100);

      const result = manager.result(spawnResult.id)!;
      expect(result.status).toBe('completed');
      expect(result.llmSummary).toBe('All checks passed.');
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence[0].tool).toBe('run_command');
      expect(result.evidence[0].exitCode).toBe(0);
      expect(result.evidence[1].tool).toBe('run_command');
      expect(result.keyOutputs).toHaveLength(2);
      expect(result.metrics.rounds).toBeGreaterThanOrEqual(0);
      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('transcript contains the full message history', async () => {
      const history: Message[] = [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'done' },
      ];
      mockedCreateAgent.mockReturnValue(mockAgent('done', history));

      const spawnResult = manager.spawn({ task: 'simple task' });
      await vi.advanceTimersByTimeAsync(100);

      const transcript = manager.transcript(spawnResult.id);
      expect(transcript).not.toBeNull();
      expect(transcript!).toHaveLength(2);
    });

    it('failed agent records error in result', async () => {
      mockedCreateAgent.mockReturnValue(failingAgent('connection refused'));

      const spawnResult = manager.spawn({ task: 'connect to db' });
      await vi.advanceTimersByTimeAsync(100);

      const result = manager.result(spawnResult.id)!;
      expect(result.status).toBe('failed');
      expect(result.llmSummary).toContain('connection refused');
      expect(result.exitCode).toBe(1);
    });

    it('failing createAgent returns failed status immediately (sync)', () => {
      throwingCreateAgent('API key invalid');

      const result = manager.spawn({ task: 'do' });
      expect(result.status).toBe('failed');
      expect(result.llmSummary).toContain('API key invalid');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 5: Concurrency — slot management
  // ═══════════════════════════════════════════════════════════════
  describe('concurrency and slot management', () => {
    it('respects max_concurrent and queues excess as pending', () => {
      const mgr = new SubagentManager(configWithSlots(2));
      setSubagentManager(mgr);
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());

      const r1 = mgr.spawn({ task: 't1' });
      const r2 = mgr.spawn({ task: 't2' });
      const r3 = mgr.spawn({ task: 't3' });
      const r4 = mgr.spawn({ task: 't4' });

      expect(r1.status).toBe('running');
      expect(r2.status).toBe('running');
      expect(r3.status).toBe('pending');
      expect(r4.status).toBe('pending');

      const list = mgr.list();
      expect(list).toHaveLength(4);
      expect(list.filter(s => s.status === 'running')).toHaveLength(2);
      expect(list.filter(s => s.status === 'pending')).toHaveLength(2);
    });

    it('pending→running transition when slot is freed by completion', async () => {
      const mgr = new SubagentManager(configWithSlots(2));
      setSubagentManager(mgr);

      // First two agents complete quickly
      mockedCreateAgent.mockReturnValue(mockAgent('quick done'));
      const r1 = mgr.spawn({ task: 'quick-1' });
      const r2 = mgr.spawn({ task: 'quick-2' });

      // Third agent is slow (never resolves)
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const r3 = mgr.spawn({ task: 'slow' });

      expect(r1.status).toBe('running');
      expect(r2.status).toBe('running');
      expect(r3.status).toBe('pending');

      // r1 and r2 complete
      await vi.advanceTimersByTimeAsync(100);

      // r3 should now be running
      const list = mgr.list();
      const r3entry = list.find(s => s.id === r3.id)!;
      expect(r3entry.status).toBe('running');
    });

    it('pending→running when slot freed by kill', async () => {
      const mgr = new SubagentManager(configWithSlots(2));
      setSubagentManager(mgr);
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());

      mgr.spawn({ task: 't1' });
      const r2 = mgr.spawn({ task: 't2' });
      const r3 = mgr.spawn({ task: 't3' });

      expect(r3.status).toBe('pending');

      // Kill r2, freeing a slot
      mgr.kill(r2.id);
      await vi.advanceTimersByTimeAsync(100);

      const list = mgr.list();
      const r3entry = list.find(s => s.id === r3.id)!;
      expect(r3entry.status).toBe('running');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 6: Context-decorator message injection
  // ═══════════════════════════════════════════════════════════════
  describe('context-decorator message injection', () => {
    it('injected messages appear as system messages in assemble()', () => {
      const base = createContextManager({ max_context_tokens: 100000, recent_rounds: 3 });
      const inbox: SubagentMessage[] = [];

      const decorated = createMessageInjector(base, () => inbox);

      // Simulate: subagent A receives a message from subagent B
      inbox.push(makeMsg({
        id: 'incoming_1', from: 'sa_monitor', to: 'sa_worker',
        type: 'request', payload: 'Please run diagnostics on node-5',
      }));

      const messages = decorated.assemble();
      const systemMsgs = messages.filter(m => m.role === 'system');

      expect(systemMsgs).toHaveLength(1);
      expect(systemMsgs[0].content).toContain('[Incoming request from sa_monitor]');
      expect(systemMsgs[0].content).toContain('Please run diagnostics on node-5');
    });

    it('multiple message types render with correct prefix', () => {
      const base = createContextManager({ max_context_tokens: 100000, recent_rounds: 3 });
      const inbox: SubagentMessage[] = [];
      const decorated = createMessageInjector(base, () => inbox);

      inbox.push(makeMsg({ id: 'm1', from: 'sa_a', to: 'sa_b', type: 'info', payload: 'info msg' }));
      inbox.push(makeMsg({ id: 'm2', from: 'sa_a', to: 'sa_b', type: 'alert', payload: 'alert!' }));
      inbox.push(makeMsg({ id: 'm3', from: 'sa_c', to: 'sa_b', type: 'request', payload: 'req?' }));
      inbox.push(makeMsg({ id: 'm4', from: 'sa_c', to: 'sa_b', type: 'response', payload: 'resp!' }));

      const messages = decorated.assemble();
      const systemMsgs = messages.filter(m => m.role === 'system');

      expect(systemMsgs).toHaveLength(4);
      expect(systemMsgs[0].content).toContain('[Incoming response'); // unshift order
      expect(systemMsgs[1].content).toContain('[Incoming request');
      expect(systemMsgs[2].content).toContain('[Incoming alert');
      expect(systemMsgs[3].content).toContain('[Incoming info');
    });

    it('from field is truncated to 12 chars in injection prefix', () => {
      const base = createContextManager({ max_context_tokens: 100000, recent_rounds: 3 });
      const inbox: SubagentMessage[] = [];
      const decorated = createMessageInjector(base, () => inbox);

      inbox.push(makeMsg({
        id: 'm1', from: 'sa_very_long_agent_identifier_12345', to: 'sa_b',
        type: 'info', payload: 'test',
      }));

      const messages = decorated.assemble();
      const systemMsg = messages.find(m => m.role === 'system')!;

      // from slice(0, 12) = 'sa_very_long'
      expect(systemMsg.content).toContain('from sa_very_long');
      expect(systemMsg.content).not.toContain('agent_identifier');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 7: Inbox capacity enforcement
  // ═══════════════════════════════════════════════════════════════
  describe('inbox capacity enforcement', () => {
    it('subagent inbox drops oldest when exceeding max_inbox_size', () => {
      const mgr = new SubagentManager(configWithSlots(4)); // max_inbox_size=50
      setSubagentManager(mgr);
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const a = mgr.spawn({ task: 'receiver' });

      // Send 60 messages — only last 50 should stay
      for (let i = 0; i < 60; i++) {
        mgr.routeMessage(makeMsg({
          id: `msg_${i}`, from: 'sa_sender', to: a.id,
          type: 'info', payload: `message ${i}`,
        }));
      }

      const list = mgr.list();
      const entry = list.find(s => s.id === a.id)!;
      expect(entry.messageCount).toBe(50);
    });

    it('main inbox capped at 100', () => {
      for (let i = 0; i < 120; i++) {
        manager.routeMessage(makeMsg({
          id: `m_${i}`, from: 'sa_x', to: 'main',
          type: 'info', payload: `msg ${i}`,
        }));
      }

      expect(manager.getMainInbox()).toHaveLength(100);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 8: Timeout behavior
  // ═══════════════════════════════════════════════════════════════
  describe('timeout behavior', () => {
    it('agent with custom timeout transitions to timeout', async () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());

      const result = manager.spawn({ task: 'slow task', timeoutMs: 2000 });
      expect(result.status).toBe('running');

      await vi.advanceTimersByTimeAsync(5000);

      const stored = manager.result(result.id)!;
      expect(stored.status).toBe('timeout');
      expect(stored.llmSummary).toContain('Timed out');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 9: Mass cleanup (destroy)
  // ═══════════════════════════════════════════════════════════════
  describe('mass cleanup', () => {
    it('destroy cancels mixed running+pending agents', () => {
      const mgr = new SubagentManager(configWithSlots(2));
      setSubagentManager(mgr);
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());

      mgr.spawn({ task: 'running-1' });
      mgr.spawn({ task: 'running-2' });
      mgr.spawn({ task: 'pending-1' });
      mgr.spawn({ task: 'pending-2' });

      mgr.destroy();

      const list = mgr.list();
      expect(list).toHaveLength(4);
      expect(list.every(s => s.status === 'cancelled')).toBe(true);
    });

    it('destroy is idempotent — calling twice does not throw', () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      manager.spawn({ task: 'agent' });

      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 10: End-to-end tool simulation — send_message
  // ═══════════════════════════════════════════════════════════════
  describe('send_message tool (subagent-side)', () => {
    it('routeMessage from subagent to main correctly populates main inbox', () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const sub = manager.spawn({ task: 'reporter' });

      // Simulate the subagent's send_message tool calling routeMessage
      manager.routeMessage({
        id: 'msg_tool_1',
        from: sub.id,
        to: 'main',
        type: 'info',
        payload: 'Task progress: 50% complete',
        timestamp: Date.now(),
      });

      const mainMsgs = manager.getMainInbox();
      expect(mainMsgs).toHaveLength(1);
      expect(mainMsgs[0].from).toBe(sub.id);
      expect(mainMsgs[0].payload).toContain('50%');
    });

    it('routeMessage from subagent to another subagent', () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const coordinator = manager.spawn({ task: 'coordinator' });
      const worker = manager.spawn({ task: 'worker' });

      // Coordinator delegates work to worker
      manager.routeMessage({
        id: 'msg_delegate',
        from: coordinator.id,
        to: worker.id,
        type: 'request',
        payload: 'Process batch #42',
        timestamp: Date.now(),
      });

      // Worker responds
      manager.routeMessage({
        id: 'msg_ack',
        from: worker.id,
        to: coordinator.id,
        type: 'response',
        payload: 'Batch #42 done, 1500 records',
        timestamp: Date.now(),
      });

      const list = manager.list();
      expect(list.find(s => s.id === coordinator.id)!.messageCount).toBe(1);
      expect(list.find(s => s.id === worker.id)!.messageCount).toBe(1);
    });

    it('unknown target subagent — silent drop, no error', () => {
      expect(() => {
        manager.routeMessage(makeMsg({
          id: 'orphan', from: 'sa_a', to: 'sa_nonexistent_agent',
          type: 'info', payload: 'hello?',
        }));
      }).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 11: list_agents reflects real-time state
  // ═══════════════════════════════════════════════════════════════
  describe('list reflects real-time state changes', () => {
    it('list updates as agents transition through states', async () => {
      mockedCreateAgent.mockReturnValue(mockAgent('done'));
      const r = manager.spawn({ task: 'transient' });

      // Initially running
      let list = manager.list();
      expect(list.find(s => s.id === r.id)!.status).toBe('running');

      // After completion
      await vi.advanceTimersByTimeAsync(100);
      list = manager.list();
      expect(list.find(s => s.id === r.id)!.status).toBe('completed');
    });

    it('list shows correct task summary truncation', () => {
      mockedCreateAgent.mockReturnValue(neverResolvingAgent());
      const longTask = 'A'.repeat(200) + ' should be truncated';
      manager.spawn({ task: longTask });

      const list = manager.list();
      expect(list[0].taskSummary.length).toBeLessThanOrEqual(100);
      expect(list[0].taskSummary).toBe('A'.repeat(100));
    });
  });
});
