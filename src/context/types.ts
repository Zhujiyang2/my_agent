// src/context/types.ts
import type { Message } from '../llm/types';
import type { ToolResult } from '../tools/types';
import type { ContextConfig } from '../config/types';

export type { ContextConfig };

export interface Summarizer {
  /**
   * Generate a 1-2 sentence summary of a tool execution result.
   * Short outputs (< 200 chars) return the original content without an API call.
   * Returns the summary text (or original if too short).
   */
  summarize(toolName: string, result: ToolResult): Promise<string>;

  /** Cancel all in-flight summarization requests. */
  cancelAll(): void;
}

export interface ContextManager {
  /** Add a message to the flow layer. */
  append(message: Message): void;

  /**
   * Assemble the final messages array for the next LLM call.
   * Layers: knowledge → state → flow (with budget enforcement).
   * Tool messages with completed summaries use the summary version.
   */
  assemble(): Message[];

  /**
   * Trigger async LLM summarization of a tool result.
   * Returns immediately. When complete, replaces the tool message
   * identified by messageId in the history.
   */
  scheduleSummarize(messageId: string, toolName: string, result: ToolResult): void;

  /** Wait for all pending summarizations to complete (for testing). */
  flushPendingSummaries(): Promise<void>;

  /** Update a key in the state layer. */
  setState(key: string, value: unknown): void;

  /** Get the current state layer object. */
  getState(): Record<string, unknown>;

  /** Remove all messages after the first `count` messages (for error rollback). */
  truncateTo(count: number): void;

  /** Set the knowledge layer content (Phase 2). */
  setKnowledge(content: string): void;

  /** Cancel all pending work (for Ctrl+C). */
  cancelAll(): void;
}
