// src/agent/subagent/manager.ts
import { createAgent } from '../loop';
import type { AgentSession } from '../loop';
import type { Config } from '../../config/types';
import type { Message } from '../../llm/types';
import { createRegistry } from '../../tools/registry';
import type { ToolRegistry } from '../../tools/registry';
import { createContextManager } from '../../context/manager';
import { createMessageInjector } from './context-decorator';
import { runCommandTool } from '../../tools/shell/run-command';
import { globTool } from '../../tools/files/glob';
import { readFileTool } from '../../tools/files/read-file';
import { writeFileTool } from '../../tools/files/write-file';
import { createManageContextTool } from '../../tools/context/manage-context';
import type {
  SubagentResult,
  SubagentStatusEntry,
  SubagentSpawnConfig,
  SubagentHandle,
  SubagentMessage,
  SubagentStatus,
  ToolEvidence,
} from './types';

const DEFAULT_TOOLS = ['run_command', 'read_file', 'write_file', 'glob'];

function generateId(): string {
  return `sa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

const TOOL_MAP: Record<string, typeof runCommandTool> = {
  run_command: runCommandTool,
  glob: globTool,
  read_file: readFileTool,
  write_file: writeFileTool,
};

function buildSubagentRegistry(
  toolNames: string[],
  subagentId: string,
  node?: string,
): ToolRegistry {
  const registry = createRegistry();

  for (const name of toolNames) {
    const base = TOOL_MAP[name];
    if (!base) continue;

    if (name === 'run_command' && node) {
      registry.register({
        name: 'run_command',
        description: base.description,
        parameters: base.parameters,
        handler: async (params: Record<string, unknown>) => {
          const command = String(params.command ?? '');
          const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const sshCommand = `ssh ${node} "${escaped}"`;
          return base.handler({ ...params, command: sshCommand });
        },
      });
    } else {
      registry.register({ ...base });
    }
  }

  // send_message is always available to subagents
  registry.register({
    name: 'send_message',
    description:
      'Send a message to another sub-agent, the main agent, or broadcast to all. ' +
      'Use this to alert others of failures, share discovered information, or coordinate.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "Target sub-agent ID, 'main', or 'all'." },
        type: { type: 'string', description: 'Message type.', enum: ['info', 'alert', 'request', 'response'] },
        payload: { type: 'string', description: 'Message body.' },
      },
      required: ['to', 'type', 'payload'],
    },
    handler: async (params: Record<string, unknown>) => {
      const mgr = getSubagentManager();
      const msg: SubagentMessage = {
        id: generateMessageId(),
        from: subagentId,
        to: String(params.to ?? ''),
        type: (params.type as SubagentMessage['type']) ?? 'info',
        payload: String(params.payload ?? ''),
        timestamp: Date.now(),
      };
      mgr.routeMessage(msg);
      return {
        content: `Message sent to ${msg.to}.`,
        summary: `sent ${msg.type} to ${msg.to}`,
        exitCode: 0,
      };
    },
  });

  return registry;
}

function extractExitCodeFromContent(content: string | null): number {
  if (!content) return 0;
  const match = content.match(/exit code:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function buildEvidence(history: readonly Message[]): ToolEvidence[] {
  const evidence: ToolEvidence[] = [];
  for (const msg of history) {
    if (msg.role === 'tool') {
      const c = msg.content ?? '';
      evidence.push({
        tool: msg.name ?? 'unknown',
        exitCode: extractExitCodeFromContent(c),
        keyOutput: c.slice(0, 300),
        isError: c.includes('exit code:') && !c.includes('exit code: 0'),
      });
    }
  }
  return evidence;
}

function extractKeyOutputs(evidence: ToolEvidence[]): string[] {
  return evidence.filter(e => e.keyOutput && !e.isError).map(e => e.keyOutput!).slice(-5);
}

function finalStatusFromError(msg: string): SubagentStatus {
  if (msg === 'TIMEOUT') return 'timeout';
  if (msg === 'ABORTED') return 'cancelled';
  return 'failed';
}

export class SubagentManager {
  private pool: Map<string, SubagentHandle> = new Map();
  private config: Config;
  private maxConcurrent: number;
  private defaultTimeoutMs: number;
  private maxInboxSize: number;
  private mainInbox: SubagentMessage[] = [];
  private pendingQueue: Array<() => void> = [];
  private destroyed = false;

  // Internal state — not exposed on SubagentHandle
  private agents: Map<string, AgentSession> = new Map();
  private subConfigs: Map<string, Config> = new Map();
  private tokensUsed: Map<string, number> = new Map();
  private roundCounts: Map<string, number> = new Map();

  constructor(config: Config) {
    this.config = config;
    this.maxConcurrent = config.subagent.max_concurrent;
    this.defaultTimeoutMs = config.subagent.default_timeout_ms;
    this.maxInboxSize = config.subagent.max_inbox_size;
  }

  private activeCount(): number {
    let count = 0;
    for (const h of this.pool.values()) {
      if (h.status === 'running') count++;
    }
    return count;
  }

  private async acquireSlot(): Promise<boolean> {
    if (this.activeCount() < this.maxConcurrent) return true;
    if (this.destroyed) return false;

    return new Promise<boolean>((resolve) => {
      this.pendingQueue.push(() => resolve(!this.destroyed));
    });
  }

  private releaseSlot(): void {
    const next = this.pendingQueue.shift();
    if (next) next();
  }

  /** Fire-and-forget: create + start subagent, return immediately. */
  spawn(spawnConfig: SubagentSpawnConfig): SubagentResult {
    const id = generateId();
    const toolNames = spawnConfig.tools ?? DEFAULT_TOOLS;

    // Synchronously acquire slot if available
    const slotAvailable = this.activeCount() < this.maxConcurrent;

    const handle: SubagentHandle = {
      id,
      status: slotAvailable ? 'running' : 'pending',
      spawnConfig,
      result: null,
      events: [],
      inbox: [],
      createdAt: Date.now(),
      startedAt: slotAvailable ? Date.now() : null,
      abortController: new AbortController(),
      transcript: [],
    };
    this.pool.set(id, handle);

    // Synchronous: init agent (createAgent may throw)
    if (handle.status === 'running') {
      try {
        this.initAgentSync(handle, toolNames);
      } catch (e) {
        handle.status = 'failed';
        handle.result = {
          status: 'failed',
          exitCode: 1,
          id: handle.id,
          llmSummary: `Creation failed: ${e instanceof Error ? e.message : String(e)}`,
          evidence: [],
          keyOutputs: [],
          metrics: { rounds: 0, tokensUsed: 0, durationMs: Date.now() - (handle.startedAt ?? handle.createdAt) },
          fullTranscriptId: handle.id,
        };
        return {
          status: 'failed',
          exitCode: 1,
          id,
          llmSummary: handle.result.llmSummary,
          evidence: [],
          keyOutputs: [],
          metrics: { rounds: 0, tokensUsed: 0, durationMs: 0 },
          fullTranscriptId: id,
        };
      }
    }

    // Async: run the agent loop in background
    this.runAgentLoop(handle).catch(() => {
      // Errors already captured in handle.result
    });

    return {
      status: handle.status,
      exitCode: 0,
      id,
      llmSummary: `Sub-agent spawned${handle.status === 'pending' ? ' (queued)' : ''}: ${spawnConfig.task.slice(0, 80)}`,
      evidence: [],
      keyOutputs: [],
      metrics: { rounds: 0, tokensUsed: 0, durationMs: 0 },
      fullTranscriptId: id,
    };
  }

  /**
   * Synchronous part: creates the agent session.
   * Extracted so spawn() can catch errors before returning.
   */
  private initAgentSync(handle: SubagentHandle, toolNames: string[]): void {
    const { model, maxTokens, node } = handle.spawnConfig;

    const subConfig: Config = { ...this.config, model: model ?? this.config.model };
    const registry = buildSubagentRegistry(toolNames, handle.id, node);
    const baseCm = createContextManager(this.config.context, subConfig.model);
    const contextManager = createMessageInjector(baseCm, () => handle.inbox);

    // manage_context operates on the subagent's own context
    if (!registry.get('manage_context')) {
      registry.register(createManageContextTool(contextManager));
    }

    this.tokensUsed.set(handle.id, 0);
    this.roundCounts.set(handle.id, 0);

    const agent = createAgent(subConfig, {
      registry,
      contextManager,
      onToken: () => { this.tokensUsed.set(handle.id, (this.tokensUsed.get(handle.id) ?? 0) + 1); },
      onToolCall: (name: string, args: Record<string, unknown>) => {
        this.roundCounts.set(handle.id, (this.roundCounts.get(handle.id) ?? 0) + 1);
        const detail = Object.entries(args)
          .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
          .join(', ');
        handle.events.push({ type: 'tool_start', tool: name, detail });
        handle.onEvent?.({ type: 'tool_start', tool: name, detail });

        if (maxTokens && (this.tokensUsed.get(handle.id) ?? 0) >= maxTokens) {
          handle.abortController.abort();
        }
      },
    });

    this.agents.set(handle.id, agent);
    this.subConfigs.set(handle.id, subConfig);
  }

  private async runAgentLoop(handle: SubagentHandle): Promise<void> {
    // Wait for slot if pending
    if (handle.status === 'pending') {
      const acquired = await this.acquireSlot();
      if (!acquired || handle.abortController.signal.aborted) {
        handle.status = 'cancelled';
        handle.result = {
          status: 'cancelled', exitCode: 1,
          llmSummary: 'Cancelled before execution.',
          evidence: [], keyOutputs: [],
          metrics: { rounds: 0, tokensUsed: 0, durationMs: Date.now() - handle.createdAt },
          id: handle.id,
          fullTranscriptId: handle.id,
        };
        return;
      }
      handle.status = 'running';
      handle.startedAt = Date.now();

      // Lazy-init agent for pending→running transitions
      try {
        this.initAgentSync(handle, handle.spawnConfig.tools ?? DEFAULT_TOOLS);
      } catch (e) {
        handle.status = 'failed';
        handle.result = {
          status: 'failed',
          exitCode: 1,
          llmSummary: `Creation failed: ${e instanceof Error ? e.message : String(e)}`,
          evidence: [],
          keyOutputs: [],
          metrics: { rounds: 0, tokensUsed: 0, durationMs: Date.now() - (handle.startedAt ?? handle.createdAt) },
          id: handle.id,
          fullTranscriptId: handle.id,
        };
        this.releaseSlot();
        return;
      }
    }

    const agent: AgentSession = this.agents.get(handle.id)!;
    const startTime = handle.startedAt ?? Date.now();
    const { task, timeoutMs } = handle.spawnConfig;
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('TIMEOUT')), effectiveTimeout);
      });

      const abortPromise = new Promise<never>((_, reject) => {
        const check = () => {
          if (handle.abortController.signal.aborted) reject(new Error('ABORTED'));
          else setTimeout(check, 50);
        };
        check();
      });

      const finalText = await Promise.race([
        agent.send(task, handle.abortController.signal),
        timeoutPromise,
        abortPromise,
      ]);

      const history = [...agent.history];
      handle.transcript = history;
      const evidence = buildEvidence(history);
      const overallExitCode = evidence.some(e => e.isError) ? 1 : 0;
      const tokensUsed = this.tokensUsed.get(handle.id) ?? 0;
      const roundCount = this.roundCounts.get(handle.id) ?? 0;

      handle.result = {
        status: 'completed',
        exitCode: overallExitCode,
        llmSummary: finalText.slice(0, 500),
        evidence,
        keyOutputs: extractKeyOutputs(evidence),
        metrics: { rounds: roundCount, tokensUsed, durationMs: Date.now() - startTime },
        id: handle.id,
        fullTranscriptId: handle.id,
      };
      handle.status = 'completed';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = finalStatusFromError(msg);
      const history = [...(agent?.history ?? [])];
      const evidence = buildEvidence(history);
      const tokensUsed = this.tokensUsed.get(handle.id) ?? 0;
      const roundCount = this.roundCounts.get(handle.id) ?? 0;

      handle.result = {
        status,
        exitCode: 1,
        llmSummary: status === 'timeout'
          ? `Timed out after ${effectiveTimeout}ms.`
          : status === 'cancelled'
            ? 'Cancelled.'
            : msg,
        evidence,
        keyOutputs: extractKeyOutputs(evidence),
        metrics: { rounds: roundCount, tokensUsed, durationMs: Date.now() - startTime },
        id: handle.id,
        fullTranscriptId: handle.id,
      };
      handle.status = status;
    } finally {
      this.releaseSlot();
    }
  }

  // ── Message Routing ──

  routeMessage(msg: SubagentMessage): void {
    if (msg.to === 'main') {
      this.mainInbox.push(msg);
      if (this.mainInbox.length > 100) this.mainInbox.shift();
      return;
    }

    if (msg.to === 'all') {
      for (const h of this.pool.values()) {
        this.pushToInbox(h, msg);
      }
      this.mainInbox.push(msg);
      if (this.mainInbox.length > 100) this.mainInbox.shift();
      return;
    }

    const target = this.pool.get(msg.to);
    if (target) {
      this.pushToInbox(target, msg);
    }
    // unknown target → silent drop
  }

  private pushToInbox(handle: SubagentHandle, msg: SubagentMessage): void {
    handle.inbox.push(msg);
    while (handle.inbox.length > this.maxInboxSize) {
      handle.inbox.shift();
    }
  }

  getMainInbox(): SubagentMessage[] {
    return [...this.mainInbox];
  }

  getMainInboxSince(sinceId?: string): { messages: SubagentMessage[]; latestId: string | null } {
    if (!sinceId) {
      return {
        messages: [...this.mainInbox],
        latestId: this.mainInbox.length > 0 ? this.mainInbox[this.mainInbox.length - 1].id : null,
      };
    }

    let startIdx = -1;
    for (let i = 0; i < this.mainInbox.length; i++) {
      if (this.mainInbox[i].id === sinceId) { startIdx = i + 1; break; }
    }
    const messages = startIdx >= 0 ? this.mainInbox.slice(startIdx) : [...this.mainInbox];
    return {
      messages,
      latestId: messages.length > 0 ? messages[messages.length - 1].id : null,
    };
  }

  // ── Query ──

  list(): SubagentStatusEntry[] {
    const entries: SubagentStatusEntry[] = [];
    for (const h of this.pool.values()) {
      entries.push({
        id: h.id,
        status: h.status,
        taskSummary: h.spawnConfig.task.slice(0, 100),
        durationMs: h.startedAt ? Date.now() - h.startedAt : 0,
        tokensUsed: h.result?.metrics.tokensUsed ?? 0,
        messageCount: h.inbox.length,
      });
    }
    return entries;
  }

  kill(id: string): boolean {
    const handle = this.pool.get(id);
    if (!handle) return false;
    if (handle.status !== 'running' && handle.status !== 'pending') return false;
    handle.abortController.abort();
    return true;
  }

  result(id: string): SubagentResult | null {
    const handle = this.pool.get(id);
    if (!handle) return null;
    return handle.result;
  }

  transcript(id: string): Message[] | null {
    const handle = this.pool.get(id);
    if (!handle) return null;
    return handle.transcript.length > 0 ? [...handle.transcript] : null;
  }

  destroy(): void {
    this.destroyed = true;
    for (const h of this.pool.values()) {
      if (h.status === 'running' || h.status === 'pending') {
        h.abortController.abort();
        h.status = 'cancelled';
        if (!h.result) {
          h.result = {
            id: h.id,
            status: 'cancelled',
            exitCode: 1,
            llmSummary: 'Cancelled (manager destroyed).',
            evidence: [],
            keyOutputs: [],
            metrics: { rounds: 0, tokensUsed: this.tokensUsed.get(h.id) ?? 0, durationMs: Date.now() - h.createdAt },
            fullTranscriptId: h.id,
          };
        }
      }
    }
  }
}

// ── Singleton ──

let managerInstance: SubagentManager | null = null;

export function setSubagentManager(mgr: SubagentManager): void {
  managerInstance = mgr;
}

export function getSubagentManager(): SubagentManager {
  if (!managerInstance) {
    throw new Error('SubagentManager not initialized. Call setSubagentManager() first.');
  }
  return managerInstance;
}
