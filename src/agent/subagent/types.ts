// src/agent/subagent/types.ts

import type { Message } from '../../llm/types';

export interface ToolEvidence {
  tool: string;
  exitCode?: number;
  keyOutput?: string;
  isError?: boolean;
}

export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface SubagentResult {
  status: SubagentStatus;
  exitCode: number;
  llmSummary: string;
  evidence: ToolEvidence[];
  keyOutputs: string[];
  metrics: { rounds: number; tokensUsed: number; durationMs: number };
  fullTranscriptId: string;
}

export interface SubagentStatusEntry {
  id: string;
  status: SubagentStatus;
  taskSummary: string;
  durationMs: number;
  tokensUsed: number;
  messageCount: number;
}

export type SubagentEvent =
  | { type: 'tool_start'; tool: string; detail: string }
  | { type: 'tool_done'; tool: string; exitCode: number; durationMs: number }
  | { type: 'heartbeat'; message: string }
  | { type: 'token'; token: string }
  | { type: 'error'; message: string };

export interface SubagentMessage {
  id: string;
  from: string;
  to: string;
  type: 'info' | 'alert' | 'request' | 'response';
  payload: string;
  timestamp: number;
}

export interface SubagentSpawnConfig {
  task: string;
  tools?: string[];
  model?: string;
  timeoutMs?: number;
  node?: string;
  maxTokens?: number;
}

export interface SubagentHandle {
  id: string;
  status: SubagentStatus;
  spawnConfig: SubagentSpawnConfig;
  result: SubagentResult | null;
  events: SubagentEvent[];
  inbox: SubagentMessage[];
  createdAt: number;
  startedAt: number | null;
  abortController: AbortController;
  transcript: Message[];
  onEvent?: (event: SubagentEvent) => void;
}
