// src/config/loader.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './types';

export function loadConfig(filePath?: string): Config {
  const resolvedPath = filePath ?? path.join(os.homedir(), '.my_agent', 'config.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found: ${resolvedPath}\nPlease create ~/.my_agent/config.json`
    );
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  let config: unknown;

  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${resolvedPath}`);
  }

  const cfg = config as Record<string, unknown>;

  if (!cfg.api_url || typeof cfg.api_url !== 'string') {
    throw new Error('Config is missing required field: api_url');
  }
  if (!cfg.model || typeof cfg.model !== 'string') {
    throw new Error('Config is missing required field: model');
  }
  if (!cfg.api_key || typeof cfg.api_key !== 'string') {
    throw new Error('Config is missing required field: api_key');
  }

  return { api_url: cfg.api_url, model: cfg.model, api_key: cfg.api_key };
}
