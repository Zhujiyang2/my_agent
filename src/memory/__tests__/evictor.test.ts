// src/memory/__tests__/evictor.test.ts
import { describe, it, expect } from 'vitest';
import { evictAgent, compressUser } from '../evictor';
import type { MemoryFile } from '../types';

function makeAgentFile(name: string, accessedAt: string, bodyLen = 200): MemoryFile {
  return {
    name,
    description: `Memory ${name}`,
    metadata: { type: 'agent', accessed_at: accessedAt, compressed: false },
    body: 'x'.repeat(bodyLen),
  };
}

function makeUserFile(name: string, bodyLen = 300): MemoryFile {
  return {
    name,
    description: `Memory ${name}`,
    metadata: { type: 'user', accessed_at: new Date().toISOString(), compressed: false },
    body: 'y'.repeat(bodyLen),
  };
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

describe('evictAgent (LRU)', () => {
  it('returns empty array when under budget', () => {
    const files = [
      makeAgentFile('a', '2026-07-01T00:00:00Z', 100),
      makeAgentFile('b', '2026-07-02T00:00:00Z', 100),
    ];
    const toRemove = evictAgent(files, 500, estimateTokens);
    expect(toRemove).toEqual([]);
  });

  it('returns oldest-accessed names to remove when over budget', () => {
    const files = [
      makeAgentFile('oldest', '2026-01-01T00:00:00Z', 8000),
      makeAgentFile('middle', '2026-06-01T00:00:00Z', 8000),
      makeAgentFile('newest', '2026-07-01T00:00:00Z', 100),
    ];
    const toRemove = evictAgent(files, 2000, estimateTokens);
    expect(toRemove).toContain('oldest');
    expect(toRemove).toContain('middle');
    expect(toRemove).not.toContain('newest');
  });

  it('removes files until budget is met', () => {
    const files = [
      makeAgentFile('a', '2026-01-01T00:00:00Z', 4000),
      makeAgentFile('b', '2026-02-01T00:00:00Z', 4000),
      makeAgentFile('c', '2026-03-01T00:00:00Z', 4000),
    ];
    const toRemove = evictAgent(files, 500, estimateTokens);
    expect(toRemove).toHaveLength(3);
  });

  it('handles empty file list', () => {
    const toRemove = evictAgent([], 1000, estimateTokens);
    expect(toRemove).toEqual([]);
  });
});

describe('compressUser', () => {
  it('returns original files unchanged when under threshold', () => {
    const files = [makeUserFile('a', 200), makeUserFile('b', 200)];
    const result = compressUser(files, 5, estimateTokens);
    expect(result).toHaveLength(2);
    expect(result[0].metadata.compressed).toBe(false);
    expect(result[1].metadata.compressed).toBe(false);
  });

  it('compresses older files when count >= threshold', () => {
    const files = [
      makeUserFile('old1', 500), makeUserFile('old2', 500), makeUserFile('old3', 500),
      makeUserFile('recent1', 500), makeUserFile('recent2', 500),
    ];
    const result = compressUser(files, 5, estimateTokens);
    expect(result).toHaveLength(5);
    expect(result[0].metadata.compressed).toBe(true);
    expect(result[1].metadata.compressed).toBe(true);
    expect(result[2].metadata.compressed).toBe(true);
    expect(result[3].metadata.compressed).toBe(false);
    expect(result[4].metadata.compressed).toBe(false);
  });

  it('compresses older files when count > threshold', () => {
    const files = [
      makeUserFile('old1', 200), makeUserFile('old2', 200), makeUserFile('old3', 200),
      makeUserFile('old4', 200), makeUserFile('old5', 200),
      makeUserFile('recent1', 200), makeUserFile('recent2', 200),
    ];
    const result = compressUser(files, 5, estimateTokens);
    expect(result[0].metadata.compressed).toBe(true);
    expect(result[1].metadata.compressed).toBe(true);
    expect(result[2].metadata.compressed).toBe(true);
    expect(result[3].metadata.compressed).toBe(true);
    expect(result[4].metadata.compressed).toBe(true);
    expect(result[5].metadata.compressed).toBe(false);
    expect(result[6].metadata.compressed).toBe(false);
  });

  it('keeps files uncompressed when below threshold', () => {
    const files = [makeUserFile('old1', 200), makeUserFile('old2', 200), makeUserFile('old3', 200), makeUserFile('recent1', 200)];
    const result = compressUser(files, 5, estimateTokens);
    expect(result.every(f => !f.metadata.compressed)).toBe(true);
  });

  it('handles empty file list', () => {
    const result = compressUser([], 5, estimateTokens);
    expect(result).toEqual([]);
  });
});
