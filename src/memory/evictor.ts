// src/memory/evictor.ts
import type { MemoryFile } from './types';

type TokenEstimator = (content: string) => number;

export function evictAgent(
  files: MemoryFile[],
  budget: number,
  estimateTokens: TokenEstimator,
): string[] {
  const toRemove: string[] = [];
  const sorted = [...files].sort(
    (a, b) => new Date(a.metadata.accessed_at).getTime() - new Date(b.metadata.accessed_at).getTime(),
  );

  let totalTokens = files.reduce((sum, f) => {
    const fullContent = `- ${f.name}: ${f.description}\n${f.body}`;
    return sum + estimateTokens(fullContent);
  }, 0);

  for (const file of sorted) {
    if (totalTokens <= budget) break;
    const fullContent = `- ${file.name}: ${file.description}\n${file.body}`;
    totalTokens -= estimateTokens(fullContent);
    toRemove.push(file.name);
  }

  return toRemove;
}

export function compressUser(
  files: MemoryFile[],
  threshold: number,
  estimateTokens: TokenEstimator,
): MemoryFile[] {
  if (files.length < threshold) {
    return files.map(f => ({ ...f, metadata: { ...f.metadata } }));
  }

  const protectCount = 2;
  const compressCount = files.length - protectCount;

  return files.map((file, index) => {
    if (index < compressCount) {
      const compressed = truncateToTokenBudget(file.body, 100, estimateTokens);
      return { ...file, metadata: { ...file.metadata, compressed: true }, body: compressed };
    }
    return { ...file, metadata: { ...file.metadata } };
  });
}

function truncateToTokenBudget(body: string, maxTokens: number, estimateTokens: TokenEstimator): string {
  if (estimateTokens(body) <= maxTokens) return body;
  const charBudget = maxTokens * 4;
  let truncated = body.slice(0, charBudget);
  const lastPeriod = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('\n'),
  );
  if (lastPeriod > charBudget * 0.5) {
    truncated = truncated.slice(0, lastPeriod + 1);
  }
  return truncated + '\n[compressed]';
}
