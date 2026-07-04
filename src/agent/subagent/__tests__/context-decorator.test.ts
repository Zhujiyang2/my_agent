// src/agent/subagent/__tests__/context-decorator.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createMessageInjector } from '../context-decorator';
import { createContextManager } from '../../../context/manager';
import type { ContextManager } from '../../../context/types';
import type { SubagentMessage } from '../types';

function makeMsg(overrides: Partial<SubagentMessage> = {}): SubagentMessage {
  return {
    id: 'msg_1',
    from: 'sa_sender',
    to: 'sa_receiver',
    type: 'info',
    payload: 'hello from sender',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('createMessageInjector', () => {
  let base: ContextManager;
  let inbox: SubagentMessage[];

  beforeEach(() => {
    base = createContextManager(
      { max_context_tokens: 100000, recent_rounds: 3 },
    );
    inbox = [];
  });

  it('injects new inbox messages into assemble() output', () => {
    inbox.push(makeMsg());
    const decorated = createMessageInjector(base, () => inbox);

    const messages = decorated.assemble();
    const systemMsgs = messages.filter(m => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('[Incoming info from sa_sender]');
    expect(systemMsgs[0].content).toContain('hello from sender');
  });

  it('does NOT modify the original inbox', () => {
    inbox.push(makeMsg());
    const decorated = createMessageInjector(base, () => inbox);

    decorated.assemble();
    expect(inbox).toHaveLength(1); // still there — no side effect
  });

  it('does not re-inject already-injected messages', () => {
    inbox.push(makeMsg());
    const decorated = createMessageInjector(base, () => inbox);

    decorated.assemble();
    const messages2 = decorated.assemble();
    const systemMsgs2 = messages2.filter(m => m.role === 'system');
    expect(systemMsgs2).toHaveLength(0); // already injected
  });

  it('injects new messages that arrive after previous assemble()', () => {
    inbox.push(makeMsg({ id: 'msg_1' }));
    const decorated = createMessageInjector(base, () => inbox);

    decorated.assemble(); // msg_1 injected

    inbox.push(makeMsg({ id: 'msg_2', payload: 'second message' }));
    const messages = decorated.assemble();
    const systemMsgs = messages.filter(m => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('second message');
  });

  it('cleans up stale injected IDs when messages are removed from inbox', () => {
    inbox.push(makeMsg({ id: 'msg_1' }));
    const decorated = createMessageInjector(base, () => inbox);

    decorated.assemble(); // msg_1 injected
    inbox.length = 0; // msg_1 removed (simulating GC after subagent termination)

    // Should not throw — stale ID cleanup
    inbox.push(makeMsg({ id: 'msg_2', payload: 'new after cleanup' }));
    const messages = decorated.assemble();
    const systemMsgs = messages.filter(m => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('new after cleanup');
  });

  it('delegates all other methods to base ContextManager', () => {
    const decorated = createMessageInjector(base, () => inbox);
    decorated.append({ role: 'user', content: 'test' });
    const assembled = decorated.assemble();
    const userMsgs = assembled.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe('test');
  });

  it('injects alert-type messages with correct prefix', () => {
    inbox.push(makeMsg({ type: 'alert', payload: 'GPU offline!' }));
    const decorated = createMessageInjector(base, () => inbox);

    const messages = decorated.assemble();
    const systemMsgs = messages.filter(m => m.role === 'system');
    expect(systemMsgs[0].content).toContain('[Incoming alert from sa_sender]');
  });

  it('injects multiple new messages in order', () => {
    inbox.push(makeMsg({ id: 'msg_1', payload: 'first' }));
    inbox.push(makeMsg({ id: 'msg_2', payload: 'second' }));
    const decorated = createMessageInjector(base, () => inbox);

    const messages = decorated.assemble();
    const systemMsgs = messages.filter(m => m.role === 'system');
    expect(systemMsgs).toHaveLength(2);
    expect(systemMsgs[0].content).toContain('second'); // unshift order: second first
    expect(systemMsgs[1].content).toContain('first');
  });

  it('delegates findByToolCallId to base ContextManager', () => {
    base.append({ role: 'user', content: 'q' });
    base.append({ role: 'tool', content: 'output', tool_call_id: 'call_1', name: 'run_command' } as any);
    base.append({ role: 'tool', content: 'output2', tool_call_id: 'call_2', name: 'glob' } as any);

    const decorated = createMessageInjector(base, () => inbox);

    expect(decorated.findByToolCallId('call_1')).toBe(1);
    expect(decorated.findByToolCallId('call_2')).toBe(2);
    expect(decorated.findByToolCallId('nonexistent')).toBeUndefined();
  });
});
