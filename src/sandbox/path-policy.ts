// src/sandbox/path-policy.ts
import os from 'node:os';
import path from 'node:path';

const BUILTIN_PROTECT_PATHS = [
  `${os.homedir()}/.ssh`,
  `${os.homedir()}/.aws/credentials`,
  `${os.homedir()}/.kube/config`,
  `${os.homedir()}/.gitconfig`,
  `${os.homedir()}/.docker/config.json`,
  `${os.homedir()}/.config/gcloud`,
  '/etc/shadow',
  '/etc/ssl/private',
  '/root',
  '/proc/sys',
  '/sys/kernel',
];

const SYSTEM_CRITICAL_PREFIXES = ['/etc', '/boot', '/sys', '/proc'];

export interface PathPolicy {
  classify(filePath: string): 'protect' | 'writable' | 'explore';
  registerWritable(filePath: string): { ok: boolean; error?: string };
  unregisterWritable(filePath: string): void;
  getWritablePaths(): string[];
  getProtectPaths(): string[];
}

export function createPathPolicy(
  options?: { extraProtectPaths?: string[] }
): PathPolicy {
  const protectPaths = [...BUILTIN_PROTECT_PATHS, ...(options?.extraProtectPaths ?? [])];
  const writablePaths = new Set<string>();

  function isUnder(filePath: string, parent: string): boolean {
    const resolved = path.resolve(filePath);
    const resolvedParent = path.resolve(parent);
    if (resolved === resolvedParent) return true;
    const rel = path.relative(resolvedParent, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  function isSystemCritical(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return SYSTEM_CRITICAL_PREFIXES.some(
      (prefix) => {
        const resolvedPrefix = path.resolve(prefix);
        return resolved === resolvedPrefix || resolved.startsWith(resolvedPrefix + path.sep);
      }
    );
  }

  return {
    classify(filePath: string): 'protect' | 'writable' | 'explore' {
      const resolved = path.resolve(filePath);

      // Check /tmp first — always writable
      const resolvedTmp = path.resolve('/tmp');
      if (resolved === resolvedTmp || resolved.startsWith(resolvedTmp + path.sep)) {
        return 'writable';
      }

      // Check writable registrations
      for (const wp of writablePaths) {
        if (isUnder(resolved, wp)) {
          return 'writable';
        }
      }

      // Check protect paths
      for (const pp of protectPaths) {
        if (isUnder(resolved, pp)) {
          return 'protect';
        }
      }

      return 'explore';
    },

    registerWritable(filePath: string): { ok: boolean; error?: string } {
      const resolved = path.resolve(filePath);

      if (isSystemCritical(resolved)) {
        return {
          ok: false,
          error: `Path "${resolved}" is in a system-critical location and cannot be made writable.`,
        };
      }

      for (const pp of protectPaths) {
        if (isUnder(resolved, pp)) {
          return {
            ok: false,
            error: `Path "${resolved}" is in a protected location (${pp}) and cannot be made writable.`,
          };
        }
      }

      writablePaths.add(resolved);
      return { ok: true };
    },

    unregisterWritable(filePath: string): void {
      const resolved = path.resolve(filePath);
      writablePaths.delete(resolved);
    },

    getWritablePaths(): string[] {
      return Array.from(writablePaths);
    },

    getProtectPaths(): string[] {
      return [...protectPaths];
    },
  };
}
