// src/sandbox/net-domains.ts
import fs from 'node:fs';
import { resolveProjectPath } from '../paths';

export interface SandboxDomainsConfig {
  extra_allowed_domains: string[];
  blocked_domains: string[];
}

export function loadSandboxDomains(filePath?: string): SandboxDomainsConfig {
  const resolvedPath = filePath ?? resolveProjectPath('.my_agent', 'sandbox-domains.json');

  if (!fs.existsSync(resolvedPath)) {
    return { extra_allowed_domains: [], blocked_domains: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  } catch {
    console.warn(`[sandbox] Invalid JSON in ${resolvedPath}, using empty domain config.`);
    return { extra_allowed_domains: [], blocked_domains: [] };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn(`[sandbox] ${resolvedPath} must contain a JSON object, using empty domain config.`);
    return { extra_allowed_domains: [], blocked_domains: [] };
  }

  const cfg = raw as Record<string, unknown>;

  return {
    extra_allowed_domains: filterStrings(cfg.extra_allowed_domains),
    blocked_domains: filterStrings(cfg.blocked_domains),
  };
}

function filterStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
