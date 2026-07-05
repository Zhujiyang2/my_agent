// src/memory/index.ts
import path from 'node:path';
import { estimateTokens } from '../context/token-counter';
import type { Message } from '../llm/types';
import { createMemoryStore, type MemoryStore } from './store';
import { encode, decode } from './sanitizer';
import { evictAgent } from './evictor';
import { assembleMemory } from './assembler';
import type { MemoryConfig, MemoryEntry, MemoryFile } from './types';

export type { MemoryConfig, MemoryEntry, MemoryFile } from './types';

export interface MemoryManager {
  assemble(): string | null;
  getUserWarnings(): string[];
  remember(entry: MemoryEntry): Promise<{ warnings: string[] }>;
  forget(name: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * Adapter: the underlying estimateTokens takes Message[] + model,
 * but evictor/assembler need (content: string) => number.
 */
function tokenCounter(content: string): number {
  const msg: Message = { role: 'user', content };
  return estimateTokens([msg], 'gpt-4o');
}

export function createMemoryManager(config: MemoryConfig): MemoryManager {
  const storeUser: MemoryStore = createMemoryStore(path.join(config.memoryDir, 'user'));
  const storeAgent: MemoryStore = createMemoryStore(path.join(config.memoryDir, 'agent'));
  let lastUserWarnings: string[] = [];

  function storeFor(type: 'user' | 'agent'): MemoryStore {
    return type === 'user' ? storeUser : storeAgent;
  }

  function assemble(): string | null {
    const names = [...storeUser.list(), ...storeAgent.list()];
    if (names.length === 0) {
      lastUserWarnings = [];
      return null;
    }

    const files: MemoryFile[] = [];
    const now = new Date().toISOString();
    for (const name of names) {
      // Try both stores (names are unique across user/agent dirs)
      const file = storeUser.read(name) ?? storeAgent.read(name);
      if (file) {
        // Decode reversible encodings so Agent sees real values
        file.body = decode(file.body);
        file.description = decode(file.description);
        // Update access time on disk (for LRU), touch only the frontmatter
        storeFor(file.metadata.type).updateAccessedAt(name, now);
        files.push(file);
      }
    }

    if (files.length === 0) {
      lastUserWarnings = [];
      return null;
    }

    const userFiles = files.filter(f => f.metadata.type === 'user');
    const agentFiles = files.filter(f => f.metadata.type === 'agent');

    const allFiles = [...userFiles, ...agentFiles];

    const result = assembleMemory(allFiles, {
      user_budget: config.user_budget,
      agent_budget: config.agent_budget,
    }, tokenCounter);

    lastUserWarnings = result.userWarnings;
    return result.content;
  }

  function getUserWarnings(): string[] {
    return lastUserWarnings;
  }

  async function remember(entry: MemoryEntry): Promise<{ warnings: string[] }> {
    const encodeResult = encode(entry.content, entry.description);
    if (encodeResult.isEmpty) {
      throw new Error(
        'Memory content is empty after sanitization. Please rephrase without sensitive information.',
      );
    }

    const now = new Date().toISOString();

    let accessedAt = now;
    const existing = storeFor(entry.type).read(entry.name);
    if (existing && entry.type === 'user') {
      accessedAt = existing.metadata.accessed_at;
    }

    const file: MemoryFile = {
      name: entry.name,
      description: entry.description,
      metadata: {
        type: entry.type,
        accessed_at: accessedAt,
        compressed: false,
      },
      body: encodeResult.content,
    };

    storeFor(entry.type).write(file);

    if (entry.type === 'agent') {
      const agentFiles = storeAgent.list()
        .map(n => storeAgent.read(n))
        .filter((f): f is MemoryFile => f !== null);

      const toRemove = evictAgent(agentFiles, config.agent_budget, tokenCounter);
      for (const name of toRemove) {
        storeAgent.delete(name);
      }
    }

    return { warnings: encodeResult.warnings };
  }

  async function forget(name: string): Promise<void> {
    storeUser.delete(name) || storeAgent.delete(name);
  }

  async function list(): Promise<string[]> {
    return [...storeUser.list(), ...storeAgent.list()];
  }

  return { assemble, getUserWarnings, remember, forget, list };
}
