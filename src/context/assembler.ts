// src/context/assembler.ts
import type { Message } from '../llm/types';
import { estimateTokens } from './token-estimator';

export interface AssembleInput {
  knowledge: string;
  state: Record<string, unknown>;
  flow: Message[];
}

export function assembleLayers(
  input: AssembleInput,
  maxTokens?: number,
): Message[] {
  const result: Message[] = [];

  // Layer 1: Knowledge
  if (input.knowledge) {
    result.push({ role: 'system', content: input.knowledge });
  }

  // Layer 2: State
  if (Object.keys(input.state).length > 0) {
    result.push({ role: 'system', content: JSON.stringify(input.state) });
  }

  // Layer 3: Flow (with optional budget enforcement)
  const flowClone = input.flow.map((m) => ({ ...m }));

  if (maxTokens && maxTokens > 0) {
    // Start from oldest, remove tool messages first
    while (estimateTokens([...result, ...flowClone]) > maxTokens && flowClone.length > 0) {
      let removed = false;
      for (let i = 0; i < flowClone.length; i++) {
        if (flowClone[i].role === 'tool') {
          flowClone.splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) {
        // No more tool messages — remove oldest flow message
        flowClone.shift();
      }
    }
  }

  result.push(...flowClone);
  return result;
}
