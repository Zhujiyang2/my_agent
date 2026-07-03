// src/context/__tests__/assembler.test.ts
import { describe, it, expect } from 'vitest';
import { assembleLayers } from '../assembler';
import type { Message } from '../../llm/types';

describe('assembleLayers', () => {
  // Test #41
  it('returns empty array when all layers are empty', () => {
    const result = assembleLayers({ flow: [], knowledge: '', state: {} });
    expect(result).toEqual([]);
  });

  // Test #42
  it('orders: knowledge → state → flow', () => {
    const flow: Message[] = [
      { role: 'user', content: 'hello' },
    ];
    const state = { task: 'debugging' };
    const knowledge = 'Domain: NPU cluster operations';

    const result = assembleLayers({ flow, state, knowledge });

    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('NPU cluster');
    expect(result[1].role).toBe('system');
    expect(result[1].content).toContain('debugging');
    expect(result[2].role).toBe('user');
  });

  // Test #43
  it('knowledge and state layers are not subject to compression', () => {
    // Pass a very low budget — flow should be trimmed but knowledge+state preserved
    const flow: Message[] = Array.from({ length: 50 }, (_, i) => ({
      role: 'tool' as const,
      content: `tool output ${i} `.repeat(20),
      tool_call_id: `call_${i}`,
    }));
    const knowledge = 'KEEP_THIS_KNOWLEDGE';
    const state = { important: 'KEEP_THIS_STATE' };

    const result = assembleLayers({ flow, state, knowledge }, 300);

    // Knowledge and state should still be present
    expect(result.some((m) => m.content?.includes('KEEP_THIS_KNOWLEDGE'))).toBe(true);
    expect(result.some((m) => m.content?.includes('KEEP_THIS_STATE'))).toBe(true);
    // Flow should be reduced
    const flowCount = result.filter((m) => m.role === 'tool').length;
    expect(flowCount).toBeLessThan(50);
  });

  // Test #44
  it('injects knowledge content when provided', () => {
    const result = assembleLayers({
      flow: [],
      state: {},
      knowledge: '# NPU Reference\n\nCommand: npu-smi info',
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('npu-smi');
  });

  // Test #45
  it('no knowledge injected when directory is empty', () => {
    const result = assembleLayers({
      flow: [{ role: 'user', content: 'test' }],
      state: {},
      knowledge: '',
    });
    // Only flow message should be present
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  // Test #47
  it('knowledge layer appears as first system message', () => {
    const result = assembleLayers({
      flow: [{ role: 'user', content: 'hello' }],
      state: { task: 'test' },
      knowledge: '# References\n\nnpu-smi info — show NPU status',
    });

    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('npu-smi');
    expect(result[1].role).toBe('system'); // state
    expect(result[2].role).toBe('user');
  });
});
