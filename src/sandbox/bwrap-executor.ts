// src/sandbox/bwrap-executor.ts
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
 * Fix DNS resolution for containers running in a new network namespace.
 *
 * When the host uses systemd-resolved, /etc/resolv.conf contains
 * `nameserver 127.0.0.53` which is unreachable from inside a netns.
 * We detect this case and provide a replacement resolv.conf that
 * uses either systemd-resolved's upstream stub or public DNS servers.
 *
 * @param resolvConfPath — path to the host's resolv.conf (overridable for testing)
 * @returns path to the replacement resolv.conf, or null if no fix is needed
 */
function fixResolvConf(resolvConfPath?: string): string | null {
  try {
    const resolvedPath = resolvConfPath ?? '/etc/resolv.conf';
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const hasLocalResolver = /^nameserver\s+127\./m.test(content);
    if (!hasLocalResolver) return null;

    // Try systemd-resolved's stub file first
    const resolvedStub = '/run/systemd/resolve/resolv.conf';
    if (fs.existsSync(resolvedStub)) {
      return resolvedStub;
    }

    // Fallback: generate a fixed resolv.conf with public DNS
    const fixed = 'nameserver 8.8.8.8\nnameserver 114.114.114.114\n';
    const tmpPath = '/tmp/my-agent-resolv.conf';
    fs.writeFileSync(tmpPath, fixed);
    return tmpPath;
  } catch {
    return null;
  }
}

export interface BuildBwrapOptions {
  /** Override path to resolv.conf for testing */
  resolvConfPath?: string;
}

/**
 * Build the bwrap shell command array.
 * Complex commands (containing quotes, pipes, redirects, etc.) are
 * wrapped in `sh -c` to ensure proper shell interpretation.
 */
function buildBwrapCommand(
  command: string,
  policy: PathPolicy,
  options?: BuildBwrapOptions
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

  // Docker socket for container orchestration (only if it exists on host)
  if (fs.existsSync('/var/run/docker.sock')) {
    args.push('--bind', '/var/run/docker.sock', '/var/run/docker.sock');
  }

  // Dynamic writable paths
  for (const wp of policy.getWritablePaths()) {
    args.push('--bind', wp, wp);
  }

  // Fix DNS for systemd-resolved (127.0.0.53 unreachable in new netns)
  const resolvConfFix = fixResolvConf(options?.resolvConfPath);

  // Process isolation, share network
  args.push('--unshare-pid');
  args.push('--share-net');

  // Override resolv.conf if DNS fix was applied
  if (resolvConfFix) {
    args.push('--bind', resolvConfFix, '/etc/resolv.conf');
  }

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
    // This should not happen in normal flow — the caller (sandbox-manager)
    // gates on isBwrapAvailable(). If reached, it means bwrap was removed
    // after creation. Throw so the error is loud and clear, never silent.
    throw new Error(
      'bwrap was expected to be available but is not found. ' +
      'Install bubblewrap: apt install bubblewrap / dnf install bubblewrap'
    );
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

export { findBwrap, isBwrapAvailable, fixResolvConf, buildBwrapCommand, executeInBwrap };
export type { BuildBwrapOptions };
