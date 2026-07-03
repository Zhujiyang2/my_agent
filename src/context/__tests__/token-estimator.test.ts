// src/context/__tests__/token-estimator.test.ts
import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../token-estimator';
import type { Message } from '../../llm/types';

function makeMsg(content: string, role: 'user' | 'assistant' | 'tool' = 'user'): Message {
  return { role, content };
}

function makeAssistantWithToolCalls(): Message {
  return {
    role: 'assistant',
    content: 'Let me run that command',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'run_command', arguments: '{"command":"ls -la"}' },
    }],
  };
}

describe('estimateTokens', () => {
  // Test #25
  it('estimates short messages reasonably', () => {
    const tokens = estimateTokens([makeMsg('hello')]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  // Test #26
  it('estimates increase with message count', () => {
    const one = estimateTokens([makeMsg('x'.repeat(100))]);
    const ten = estimateTokens(Array.from({ length: 10 }, () => makeMsg('x'.repeat(100))));
    const hundred = estimateTokens(Array.from({ length: 100 }, () => makeMsg('x'.repeat(100))));
    expect(ten).toBeGreaterThan(one);
    expect(hundred).toBeGreaterThan(ten);
  });

  // Test #27
  it('counts tool_calls fields in estimation', () => {
    const plain = estimateTokens([makeMsg('hello')]);
    const withTools = estimateTokens([makeAssistantWithToolCalls()]);
    expect(withTools).toBeGreaterThan(plain);
  });

  it('returns 0 for empty messages', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('handles null content', () => {
    const msg: Message = { role: 'assistant', content: null };
    const tokens = estimateTokens([msg]);
    expect(tokens).toBeGreaterThanOrEqual(0);
  });
});
