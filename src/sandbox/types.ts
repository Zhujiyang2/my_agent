// src/sandbox/types.ts

export interface SandboxConfig {
  /** Whether sandbox isolation is enabled */
  enabled: boolean;
  /** Sandbox engine — currently only 'bwrap' */
  engine: 'bwrap';
  /** Additional user-specified paths to protect (beyond the built-in list) */
  extra_protect_paths: string[];
  /** When true and bwrap is unavailable, fall back to existing warn mode */
  fallback_to_warn: boolean;
}

export interface WritableRegistration {
  path: string;
  registeredAt: number;
}

export interface SandboxStatus {
  enabled: boolean;
  engine: string;
  bwrapAvailable: boolean;
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
};
