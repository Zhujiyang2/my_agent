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

  return {
    api_url: validateStringField('api_url'),
    model: validateStringField('model'),
    api_key: validateStringField('api_key'),
  };
}
