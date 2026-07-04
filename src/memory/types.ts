// src/memory/types.ts
export interface MemoryEntry {
  name: string;
  description: string;
  content: string;
  type: 'user' | 'agent';
}

/** On-disk frontmatter + body. */
export interface MemoryFile {
  name: string;
  description: string;
  metadata: {
    type: 'user' | 'agent';
    accessed_at: string;
    compressed: boolean;
  };
  body: string;
}

export interface MemoryConfig {
  enabled: boolean;
  user_budget: number;
  agent_budget: number;
  compress_threshold: number;
  memoryDir: string; // resolved path like ~/.my_agent/memory
}
