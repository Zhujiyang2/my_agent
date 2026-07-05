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
