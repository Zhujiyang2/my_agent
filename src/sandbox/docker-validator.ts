// src/sandbox/docker-validator.ts
import type { PathPolicy } from './path-policy';
import type { ValidationResult } from './types';

const SYSTEM_COMMON_READONLY_PREFIXES = [
  '/etc/localtime',
  '/etc/hosts',
  '/etc/hostname',
  '/etc/resolv.conf',
  '/etc/timezone',
  '/etc/nsswitch.conf',
  '/etc/passwd',
  '/etc/group',
  '/usr/share/zoneinfo',
];

function isDockerCommand(command: string): boolean {
  const trimmed = command.trimStart();
  // Match docker run/create as a standalone word (handles sudo, /usr/bin/, env prefixes).
  // But exclude compound commands like "docker images; docker run ..."
  return /\bdocker\s+(run|create)\b/.test(trimmed) && !/[;&|]/.test(trimmed);
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  mode: string; // 'rw' | 'ro'
}

function parseVolumeMounts(command: string): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  // Match -v / --volume flags (with or without space after flag)
  // Pattern: -v HOST:CONTAINER[:MODE] or -v/HOST:CONTAINER[:MODE]
  // Also: --volume HOST:CONTAINER[:MODE] or --volume=HOST:CONTAINER[:MODE]
  const vPattern = /(?:-v|--volume)[\s=]?(\S+?):(\S+?)(?::(ro|rw|z|Z))?(?:\s|$)/g;
  let match;
  while ((match = vPattern.exec(command)) !== null) {
    mounts.push({
      hostPath: match[1],
      containerPath: match[2],
      mode: match[3] || 'rw',
    });
  }

  // Match --mount flags (with or without space/equals after flag)
  // Pattern: --mount type=bind,... or --mount=type=bind,...
  // Supports source=/src=/dst=/destination= aliases
  const mountPattern = /--mount[\s=]?([^-\s]\S*)/g;
  while ((match = mountPattern.exec(command)) !== null) {
    const opts = match[1];
    if (!opts.includes('type=bind') && !opts.startsWith('type=bind')) continue;

    // Source: "source=" or "src="
    const srcMatch = opts.match(/(?:^|,)(?:source|src)=([^,]+)/);
    // Target: "target=" or "dst=" or "destination="
    const dstMatch = opts.match(/(?:^|,)(?:target|dst|destination)=([^,]+)/);
    const roMatch = /\breadonly\b/.test(opts);

    if (srcMatch && dstMatch) {
      mounts.push({
        hostPath: srcMatch[1],
        containerPath: dstMatch[1],
        mode: roMatch ? 'ro' : 'rw',
      });
    }
  }

  return mounts;
}

function createDockerValidator(policy: PathPolicy) {
  return {
    validate(command: string): ValidationResult {
      const mounts = parseVolumeMounts(command);

      if (mounts.length === 0) {
        return { ok: true, blocked: [] };
      }

      const blocked: Array<{ hostPath: string; reason: string }> = [];

      for (const m of mounts) {
        const classification = policy.classify(m.hostPath);

        if (classification === 'protect') {
          blocked.push({
            hostPath: m.hostPath,
            reason: `Path "${m.hostPath}" is in the protect list (credentials/system files) and cannot be mounted into a container.`,
          });
          continue;
        }

        if (classification === 'writable') {
          continue; // Allowed
        }

        // Check system common read-only paths
        if (
          SYSTEM_COMMON_READONLY_PREFIXES.some(
            (prefix) => m.hostPath === prefix || m.hostPath.startsWith(prefix + '/')
          )
        ) {
          continue; // Allowed (system read-only paths are safe to mount)
        }

        // Default: not allowed
        blocked.push({
          hostPath: m.hostPath,
          reason:
            `Path "${m.hostPath}" is not in the writable allowlist or system common paths. ` +
            `Use register_writable_path to allow it, or mount a path under the registered workspace.`,
        });
      }

      return { ok: blocked.length === 0, blocked };
    },
  };
}

export { isDockerCommand, parseVolumeMounts, createDockerValidator, SYSTEM_COMMON_READONLY_PREFIXES };
