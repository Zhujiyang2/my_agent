// src/context/token-estimator.ts
import type { Message } from '../llm/types';

/**
 * Rough token estimation using character-count heuristic.
 * Approximates: 1 token ≈ 4 characters (conservative for English + code).
 * This is a fast synchronous estimate — precise counting needs a tokenizer.
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    total += Math.ceil(content.length / 4);

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += Math.ceil(tc.function.name.length / 4);
        total += Math.ceil(tc.function.arguments.length / 4);
        total += 4; // overhead for id + type
      }
    }
    if (msg.tool_call_id) {
      total += Math.ceil(msg.tool_call_id.length / 4);
    }
    if (msg.name) {
      total += Math.ceil(msg.name.length / 4);
    }
    // Per-message role overhead
    total += 4;
  }
  return total;
}
