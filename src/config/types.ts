// src/config/types.ts

export interface ToolsConfig {
  safety_mode: 'confirm' | 'auto';
  max_loop_rounds: number;
  command_timeout: number;
  background_timeout: number;
}

export interface Config {
  api_url: string;
  model: string;
  api_key: string;
  tools: ToolsConfig;
}
