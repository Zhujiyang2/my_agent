// src/config/types.ts

export interface ToolsConfig {
  max_loop_rounds: number;
  max_consecutive_failures: number;
  command_timeout: number;
  background_timeout: number;
}

export interface ContextConfig {
  max_context_tokens: number;   // 0 = auto (80% of model window)
  flow_rounds: number;
  summarizer_model: string;     // "" = reuse main model
}

export interface Config {
  api_url: string;
  model: string;
  api_key: string;
  tools: ToolsConfig;
  context: ContextConfig;
}
