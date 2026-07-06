// src/sandbox/types.ts

export interface SandboxDomainConfig {
  extra_allowed_domains: string[];
  blocked_domains: string[];
}

export interface SandboxConfig {
  /** Whether sandbox isolation is enabled */
  enabled: boolean;
  /** Sandbox engine — currently only 'bwrap' */
  engine: 'bwrap';
  /** Additional user-specified paths to protect (beyond the built-in list) */
  extra_protect_paths: string[];
  /** When true and bwrap is unavailable, fall back to existing warn mode */
  fallback_to_warn: boolean;
  /** Domain allowlist/blocklist config for network proxy */
  domains?: SandboxDomainConfig;
}

export interface SandboxStatus {
  enabled: boolean;
  engine: string;
  bwrapAvailable: boolean;
  socatAvailable: boolean;
  proxyRunning: boolean;
  writablePaths: string[];
  protectPaths: string[];
}

export interface ValidationResult {
  ok: boolean;
  blocked: Array<{ hostPath: string; reason: string }>;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  engine: 'bwrap',
  extra_protect_paths: [],
  fallback_to_warn: true,
  domains: { extra_allowed_domains: [], blocked_domains: [] },
};
