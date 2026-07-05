// src/memory/index.ts
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
  const store: MemoryStore = createMemoryStore(config.memoryDir);
  let lastUserWarnings: string[] = [];

  function assemble(): string | null {
    const names = store.list();
    if (names.length === 0) {
      lastUserWarnings = [];
      return null;
    }

    const files: MemoryFile[] = [];
    const now = new Date().toISOString();
    for (const name of names) {
      const file = store.read(name);
      if (file) {
        // Decode reversible encodings so Agent sees real values
        file.body = decode(file.body);
        file.description = decode(file.description);
        // Update access time on disk (for LRU), touch only the frontmatter
        store.updateAccessedAt(name, now);
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
    const existing = store.read(entry.name);
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

    store.write(file);

    if (entry.type === 'agent') {
      const allFiles = store.list()
        .map(n => store.read(n))
        .filter((f): f is MemoryFile => f !== null && f.metadata.type === 'agent');

      const toRemove = evictAgent(allFiles, config.agent_budget, tokenCounter);
      for (const name of toRemove) {
        store.delete(name);
      }
    }

    return { warnings: encodeResult.warnings };
  }

  async function forget(name: string): Promise<void> {
    store.delete(name);
  }

  async function list(): Promise<string[]> {
    return store.list();
  }

  return { assemble, getUserWarnings, remember, forget, list };
}
