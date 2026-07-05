// src/memory/assembler.ts
import type { MemoryFile } from './types';

type TokenEstimator = (content: string) => number;

interface AssembleConfig {
  user_budget: number;
  agent_budget: number;
}

export interface AssembleResult {
  content: string | null;
  userWarnings: string[];
}

export function assembleMemory(
  files: MemoryFile[],
  config: AssembleConfig,
  estimateTokens: TokenEstimator,
): AssembleResult {
  if (files.length === 0) return { content: null, userWarnings: [] };

  const userFiles = files.filter(f => f.metadata.type === 'user');
  const agentFiles = files.filter(f => f.metadata.type === 'agent');

  const sections: string[] = [];
  const userWarnings: string[] = [];

  if (config.user_budget > 0 && userFiles.length > 0) {
    const result = buildSection('User Memories', userFiles, config.user_budget, estimateTokens);
    if (result) {
      sections.push(result.content);
      if (result.usagePercent >= 90 || result.skipped > 0) {
        const skippedMsg = result.skipped > 0
          ? `${result.skipped} older entries skipped, `
          : '';
        userWarnings.push(
          `\x1b[33m⚠ Memory: ${skippedMsg}user memory ${result.usagePercent}% full.\x1b[0m\n` +
          `  Review and clean up at ~/.my_agent/memory/`
        );
      }
    }
  }

  if (config.agent_budget > 0 && agentFiles.length > 0) {
    const result = buildSection('Agent Memories', agentFiles, config.agent_budget, estimateTokens);
    if (result) sections.push(result.content);
  }

  if (sections.length === 0) return { content: null, userWarnings };

  return { content: sections.join('\n\n'), userWarnings };
}

interface SectionResult {
  content: string;
  skipped: number;
  usagePercent: number;
}

function buildSection(
  title: string,
  files: MemoryFile[],
  budget: number,
  estimateTokens: TokenEstimator,
): SectionResult | null {
  const sorted = [...files].sort(
    (a, b) => new Date(b.metadata.accessed_at).getTime() - new Date(a.metadata.accessed_at).getTime(),
  );

  const lines: string[] = [];
  let currentTokens = 0;
  const header = `## ${title}`;
  currentTokens += estimateTokens(header);
  let skipped = 0;

  for (const file of sorted) {
    const prefix = file.metadata.compressed ? '[compressed] ' : '';
    const entry = `- ${prefix}${file.name}: ${file.description}\n  ${file.body}`;
    const entryTokens = estimateTokens(entry);

    if (currentTokens + entryTokens > budget) {
      skipped++;
      continue;
    }

    lines.push(entry);
    currentTokens += entryTokens;
  }

  if (lines.length === 0) return null;

  const usagePercent = Math.round((currentTokens / budget) * 100);

  return { content: `${header}\n${lines.join('\n')}`, skipped, usagePercent };
}
