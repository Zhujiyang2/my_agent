// src/config/types.ts

export interface ToolsConfig {
  max_loop_rounds: number;
  max_consecutive_failures: number;
  command_timeout: number;
  background_timeout: number;
}

export interface ContextConfig {
  max_context_tokens: number;   // 0 = auto (80% of model window)
  recent_rounds: number;        // 保留原始输出的轮数，默认 3
  systemPrompt?: string;        // persistent system prompt, survives /clear
}

export interface SubagentConfig {
  max_concurrent: number;
  default_timeout_ms: number;
  max_inbox_size: number;
}

export interface MemoryConfig {
  enabled: boolean;
  user_budget: number;
  agent_budget: number;
  compress_threshold: number;
}

export interface SandboxConfig {
  enabled: boolean;
  engine: 'bwrap';
  extra_protect_paths: string[];
  fallback_to_warn: boolean;
}

export interface Config {
  api_url: string;
  model: string;
  api_key: string;
  tools: ToolsConfig;
  context: ContextConfig;
  subagent: SubagentConfig;
  memory: MemoryConfig;
  sandbox: SandboxConfig;
}
