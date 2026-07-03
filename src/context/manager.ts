// src/context/manager.ts
import type { ContextManager, Summarizer, ContextConfig } from './types';
import type { Message } from '../llm/types';
import type { ToolResult } from '../tools/types';
import { estimateTokens } from './token-estimator';

/**
 * Per-message token overhead to account for API message framing
 * (role labels, JSON structure, tool_call_id/name fields, etc.).
 * This is applied on top of estimateTokens() for budget enforcement
 * to ensure the assembled context fits within the model's token limit.
 */
const MSG_OVERHEAD = 92;

export function createContextManager(
  config: ContextConfig,
  summarizer: Summarizer,
): ContextManager {
  const flowMessages: Message[] = [];
  const state: Record<string, unknown> = {};
  const pendingSummaries = new Map<string, Promise<void>>();
  let knowledgeContent = '';
  let cancelled = false;

  const maxTokens = config.max_context_tokens > 0
    ? config.max_context_tokens
    : 102400; // 80% of 128K default

  function append(message: Message): void {
    flowMessages.push(message);
  }

  function countEffectiveTokens(): number {
    return estimateTokens(buildMessages()) + flowMessages.length * MSG_OVERHEAD;
  }

  function assemble(): Message[] {
    applyBudget();
    return buildMessages();
  }

  function buildMessages(): Message[] {
    const result: Message[] = [];

    // Layer 1: Knowledge (if any)
    if (knowledgeContent) {
      result.push({ role: 'system', content: knowledgeContent });
    }

    // Layer 2: State (if any keys set)
    if (Object.keys(state).length > 0) {
      result.push({ role: 'system', content: JSON.stringify(state) });
    }

    // Layer 3: Flow
    for (const msg of flowMessages) {
      result.push({ ...msg });
    }

    return result;
  }

  function isProtectedToolMessage(msg: Message): boolean {
    return (
      msg.role === 'tool' &&
      msg.tool_call_id != null &&
      pendingSummaries.has(msg.tool_call_id)
    );
  }

  function applyBudget(): void {
    let currentTokens = countEffectiveTokens();

    while (currentTokens > maxTokens && flowMessages.length > 0) {
      // Try to find a removable tool message (oldest first), skipping protected ones
      let removed = false;
      for (let i = 0; i < flowMessages.length; i++) {
        if (flowMessages[i].role === 'tool' && !isProtectedToolMessage(flowMessages[i])) {
          flowMessages.splice(i, 1);
          removed = true;
          break;
        }
      }

      // If no tool messages to remove, compress oldest user+assistant pair to state
      if (!removed) {
        if (!compressOldestPairToState()) {
          // Nothing could be removed — budget is tight but we can't reduce further
          break;
        }
      }

      const newTokens = countEffectiveTokens();
      if (newTokens >= currentTokens) {
        // No progress — stop to avoid infinite loop
        break;
      }
      currentTokens = newTokens;
    }

    // Final safety: if a single message still exceeds budget, truncate it
    if (flowMessages.length === 1 && countEffectiveTokens() > maxTokens) {
      const msg = flowMessages[0];
      if (msg.role === 'tool' && msg.content) {
        const maxChars = maxTokens * 4;
        if (msg.content.length > maxChars) {
          msg.content = msg.content.slice(0, maxChars - 3) + '...';
        }
      }
    }
  }

  /**
   * Find the oldest user+assistant pair and compress it into the state layer.
   * Returns true if a pair was compressed, false otherwise.
   */
  function compressOldestPairToState(): boolean {
    // Find the oldest user message followed by an assistant message
    for (let i = 0; i < flowMessages.length - 1; i++) {
      if (flowMessages[i].role === 'user' && flowMessages[i + 1].role === 'assistant') {
        const userContent = flowMessages[i].content ?? '';
        const assistantContent = flowMessages[i + 1].content ?? '';

        if (!state['compressed_history']) {
          state['compressed_history'] = [];
        }
        (state['compressed_history'] as Array<{ u: string; a: string }>).push({
          u: userContent.slice(0, 200),
          a: assistantContent.slice(0, 200),
        });
        // Keep only last 10 compressed entries
        const ch = state['compressed_history'] as unknown[];
        if (ch.length > 10) ch.shift();

        flowMessages.splice(i, 2);
        return true;
      }
    }

    // Fallback: try to remove the first message that isn't protected
    for (let i = 0; i < flowMessages.length; i++) {
      if (!isProtectedToolMessage(flowMessages[i])) {
        flowMessages.splice(i, 1);
        return true;
      }
    }

    // Nothing could be removed
    return false;
  }

  function scheduleSummarize(messageId: string, toolName: string, result: ToolResult): void {
    if (cancelled) return;

    const promise = summarizer
      .summarize(toolName, result)
      .then((summary) => {
        // Replace the tool message content in the flow layer
        for (const msg of flowMessages) {
          if (msg.role === 'tool' && msg.tool_call_id === messageId) {
            msg.content = summary;
            break;
          }
        }
      })
      .catch(() => {
        // Summary failed — original content stays, which is fine
      })
      .finally(() => {
        pendingSummaries.delete(messageId);
      });

    pendingSummaries.set(messageId, promise);
  }

  async function flushPendingSummaries(): Promise<void> {
    const promises = Array.from(pendingSummaries.values());
    await Promise.allSettled(promises);
  }

  function setState(key: string, value: unknown): void {
    state[key] = value;
  }

  function getState(): Record<string, unknown> {
    return { ...state };
  }

  function truncateTo(count: number): void {
    if (count < flowMessages.length) {
      flowMessages.length = count;
    }
  }

  function setKnowledge(content: string): void {
    knowledgeContent = content;
  }

  function cancelAll(): void {
    cancelled = true;
    summarizer.cancelAll();
  }

  return {
    append,
    assemble,
    scheduleSummarize,
    flushPendingSummaries,
    setState,
    getState,
    truncateTo,
    setKnowledge,
    cancelAll,
  };
}
