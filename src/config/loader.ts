// src/config/loader.ts
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './types';
import { resolveProjectPath } from '../paths';

export function loadConfig(filePath?: string): Config {
  const resolvedPath = filePath ?? resolveProjectPath('.my_agent', 'config.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found: ${resolvedPath}\nPlease create .my_agent/config.json in the project root`
    );
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  let config: unknown;

  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${resolvedPath}`);
  }

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`Config file must contain a JSON object: ${resolvedPath}`);
  }

  const cfg = config as Record<string, unknown>;

  function validateStringField(field: string): string {
    const value = cfg[field];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Config is missing required field: ${field}`);
    }
    if (typeof value !== 'string') {
      throw new Error(`Config field '${field}' must be a string, got ${typeof value}`);
    }
    return value as string;
  }

  const toolsCfg = (cfg.tools as Record<string, unknown> | undefined) ?? {};
  const contextCfg = (cfg.context as Record<string, unknown> | undefined) ?? {};
  const subagentCfg = (cfg.subagent as Record<string, unknown> | undefined) ?? {};
  const memoryCfg = (cfg.memory as Record<string, unknown> | undefined) ?? {};
  const sandboxCfg = (cfg.sandbox as Record<string, unknown> | undefined) ?? {};

  return {
    api_url: validateStringField('api_url'),
    model: validateStringField('model'),
    api_key: validateStringField('api_key'),
    tools: {
      max_loop_rounds:
        typeof toolsCfg.max_loop_rounds === 'number' ? toolsCfg.max_loop_rounds : 0,
      max_consecutive_failures:
        typeof toolsCfg.max_consecutive_failures === 'number' ? toolsCfg.max_consecutive_failures : 5,
      command_timeout:
        typeof toolsCfg.command_timeout === 'number' ? toolsCfg.command_timeout : 60,
      background_timeout:
        typeof toolsCfg.background_timeout === 'number' ? toolsCfg.background_timeout : 0,
    },
    context: {
      max_context_tokens:
        typeof contextCfg.max_context_tokens === 'number' ? contextCfg.max_context_tokens : 0,
      recent_rounds:
        typeof contextCfg.recent_rounds === 'number' ? contextCfg.recent_rounds : 3,
    },
    subagent: {
      max_concurrent:
        typeof subagentCfg.max_concurrent === 'number' ? subagentCfg.max_concurrent : 8,
      default_timeout_ms:
        typeof subagentCfg.default_timeout_ms === 'number' ? subagentCfg.default_timeout_ms : 600_000,
      max_inbox_size:
        typeof subagentCfg.max_inbox_size === 'number' ? subagentCfg.max_inbox_size : 50,
    },
    memory: {
      enabled: typeof memoryCfg.enabled === 'boolean' ? memoryCfg.enabled : true,
      user_budget: typeof memoryCfg.user_budget === 'number' ? memoryCfg.user_budget : 4000,
      agent_budget: typeof memoryCfg.agent_budget === 'number' ? memoryCfg.agent_budget : 2000,
      compress_threshold: typeof memoryCfg.compress_threshold === 'number' ? memoryCfg.compress_threshold : 5,
    },
    sandbox: {
      enabled: typeof sandboxCfg.enabled === 'boolean' ? sandboxCfg.enabled : true,
      engine: 'bwrap',
      extra_protect_paths:
        Array.isArray(sandboxCfg.extra_protect_paths)
          ? sandboxCfg.extra_protect_paths.filter((p): p is string => typeof p === 'string')
          : [],
      fallback_to_warn:
        typeof sandboxCfg.fallback_to_warn === 'boolean' ? sandboxCfg.fallback_to_warn : true,
    },
  };
}
