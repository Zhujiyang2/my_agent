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
}

export interface Config {
  api_url: string;
  model: string;
  api_key: string;
  tools: ToolsConfig;
  context: ContextConfig;
}
