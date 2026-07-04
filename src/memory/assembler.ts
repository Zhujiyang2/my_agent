// src/memory/assembler.ts
import type { MemoryFile } from './types';

type TokenEstimator = (content: string) => number;

interface AssembleConfig {
  user_budget: number;
  agent_budget: number;
}

export function assembleMemory(
  files: MemoryFile[],
  config: AssembleConfig,
  estimateTokens: TokenEstimator,
): string | null {
  if (files.length === 0) return null;

  const userFiles = files.filter(f => f.metadata.type === 'user');
  const agentFiles = files.filter(f => f.metadata.type === 'agent');

  const sections: string[] = [];

  if (config.user_budget > 0 && userFiles.length > 0) {
    const userSection = buildSection('User Memories', userFiles, config.user_budget, estimateTokens);
    if (userSection) sections.push(userSection);
  }

  if (config.agent_budget > 0 && agentFiles.length > 0) {
    const agentSection = buildSection('Agent Memories', agentFiles, config.agent_budget, estimateTokens);
    if (agentSection) sections.push(agentSection);
  }

  if (sections.length === 0) return null;

  return sections.join('\n\n');
}

function buildSection(
  title: string,
  files: MemoryFile[],
  budget: number,
  estimateTokens: TokenEstimator,
): string | null {
  const sorted = [...files].sort(
    (a, b) => new Date(b.metadata.accessed_at).getTime() - new Date(a.metadata.accessed_at).getTime(),
  );

  const lines: string[] = [];
  let currentTokens = 0;
  const header = `## ${title}`;
  currentTokens += estimateTokens(header);

  for (const file of sorted) {
    const prefix = file.metadata.compressed ? '[compressed] ' : '';
    const entry = `- ${prefix}${file.name}: ${file.description}\n  ${file.body}`;
    const entryTokens = estimateTokens(entry);

    if (currentTokens + entryTokens > budget) {
      continue;
    }

    lines.push(entry);
    currentTokens += entryTokens;
  }

  if (lines.length === 0) return null;

  return `${header}\n${lines.join('\n')}`;
}
