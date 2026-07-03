// src/config/types.ts

export interface ToolsConfig {
  max_loop_rounds: number;
  max_consecutive_failures: number;
  command_timeout: number;
  background_timeout: number;
}

export interface Config {
  api_url: string;
  model: string;
  api_key: string;
  tools: ToolsConfig;
}
