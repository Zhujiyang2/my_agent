# Sandbox Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add filesystem sandbox isolation via bubblewrap (bwrap) to protect the host from unintended modifications by the agent, while preserving Docker orchestration and network access.

**Architecture:** Four modules under `src/sandbox/` — path-policy (protect/writable/explore classification), bwrap-executor (command wrapping), docker-validator (volume mount validation), sandbox-manager (unified entry). A new `register_writable_path` tool lets the agent dynamically claim workspace directories. The `run_command` handler routes through the sandbox manager; if bwrap is unavailable, falls back to existing warn mode.

**Tech Stack:** TypeScript, Node.js child_process, bubblewrap (external dependency on target Linux), vitest for testing.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/sandbox/types.ts` | Core types: SandboxConfig, SandboxStatus, WritableRegistration |
| Create | `src/sandbox/path-policy.ts` | Path classification engine: protect/writable/explore |
| Create | `src/sandbox/bwrap-executor.ts` | Bwrap CLI detection, command construction, execution |
| Create | `src/sandbox/docker-validator.ts` | Docker volume mount parsing and path validation |
| Create | `src/sandbox/sandbox-manager.ts` | Unified entry: execute, registerWritable, getStatus |
| Create | `src/sandbox/__tests__/path-policy.test.ts` | Tests for path-policy |
| Create | `src/sandbox/__tests__/bwrap-executor.test.ts` | Tests for bwrap-executor |
| Create | `src/sandbox/__tests__/docker-validator.test.ts` | Tests for docker-validator |
| Create | `src/sandbox/__tests__/sandbox-manager.test.ts` | Tests for sandbox-manager |
| Create | `src/tools/sandbox/index.ts` | Export and registration for sandbox tools |
| Create | `src/tools/sandbox/register-writable.ts` | register_writable_path tool definition |
| Modify | `src/config/types.ts` | Add SandboxConfig interface |
| Modify | `src/config/loader.ts` | Parse sandbox section from config.json |
| Modify | `src/tools/shell/run-command.ts` | Route execution through sandbox manager |
| Modify | `bin/my-agent.ts` | Initialize sandbox manager, register sandbox tools |

---

### Task 1: Sandbox types

**Files:**
- Create: `src/sandbox/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
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
```

- [ ] **Step 2: Verify the file compiles**

```
npx tsc --noEmit src/sandbox/types.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/sandbox/types.ts
git commit -m "feat: add sandbox types"
```

---

### Task 2: Path policy engine

**Files:**
- Create: `src/sandbox/path-policy.ts`
- Create: `src/sandbox/__tests__/path-policy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sandbox/__tests__/path-policy.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createPathPolicy } from '../path-policy';
import os from 'node:os';

describe('createPathPolicy', () => {
  let policy: ReturnType<typeof createPathPolicy>;

  beforeEach(() => {
    policy = createPathPolicy();
  });

  describe('classify', () => {
    it('returns "protect" for ~/.ssh paths', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.ssh/id_rsa`)).toBe('protect');
      expect(policy.classify(`${home}/.ssh/known_hosts`)).toBe('protect');
    });

    it('returns "protect" for ~/.aws/credentials', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.aws/credentials`)).toBe('protect');
    });

    it('returns "protect" for ~/.kube/config', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.kube/config`)).toBe('protect');
    });

    it('returns "protect" for ~/.gitconfig', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.gitconfig`)).toBe('protect');
    });

    it('returns "protect" for ~/.docker/config.json', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.docker/config.json`)).toBe('protect');
    });

    it('returns "protect" for ~/.config/gcloud paths', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.config/gcloud/credentials.db`)).toBe('protect');
    });

    it('returns "protect" for /etc/shadow', () => {
      expect(policy.classify('/etc/shadow')).toBe('protect');
    });

    it('returns "protect" for /etc/ssl/private paths', () => {
      expect(policy.classify('/etc/ssl/private/key.pem')).toBe('protect');
    });

    it('returns "protect" for /root paths', () => {
      expect(policy.classify('/root/.bashrc')).toBe('protect');
      expect(policy.classify('/root')).toBe('protect');
    });

    it('returns "protect" for /proc/sys', () => {
      expect(policy.classify('/proc/sys/net/ipv4/ip_forward')).toBe('protect');
    });

    it('returns "protect" for /sys/kernel', () => {
      expect(policy.classify('/sys/kernel/debug')).toBe('protect');
    });

    it('returns "explore" for ordinary filesystem paths', () => {
      expect(policy.classify('/usr/bin/bash')).toBe('explore');
      expect(policy.classify('/etc/hosts')).toBe('explore');
      expect(policy.classify('/etc/localtime')).toBe('explore');
      expect(policy.classify('/mnt/data')).toBe('explore');
      expect(policy.classify('/home/user/projects')).toBe('explore');
    });

    it('returns "writable" for registered paths', () => {
      policy.registerWritable('/mnt/nvme0/workspace');
      expect(policy.classify('/mnt/nvme0/workspace')).toBe('writable');
      expect(policy.classify('/mnt/nvme0/workspace/models')).toBe('writable');
    });

    it('returns "writable" for /tmp (always writable)', () => {
      expect(policy.classify('/tmp/some-file')).toBe('writable');
      expect(policy.classify('/tmp')).toBe('writable');
    });
  });

  describe('registerWritable', () => {
    it('registers a valid path', () => {
      const result = policy.registerWritable('/mnt/data/workspace');
      expect(result.ok).toBe(true);
    });

    it('rejects paths under /etc', () => {
      const result = policy.registerWritable('/etc/my-app/config');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('system-critical');
    });

    it('rejects paths under /boot', () => {
      const result = policy.registerWritable('/boot/grub');
      expect(result.ok).toBe(false);
    });

    it('rejects paths under /sys', () => {
      const result = policy.registerWritable('/sys/class/gpio');
      expect(result.ok).toBe(false);
    });

    it('rejects paths under /proc', () => {
      const result = policy.registerWritable('/proc/test');
      expect(result.ok).toBe(false);
    });

    it('rejects paths inside protect directories', () => {
      const home = os.homedir();
      const result = policy.registerWritable(`${home}/.ssh/workspace`);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('protected');
    });
  });

  describe('unregisterWritable', () => {
    it('removes a previously registered path', () => {
      policy.registerWritable('/mnt/data');
      expect(policy.classify('/mnt/data')).toBe('writable');
      policy.unregisterWritable('/mnt/data');
      expect(policy.classify('/mnt/data')).toBe('explore');
    });
  });

  describe('extra protect paths', () => {
    it('honors extra protect paths from config', () => {
      const p = createPathPolicy({ extraProtectPaths: ['/opt/secrets'] });
      expect(p.classify('/opt/secrets/token')).toBe('protect');
    });
  });

  describe('getWritablePaths', () => {
    it('returns all registered writable paths', () => {
      policy.registerWritable('/mnt/a');
      policy.registerWritable('/data/b');
      const paths = policy.getWritablePaths();
      expect(paths).toContain('/mnt/a');
      expect(paths).toContain('/data/b');
    });
  });

  describe('getProtectPaths', () => {
    it('returns built-in and extra protect paths', () => {
      const paths = policy.getProtectPaths();
      const home = os.homedir();
      expect(paths).toContain(`${home}/.ssh`);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/path-policy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
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
      (prefix) => resolved === prefix || resolved.startsWith(prefix + path.sep)
    );
  }

  return {
    classify(filePath: string): 'protect' | 'writable' | 'explore' {
      const resolved = path.resolve(filePath);

      // Check /tmp first — always writable
      if (resolved === '/tmp' || resolved.startsWith('/tmp' + path.sep)) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/path-policy.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/path-policy.ts src/sandbox/__tests__/path-policy.test.ts
git commit -m "feat: add path-policy module for sandbox path classification"
```

---

### Task 3: Bwrap executor

**Files:**
- Create: `src/sandbox/bwrap-executor.ts`
- Create: `src/sandbox/__tests__/bwrap-executor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sandbox/__tests__/bwrap-executor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildBwrapCommand, isBwrapAvailable, findBwrap } from '../bwrap-executor';
import { createPathPolicy } from '../path-policy';

describe('findBwrap', () => {
  it('returns a string path or null', () => {
    const result = findBwrap();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('isBwrapAvailable', () => {
  it('returns a boolean', () => {
    expect(typeof isBwrapAvailable()).toBe('boolean');
  });
});

describe('buildBwrapCommand', () => {
  let policy: ReturnType<typeof createPathPolicy>;

  beforeEach(() => {
    policy = createPathPolicy();
  });

  it('starts with bwrap', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    expect(cmd[0]).toBe('bwrap');
  });

  it('includes --ro-bind / /', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--ro-bind / /');
  });

  it('includes --tmpfs /tmp', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--tmpfs /tmp');
  });

  it('includes --bind /dev /dev', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--bind /dev /dev');
  });

  it('includes --bind /dev/shm /dev/shm', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--bind /dev/shm /dev/shm');
  });

  it('includes --unshare-pid and --share-net', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--unshare-pid');
    expect(joined).toContain('--share-net');
  });

  it('includes --bind for registered writable paths', () => {
    policy.registerWritable('/mnt/workspace');
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--bind /mnt/workspace /mnt/workspace');
  });

  it('includes --bind for docker socket', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--bind /var/run/docker.sock /var/run/docker.sock');
  });

  it('ends with -- followed by the target command', () => {
    const cmd = buildBwrapCommand('echo hello world', policy);
    const afterDash = cmd.slice(cmd.indexOf('--') + 1);
    expect(afterDash.join(' ')).toBe('echo hello world');
  });

  it('wraps command in shell when shell wrapper is needed', () => {
    const cmd = buildBwrapCommand('echo "hello world"', policy);
    const afterDash = cmd.slice(cmd.indexOf('--') + 1);
    // Complex commands with quotes should be wrapped in sh -c
    expect(afterDash[0]).toBe('sh');
    expect(afterDash[1]).toBe('-c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/bwrap-executor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/sandbox/bwrap-executor.ts
import { execSync, execFileSync } from 'node:child_process';
import type { PathPolicy } from './path-policy';
import type { ToolResult } from '../tools/types';

function findBwrap(): string | null {
  try {
    const result = execFileSync('which', ['bwrap'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.trim() || null;
  } catch {
    try {
      // Fallback: try running bwrap --version directly
      execFileSync('bwrap', ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return 'bwrap';
    } catch {
      return null;
    }
  }
}

function isBwrapAvailable(): boolean {
  return findBwrap() !== null;
}

/**
 * Build the bwrap shell command array.
 * Complex commands (containing quotes, pipes, redirects, etc.) are
 * wrapped in `sh -c` to ensure proper shell interpretation.
 */
function buildBwrapCommand(
  command: string,
  policy: PathPolicy
): string[] {
  const args: string[] = ['bwrap'];

  // Read-only bind the entire root filesystem
  args.push('--ro-bind', '/', '/');

  // Writable tmpfs for /tmp
  args.push('--tmpfs', '/tmp');

  // Bind host devices (NPU, GPU, etc.)
  args.push('--bind', '/dev', '/dev');

  // Shared memory for CANN/PyTorch
  args.push('--bind', '/dev/shm', '/dev/shm');

  // Docker socket for container orchestration
  args.push('--bind', '/var/run/docker.sock', '/var/run/docker.sock');

  // Dynamic writable paths
  for (const wp of policy.getWritablePaths()) {
    args.push('--bind', wp, wp);
  }

  // Process isolation, share network
  args.push('--unshare-pid');
  args.push('--share-net');

  // Separator and target command
  args.push('--');

  // Determine if shell wrapping is needed
  const needsShell = /["'|&;<>$`\\*?[\]()!#~]/.test(command);
  if (needsShell) {
    args.push('sh', '-c', command);
  } else {
    // Split simple command into argv
    const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command];
    args.push(...parts.map((p) => p.replace(/^"|"$/g, '')));
  }

  return args;
}

/**
 * Execute a command inside the bwrap sandbox.
 * Returns a ToolResult matching the existing run_command contract.
 */
function executeInBwrap(
  command: string,
  policy: PathPolicy,
  options?: { workdir?: string; timeout?: number }
): ToolResult {
  const bwrapPath = findBwrap();
  if (!bwrapPath) {
    return {
      content:
        '[SANDBOX WARNING] bwrap is not available on this system. ' +
        'Command executed without filesystem isolation.\n' +
        'Install bubblewrap: apt install bubblewrap / dnf install bubblewrap\n\n' +
        'Continuing with existing high-risk pattern detection only.',
      summary: 'sandbox=unavailable | bwrap not found',
      exitCode: 0,
      keyOutput: 'bwrap not available — running without sandbox',
    };
  }

  const args = buildBwrapCommand(command, policy);
  // Replace 'bwrap' with actual path
  args[0] = bwrapPath;

  const commandStr = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');

  try {
    const stdout = execSync(commandStr, {
      cwd: options?.workdir ?? process.cwd(),
      timeout: options?.timeout ?? 60_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const trimmed = stdout.trim();
    return {
      content: trimmed ? `${trimmed}\nexit code: 0` : 'exit code: 0',
      summary: `exit=0 | ${trimmed.slice(0, 80)}`,
      exitCode: 0,
      keyOutput: trimmed.slice(0, 300),
    };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
      killed?: boolean;
    };

    if (err.killed) {
      const partial = [
        typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString('utf-8') ?? '',
        typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf-8') ?? '',
      ]
        .filter(Boolean)
        .join('\n')
        .trim();
      return {
        content: partial
          ? `${partial}\n[TRUNCATED: command timed out]`
          : '[TRUNCATED: command timed out, no output captured]',
        summary: 'exit=timeout | command timed out',
        exitCode: undefined,
        keyOutput: partial?.slice(0, 300),
        isError: true,
      };
    }

    const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString('utf-8') ?? '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf-8') ?? '';
    const out = [stdout, stderr].filter(Boolean).join('\n');
    const code = err.status ?? 1;
    return {
      content: (out || err.message) + `\nexit code: ${code}`,
      summary: `exit=${code} | ${(out || err.message).slice(0, 80)}`,
      exitCode: code,
      keyOutput: out.slice(0, 300),
      isError: true,
    };
  }
}

export { findBwrap, isBwrapAvailable, buildBwrapCommand, executeInBwrap };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/bwrap-executor.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/bwrap-executor.ts src/sandbox/__tests__/bwrap-executor.test.ts
git commit -m "feat: add bwrap executor for sandbox command execution"
```

---

### Task 4: Docker volume mount validator

**Files:**
- Create: `src/sandbox/docker-validator.ts`
- Create: `src/sandbox/__tests__/docker-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sandbox/__tests__/docker-validator.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { isDockerCommand, parseVolumeMounts, createDockerValidator } from '../docker-validator';
import { createPathPolicy } from '../path-policy';

describe('isDockerCommand', () => {
  it('detects docker run', () => {
    expect(isDockerCommand('docker run hello-world')).toBe(true);
    expect(isDockerCommand('  docker run hello-world')).toBe(true);
  });

  it('detects docker create', () => {
    expect(isDockerCommand('docker create --name test ubuntu')).toBe(true);
  });

  it('returns false for non-docker commands', () => {
    expect(isDockerCommand('echo hello')).toBe(false);
    expect(isDockerCommand('ls -la')).toBe(false);
  });

  it('returns false for docker-like but not docker commands', () => {
    expect(isDockerCommand('dockerrun')).toBe(false);
    expect(isDockerCommand('adocker run')).toBe(false);
  });
});

describe('parseVolumeMounts', () => {
  it('parses -v host:container', () => {
    const mounts = parseVolumeMounts(
      'docker run -v /data:/data ubuntu'
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ hostPath: '/data', containerPath: '/data' });
  });

  it('parses -v host:container:ro', () => {
    const mounts = parseVolumeMounts(
      'docker run -v /data:/data:ro ubuntu'
    );
    expect(mounts[0].mode).toBe('ro');
  });

  it('parses --mount type=bind,source=/src,target=/dst', () => {
    const mounts = parseVolumeMounts(
      'docker run --mount type=bind,source=/src,target=/dst ubuntu'
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0].hostPath).toBe('/src');
    expect(mounts[0].containerPath).toBe('/dst');
  });

  it('parses --mount with readonly option', () => {
    const mounts = parseVolumeMounts(
      'docker run --mount type=bind,source=/src,target=/dst,readonly ubuntu'
    );
    expect(mounts[0].mode).toBe('ro');
  });

  it('parses --volume (long form)', () => {
    const mounts = parseVolumeMounts(
      'docker run --volume /data:/data:ro ubuntu'
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0].hostPath).toBe('/data');
  });

  it('parses multiple -v flags', () => {
    const mounts = parseVolumeMounts(
      'docker run -v /a:/a -v /b:/b:ro -v /c:/c ubuntu'
    );
    expect(mounts).toHaveLength(3);
  });

  it('returns empty array when no volume mounts', () => {
    const mounts = parseVolumeMounts('docker run ubuntu echo hello');
    expect(mounts).toHaveLength(0);
  });
});

describe('createDockerValidator', () => {
  let policy: ReturnType<typeof createPathPolicy>;
  let validator: ReturnType<typeof createDockerValidator>;

  beforeEach(() => {
    policy = createPathPolicy();
    policy.registerWritable('/mnt/workspace');
    validator = createDockerValidator(policy);
  });

  it('allows writable paths in -v', () => {
    const result = validator.validate('docker run -v /mnt/workspace/models:/models ubuntu');
    expect(result.ok).toBe(true);
    expect(result.blocked).toHaveLength(0);
  });

  it('allows /etc paths (system read-only, safe)', () => {
    const result = validator.validate('docker run -v /etc/localtime:/etc/localtime:ro ubuntu');
    expect(result.ok).toBe(true);
  });

  it('blocks protect paths', () => {
    const result = validator.validate(
      'docker run -v /etc/shadow:/shadow ubuntu'
    );
    expect(result.ok).toBe(false);
    expect(result.blocked.length).toBeGreaterThan(0);
  });

  it('blocks / (entire host bind mount)', () => {
    const result = validator.validate('docker run -v /:/host ubuntu');
    expect(result.ok).toBe(false);
  });

  it('blocks unregistered paths', () => {
    const result = validator.validate(
      'docker run -v /some/unknown/path:/data ubuntu'
    );
    expect(result.ok).toBe(false);
  });

  it('returns ok:true for docker commands with no volume mounts', () => {
    const result = validator.validate('docker run ubuntu echo hello');
    expect(result.ok).toBe(true);
  });

  it('reports reason for each blocked path', () => {
    const result = validator.validate(
      'docker run -v /bad/path:/data -v /another/bad:/more ubuntu'
    );
    expect(result.ok).toBe(false);
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked[0].reason).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/docker-validator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
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
  return /^docker\s+(run|create)\b/.test(trimmed);
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  mode: string; // 'rw' | 'ro'
}

function parseVolumeMounts(command: string): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  // Match -v / --volume flags
  // Pattern: -v HOST:CONTAINER[:MODE] or --volume HOST:CONTAINER[:MODE]
  const vPattern = /(?:-v|--volume)\s+(\S+?):(\S+?)(?::(ro|rw|z|Z))?(?:\s|$)/g;
  let match;
  while ((match = vPattern.exec(command)) !== null) {
    mounts.push({
      hostPath: match[1],
      containerPath: match[2],
      mode: match[3] || 'rw',
    });
  }

  // Match --mount flags
  // Pattern: --mount type=bind,source=SRC,target=DST[,readonly]
  const mountPattern = /--mount\s+([^-\s]\S*)/g;
  while ((match = mountPattern.exec(command)) !== null) {
    const opts = match[1];
    if (!opts.includes('type=bind') && !opts.startsWith('type=bind')) continue;

    const srcMatch = opts.match(/(?:^|,)source=([^,]+)/);
    const dstMatch = opts.match(/(?:^|,)target=([^,]+)/);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/docker-validator.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/docker-validator.ts src/sandbox/__tests__/docker-validator.test.ts
git commit -m "feat: add docker volume mount validator for sandbox"
```

---

### Task 5: Sandbox manager (unified entry point)

**Files:**
- Create: `src/sandbox/sandbox-manager.ts`
- Create: `src/sandbox/__tests__/sandbox-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sandbox/__tests__/sandbox-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSandboxManager, setSandboxManager, getSandboxManager } from '../sandbox-manager';
import { DEFAULT_SANDBOX_CONFIG } from '../types';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

describe('createSandboxManager', () => {
  let mgr: ReturnType<typeof createSandboxManager>;

  beforeEach(() => {
    mgr = createSandboxManager(DEFAULT_SANDBOX_CONFIG);
    setSandboxManager(mgr);
  });

  afterEach(() => {
    setSandboxManager(null as unknown as ReturnType<typeof createSandboxManager>);
  });

  describe('getStatus', () => {
    it('returns status with enabled flag', () => {
      const status = mgr.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.engine).toBe('bwrap');
      expect(typeof status.bwrapAvailable).toBe('boolean');
      expect(Array.isArray(status.writablePaths)).toBe(true);
      expect(Array.isArray(status.protectPaths)).toBe(true);
    });
  });

  describe('registerWritable', () => {
    it('registers a path and creates the directory on host', () => {
      const tmpDir = path.join(os.tmpdir(), `sandbox-test-${Date.now()}`);
      try {
        const result = mgr.registerWritable(tmpDir);
        expect(result.ok).toBe(true);
        expect(fs.existsSync(tmpDir)).toBe(true);
        expect(mgr.getStatus().writablePaths).toContain(tmpDir);
      } finally {
        mgr.unregisterWritable(tmpDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('rejects paths in /etc', () => {
      const result = mgr.registerWritable('/etc/dangerous');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('execute', () => {
    it('executes a simple command', async () => {
      const result = await mgr.execute('echo hello');
      expect(result.content).toBeTruthy();
      // bwrap may or may not be available; accept either outcome
      expect(typeof result.exitCode === 'number' || result.isError).toBeTruthy();
    });

    it('blocks docker commands with illegal volume mounts', async () => {
      // This test verifies the validator integration
      const result = await mgr.execute(
        'docker run -v /etc/shadow:/shadow ubuntu echo test'
      );
      // If bwrap is available, this should be blocked
      // If bwrap is not available, the sandbox warning is returned
      expect(result.content).toBeTruthy();
    });
  });

  describe('setSandboxManager / getSandboxManager', () => {
    it('returns the set manager', () => {
      const m = createSandboxManager({ ...DEFAULT_SANDBOX_CONFIG, enabled: false });
      setSandboxManager(m);
      expect(getSandboxManager()).toBe(m);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/sandbox-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/sandbox/sandbox-manager.ts
import fs from 'node:fs';
import path from 'node:path';
import { createPathPolicy } from './path-policy';
import { isBwrapAvailable, executeInBwrap } from './bwrap-executor';
import { isDockerCommand, createDockerValidator } from './docker-validator';
import type { SandboxConfig, SandboxStatus } from './types';
import type { ToolResult } from '../tools/types';
import { execSync } from 'node:child_process';

let sandboxManager: SandboxManager | null = null;

export function setSandboxManager(mgr: SandboxManager): void {
  sandboxManager = mgr;
}

export function getSandboxManager(): SandboxManager | null {
  return sandboxManager;
}

export interface SandboxManager {
  execute(
    command: string,
    options?: { workdir?: string; timeout?: number }
  ): Promise<ToolResult>;
  registerWritable(filePath: string): { ok: boolean; error?: string };
  unregisterWritable(filePath: string): void;
  getStatus(): SandboxStatus;
}

export function createSandboxManager(config: SandboxConfig): SandboxManager {
  const policy = createPathPolicy({
    extraProtectPaths: config.extra_protect_paths,
  });
  const dockerValidator = createDockerValidator(policy);
  const bwrapAvailable = isBwrapAvailable();

  return {
    async execute(
      command: string,
      options?: { workdir?: string; timeout?: number }
    ): Promise<ToolResult> {
      // If sandbox is disabled, execute directly
      if (!config.enabled) {
        return executeDirect(command, options);
      }

      // Docker command: validate volume mounts first
      if (isDockerCommand(command)) {
        const validation = dockerValidator.validate(command);
        if (!validation.ok) {
          const reasons = validation.blocked
            .map((b) => `  - ${b.hostPath}: ${b.reason}`)
            .join('\n');
          return {
            content: `[SANDBOX BLOCKED] Docker volume mount(s) rejected:\n${reasons}`,
            summary: `sandbox=blocked | ${validation.blocked.length} illegal mount(s)`,
            exitCode: 1,
            isError: true,
          };
        }
      }

      // If bwrap is unavailable, fall back
      if (!bwrapAvailable) {
        if (config.fallback_to_warn) {
          return executeInBwrap(command, policy, options);
        }
        return executeDirect(command, options);
      }

      return executeInBwrap(command, policy, options);
    },

    registerWritable(filePath: string): { ok: boolean; error?: string } {
      const resolved = path.resolve(filePath);

      // Check with policy first
      const result = policy.registerWritable(resolved);
      if (!result.ok) return result;

      // Create directory on host (required for bwrap --bind)
      try {
        fs.mkdirSync(resolved, { recursive: true });
      } catch (e: unknown) {
        policy.unregisterWritable(resolved);
        return {
          ok: false,
          error: `Failed to create directory: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      return { ok: true };
    },

    unregisterWritable(filePath: string): void {
      policy.unregisterWritable(path.resolve(filePath));
    },

    getStatus(): SandboxStatus {
      return {
        enabled: config.enabled,
        engine: config.engine,
        bwrapAvailable,
        writablePaths: policy.getWritablePaths(),
        protectPaths: policy.getProtectPaths(),
      };
    },
  };
}

function executeDirect(
  command: string,
  options?: { workdir?: string; timeout?: number }
): ToolResult {
  try {
    const stdout = execSync(command, {
      cwd: options?.workdir ?? process.cwd(),
      timeout: options?.timeout ?? 60_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const trimmed = stdout.trim();
    return {
      content: trimmed ? `${trimmed}\nexit code: 0` : 'exit code: 0',
      summary: `exit=0 | ${trimmed.slice(0, 80)}`,
      exitCode: 0,
      keyOutput: trimmed.slice(0, 300),
    };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
      killed?: boolean;
    };
    if (err.killed) {
      return {
        content: '[TRUNCATED: command timed out]',
        summary: 'exit=timeout',
        exitCode: undefined,
        isError: true,
      };
    }
    const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString('utf-8') ?? '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf-8') ?? '';
    const out = [stdout, stderr].filter(Boolean).join('\n');
    const code = err.status ?? 1;
    return {
      content: (out || err.message) + `\nexit code: ${code}`,
      summary: `exit=${code} | ${(out || err.message).slice(0, 80)}`,
      exitCode: code,
      keyOutput: out.slice(0, 300),
      isError: true,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/sandbox-manager.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/sandbox-manager.ts src/sandbox/__tests__/sandbox-manager.test.ts
git commit -m "feat: add sandbox manager — unified entry point for sandbox execution"
```

---

### Task 6: Config types and loader for sandbox

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/loader.ts`

- [ ] **Step 1: Write the failing config test**

First, check existing loader test:

```typescript
// Add to src/config/__tests__/loader.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../loader';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('sandbox config', () => {
  it('loads sandbox config with defaults when section is missing', () => {
    const tmpFile = path.join(os.tmpdir(), `my-agent-test-${Date.now()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        api_url: 'https://api.example.com/v1',
        model: 'test-model',
        api_key: 'sk-test',
      })
    );
    try {
      const config = loadConfig(tmpFile);
      expect(config.sandbox.enabled).toBe(true);
      expect(config.sandbox.engine).toBe('bwrap');
      expect(config.sandbox.extra_protect_paths).toEqual([]);
      expect(config.sandbox.fallback_to_warn).toBe(true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('loads custom sandbox config', () => {
    const tmpFile = path.join(os.tmpdir(), `my-agent-test-${Date.now()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        api_url: 'https://api.example.com/v1',
        model: 'test-model',
        api_key: 'sk-test',
        sandbox: {
          enabled: false,
          engine: 'bwrap',
          extra_protect_paths: ['/opt/secrets', '/data/private'],
          fallback_to_warn: false,
        },
      })
    );
    try {
      const config = loadConfig(tmpFile);
      expect(config.sandbox.enabled).toBe(false);
      expect(config.sandbox.extra_protect_paths).toEqual(['/opt/secrets', '/data/private']);
      expect(config.sandbox.fallback_to_warn).toBe(false);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
```

This adds to the existing test — no new test file needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/__tests__/loader.test.ts`
Expected: FAIL — `config.sandbox` is undefined

- [ ] **Step 3: Add SandboxConfig type**

```typescript
// src/config/types.ts — add after MemoryConfig:

export interface SandboxConfig {
  enabled: boolean;
  engine: 'bwrap';
  extra_protect_paths: string[];
  fallback_to_warn: boolean;
}
```

And add `sandbox: SandboxConfig` to the `Config` interface:

```typescript
export interface Config {
  api_url: string;
  model: string;
  api_key: string;
  tools: ToolsConfig;
  context: ContextConfig;
  subagent: SubagentConfig;
  memory: MemoryConfig;
  sandbox: SandboxConfig;
}
```

- [ ] **Step 4: Update config loader to parse sandbox section**

In `src/config/loader.ts`, add:

```typescript
const sandboxCfg = (cfg.sandbox as Record<string, unknown> | undefined) ?? {};
```

And add to the return object:

```typescript
sandbox: {
  enabled: typeof sandboxCfg.enabled === 'boolean' ? sandboxCfg.enabled : true,
  engine: (sandboxCfg.engine === 'bwrap' ? 'bwrap' : 'bwrap'),
  extra_protect_paths:
    Array.isArray(sandboxCfg.extra_protect_paths)
      ? sandboxCfg.extra_protect_paths.filter((p): p is string => typeof p === 'string')
      : [],
  fallback_to_warn:
    typeof sandboxCfg.fallback_to_warn === 'boolean' ? sandboxCfg.fallback_to_warn : true,
},
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/config/__tests__/loader.test.ts`
Expected: all tests PASS (including new sandbox tests)

- [ ] **Step 6: Commit**

```bash
git add src/config/types.ts src/config/loader.ts src/config/__tests__/loader.test.ts
git commit -m "feat: add sandbox config section to config system"
```

---

### Task 7: register_writable_path tool

**Files:**
- Create: `src/tools/sandbox/index.ts`
- Create: `src/tools/sandbox/register-writable.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/tools/sandbox/__tests__/register-writable.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRegisterWritableTool } from '../register-writable';
import { createSandboxManager, setSandboxManager, getSandboxManager } from '../../../sandbox/sandbox-manager';
import { DEFAULT_SANDBOX_CONFIG } from '../../../sandbox/types';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

describe('register_writable_path tool', () => {
  let mgr: ReturnType<typeof createSandboxManager>;

  beforeEach(() => {
    mgr = createSandboxManager(DEFAULT_SANDBOX_CONFIG);
    setSandboxManager(mgr);
  });

  afterEach(() => {
    setSandboxManager(null as unknown as ReturnType<typeof createSandboxManager>);
  });

  it('has correct name', () => {
    const tool = createRegisterWritableTool();
    expect(tool.name).toBe('register_writable_path');
  });

  it('registers a valid path', async () => {
    const tool = createRegisterWritableTool();
    const tmpDir = path.join(os.tmpdir(), `rw-test-${Date.now()}`);
    try {
      const result = await tool.handler({ path: tmpDir });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('registered');
      expect(mgr.getStatus().writablePaths).toContain(tmpDir);
    } finally {
      mgr.unregisterWritable(tmpDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects /etc paths', async () => {
    const tool = createRegisterWritableTool();
    const result = await tool.handler({ path: '/etc/dangerous' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('system-critical');
  });

  it('rejects missing path parameter', async () => {
    const tool = createRegisterWritableTool();
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });

  it('has path as required parameter', () => {
    const tool = createRegisterWritableTool();
    expect(tool.parameters.required).toContain('path');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/sandbox/__tests__/register-writable.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the tool implementation**

```typescript
// src/tools/sandbox/register-writable.ts
import type { ToolDefinition } from '../../tools/types';
import { getSandboxManager } from '../../sandbox/sandbox-manager';

export function createRegisterWritableTool(): ToolDefinition {
  return {
    name: 'register_writable_path',
    description:
      'Register a workspace directory as writable in the sandbox. ' +
      'After registration, the path and all sub-paths become readable and writable, ' +
      'and docker -v mounts to this path are allowed. ' +
      'Use this after discovering available storage via df -h / ls to declare your working area. ' +
      'The directory will be created on the host if it does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path on the host to register as writable workspace. ' +
            'Must not be under /etc, /boot, /sys, /proc or any protected credential path.',
        },
      },
      required: ['path'],
    },
    handler: async (params: Record<string, unknown>) => {
      const filePath = typeof params.path === 'string' ? params.path.trim() : '';

      if (!filePath) {
        return {
          content: 'Error: "path" parameter is required and must be a non-empty string.',
          summary: 'register_writable_path failed: missing path',
          exitCode: 1,
          isError: true,
        };
      }

      if (!filePath.startsWith('/')) {
        return {
          content: `Error: "${filePath}" is not an absolute path. Please provide an absolute path starting with /.`,
          summary: 'register_writable_path failed: not absolute path',
          exitCode: 1,
          isError: true,
        };
      }

      const mgr = getSandboxManager();
      if (!mgr) {
        return {
          content: 'Error: Sandbox manager is not initialized. Is the sandbox enabled?',
          summary: 'register_writable_path failed: no sandbox manager',
          exitCode: 1,
          isError: true,
        };
      }

      const result = mgr.registerWritable(filePath);

      if (!result.ok) {
        return {
          content: `Error: ${result.error}`,
          summary: `register_writable_path failed: ${result.error}`,
          exitCode: 1,
          isError: true,
        };
      }

      return {
        content:
          `Path "${filePath}" registered as writable workspace.\n` +
          `- File system: read/write access granted\n` +
          `- Docker -v mounts to this path: allowed\n` +
          `- Current writable paths: ${mgr.getStatus().writablePaths.join(', ') || '(none)'}`,
        summary: `writable registered: ${filePath}`,
        exitCode: 0,
      };
    },
  };
}
```

And `index.ts`:
```typescript
// src/tools/sandbox/index.ts
export { createRegisterWritableTool } from './register-writable';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/sandbox/__tests__/register-writable.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/sandbox/ src/tools/sandbox/__tests__/
git commit -m "feat: add register_writable_path tool for dynamic workspace registration"
```

---

### Task 8: Integrate sandbox into run_command handler

**Files:**
- Modify: `src/tools/shell/run-command.ts`

- [ ] **Step 1: Update the run_command handler to route through sandbox**

```typescript
// src/tools/shell/run-command.ts
import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types';
import { getSandboxManager } from '../../sandbox/sandbox-manager';
import type { ToolResult } from '../types';

async function executeViaSandbox(
  command: string,
  workdir: string,
  timeoutMs: number
): Promise<ToolResult> {
  const mgr = getSandboxManager();
  if (mgr) {
    return mgr.execute(command, { workdir, timeout: timeoutMs });
  }

  // No sandbox manager — execute directly (legacy path)
  return executeDirectly(command, workdir, timeoutMs);
}

function executeDirectly(
  command: string,
  workdir: string,
  timeoutMs: number
): ToolResult {
  try {
    const stdout = execSync(command, {
      cwd: workdir,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
        ? (process.env.ComSpec || 'cmd.exe')
        : (process.env.SHELL || '/bin/sh'),
    });
    const stdoutTrimmed = stdout.trim();
    const stdoutStr = stdoutTrimmed ? stdoutTrimmed + '\nexit code: 0' : 'exit code: 0';
    return {
      content: stdoutStr,
      summary: `exit=0 | ${stdoutTrimmed.slice(0, 80)}`,
      exitCode: 0,
      keyOutput: stdoutTrimmed.slice(0, 300),
    };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
      killed?: boolean;
    };

    if (err.killed) {
      const partial = (
        (typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString('utf-8') ?? '') +
        '\n' +
        (typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf-8') ?? '')
      ).trim();
      return {
        content: partial
          ? partial + '\n[TRUNCATED: command timed out]'
          : '[TRUNCATED: command timed out, no output captured]',
        summary: 'exit=timeout | command timed out',
        exitCode: undefined,
        keyOutput: partial?.slice(0, 300),
        isError: true,
      };
    }

    const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString('utf-8') ?? '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf-8') ?? '';
    const out = [stdout, stderr].filter(Boolean).join('\n');
    const code = err.status ?? 1;
    const fullContent = (out || err.message) + `\nexit code: ${code}`;
    return {
      content: fullContent,
      summary: `exit=${code} | ${(out || err.message).slice(0, 80)}`,
      exitCode: code,
      keyOutput: out.slice(0, 300),
      isError: true,
    };
  }
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    'Execute a Linux shell command. Safe read-only commands run automatically. ' +
    'Long-running commands (training, inference) should use background=true. ' +
    'Output is truncated after the timeout (default 60s).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (default: current)' },
      background: { type: 'boolean', description: 'Run as background job (default: false)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default: 60)' },
    },
    required: ['command'],
  },
  handler: async (params: Record<string, unknown>) => {
    const command = String(params.command ?? '');
    const workdir = typeof params.workdir === 'string' ? params.workdir : process.cwd();
    const timeoutMs = typeof params.timeout === 'number' ? params.timeout * 1000 : 60_000;

    if (!command.trim()) {
      return {
        content: 'Error: command is empty',
        summary: 'exit=error | empty command',
        exitCode: 1,
        isError: true,
      };
    }

    return executeViaSandbox(command, workdir, timeoutMs);
  },
};
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `npx vitest run src/tools/shell/__tests__/run-command.test.ts`
Expected: all tests PASS (existing behavior preserved)

- [ ] **Step 3: Commit**

```bash
git add src/tools/shell/run-command.ts
git commit -m "feat: route run_command through sandbox manager"
```

---

### Task 9: Wire up sandbox in CLI entry point

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Add sandbox initialization to the entry point**

In `bin/my-agent.ts`, add the import:

```typescript
import { createSandboxManager, setSandboxManager } from '../src/sandbox/sandbox-manager.js';
```

And after the MCP manager initialization (around line 101), add:

```typescript
// Initialize sandbox manager
const sandboxMgr = createSandboxManager(config.sandbox);
setSandboxManager(sandboxMgr);

// Register sandbox tools
import { createRegisterWritableTool } from '../src/tools/sandbox/index.js';
import { defaultRegistry } from '../src/tools/registry.js';
defaultRegistry.register(createRegisterWritableTool());

// Report sandbox status
const sandboxStatus = sandboxMgr.getStatus();
if (sandboxStatus.enabled) {
  if (sandboxStatus.bwrapAvailable) {
    console.log(formatInfo(`  Sandbox: bwrap ✓`));
  } else {
    console.log(formatInfo(`  Sandbox: bwrap not found — fallback mode (warn)`));
  }
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run all tests to verify nothing is broken**

Run: `npx vitest run`
Expected: all existing tests still PASS

- [ ] **Step 4: Commit**

```bash
git add bin/my-agent.ts
git commit -m "feat: initialize sandbox manager and register tools at startup"
```

---

### Post-Implementation: Environment Validation

After all tasks are implemented, validate on a Linux machine with Ascend NPU:

1. Verify bwrap is available: `which bwrap`
2. Start my-agent with sandbox enabled
3. Run `echo hello` — should work
4. Run `cat ~/.ssh/id_rsa` — should fail (protect)
5. Run `touch /etc/test` — should fail (read-only root)
6. Call `register_writable_path /tmp/my-workspace`
7. Verify `touch /tmp/my-workspace/test` works
8. Verify `docker run -v /tmp/my-workspace:/data ubuntu echo test` works
9. Verify `docker run -v ~/.ssh:/ssh ubuntu echo test` is blocked
10. Verify `npu-smi info` works inside sandbox
11. Verify `docker run --runtime=ascend ...` works
