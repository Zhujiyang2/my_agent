// src/memory/__tests__/assembler.test.ts
import { describe, it, expect } from 'vitest';
import { assembleMemory } from '../assembler';
import type { MemoryFile } from '../types';

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function makeFile(overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    name: 'test',
    description: 'A test memory',
    metadata: { type: 'user', accessed_at: '2026-07-04T12:00:00Z', compressed: false },
    body: 'This is the body content.\n\n**Why:** testing.\n',
    ...overrides,
  };
}

describe('assembleMemory', () => {
  it('returns null when file list is empty', () => {
    const result = assembleMemory([], { user_budget: 4000, agent_budget: 2000 }, estimateTokens);
    expect(result).toBeNull();
  });

  it('returns system message with user and agent sections', () => {
    const files = [
      makeFile({ name: 'prefer-react', metadata: { type: 'user', accessed_at: '2026-07-01T00:00:00Z', compressed: false } }),
      makeFile({ name: 'refactored-context', metadata: { type: 'agent', accessed_at: '2026-07-01T00:00:00Z', compressed: false } }),
    ];
    const result = assembleMemory(files, { user_budget: 4000, agent_budget: 2000 }, estimateTokens);
    expect(result).not.toBeNull();
    expect(result).toContain('## User Memories');
    expect(result).toContain('## Agent Memories');
    expect(result).toContain('prefer-react');
    expect(result).toContain('refactored-context');
  });

  it('skips user section when no user memories', () => {
    const files = [
      makeFile({ name: 'agent-mem', metadata: { type: 'agent', accessed_at: '2026-07-01T00:00:00Z', compressed: false } }),
    ];
    const result = assembleMemory(files, { user_budget: 4000, agent_budget: 2000 }, estimateTokens);
    expect(result).not.toBeNull();
    expect(result).not.toContain('## User Memories');
    expect(result).toContain('## Agent Memories');
  });

  it('skips agent section when no agent memories', () => {
    const files = [
      makeFile({ name: 'user-mem', metadata: { type: 'user', accessed_at: '2026-07-01T00:00:00Z', compressed: false } }),
    ];
    const result = assembleMemory(files, { user_budget: 4000, agent_budget: 2000 }, estimateTokens);
    expect(result).not.toBeNull();
    expect(result).toContain('## User Memories');
    expect(result).not.toContain('## Agent Memories');
  });

  it('marks compressed entries with [compressed] prefix', () => {
    const files = [
      makeFile({ name: 'old-mem', metadata: { type: 'user', accessed_at: '2026-01-01T00:00:00Z', compressed: true }, body: 'Short summary.' }),
    ];
    const result = assembleMemory(files, { user_budget: 4000, agent_budget: 2000 }, estimateTokens);
    expect(result).toContain('[compressed]');
  });

  it('respects user budget by truncating oldest entries', () => {
    const files: MemoryFile[] = [];
    for (let i = 0; i < 10; i++) {
      files.push(makeFile({
        name: `user-${i}`,
        description: `Memory ${i}`,
        metadata: { type: 'user', accessed_at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`, compressed: false },
        body: 'x'.repeat(400),
      }));
    }
    const result = assembleMemory(files, { user_budget: 500, agent_budget: 2000 }, estimateTokens);
    expect(result).not.toBeNull();
    expect(result).toContain('user-9'); // newest
    const lines = result!.split('\n').filter(l => l.includes('user-0'));
    expect(lines).toHaveLength(0);
  });

  it('respects zero budget for a category', () => {
    const files = [
      makeFile({ name: 'user-mem', metadata: { type: 'user', accessed_at: '2026-07-01T00:00:00Z', compressed: false } }),
      makeFile({ name: 'agent-mem', metadata: { type: 'agent', accessed_at: '2026-07-01T00:00:00Z', compressed: false } }),
    ];
    const result = assembleMemory(files, { user_budget: 0, agent_budget: 2000 }, estimateTokens);
    expect(result).not.toBeNull();
    expect(result).not.toContain('## User Memories');
    expect(result).toContain('## Agent Memories');
  });
});
