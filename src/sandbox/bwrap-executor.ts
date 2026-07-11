// src/sandbox/bwrap-executor.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { PathPolicy } from './path-policy';

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

interface BuildBwrapOptions {
  /** Override path to resolv.conf for testing */
  resolvConfPath?: string;
  /** TCP port for the socat→proxy forwarder (avoids hardcoded port conflicts) */
  proxyPort?: number;
}

/**
 * Build the bwrap shell command array.
 *
 * All commands are wrapped in a socat-based network proxy forwarder:
 * socat listens on a local TCP port and forwards to the Unix-domain
 * HTTP CONNECT proxy socket, enabling domain-filtered network access
 * inside the isolated network namespace.
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

  // Process isolation, isolate network (no --share-net)
  args.push('--unshare-pid');
  args.push('--unshare-net');

  // Override resolv.conf if DNS fix was applied
  if (resolvConfFix) {
    args.push('--bind', resolvConfFix, '/etc/resolv.conf');
  }

  // Bind the proxy Unix socket into the sandbox (only if it exists)
  const proxySocketPath = '/tmp/my-agent-proxy.sock';
  if (fs.existsSync(proxySocketPath)) {
    args.push('--bind', proxySocketPath, proxySocketPath);
  }

  const port = options?.proxyPort ?? 19877;

  // Separator and target command
  args.push('--');

  // All commands are wrapped with socat forwarder + proxy env vars.
  // Uses polling (not a fixed sleep) to wait for socat to be ready.
  const wrapperScript =
    'cleanup() { kill $SOCAT_PID 2>/dev/null; }; ' +
    'trap cleanup EXIT INT TERM; ' +
    `socat TCP-LISTEN:${port},fork,reuseaddr UNIX-CONNECT:${proxySocketPath} & ` +
    'SOCAT_PID=$!; ' +
    // Poll until the port is accepting connections (up to 5 seconds)
    'for _ in $(seq 1 50); do ' +
    `  (echo >/dev/tcp/127.0.0.1/${port}) 2>/dev/null && break; ` +
    '  sleep 0.1; ' +
    'done; ' +
    `export HTTP_PROXY=http://127.0.0.1:${port}; ` +
    `export HTTPS_PROXY=http://127.0.0.1:${port}; ` +
    `export http_proxy=http://127.0.0.1:${port}; ` +
    `export https_proxy=http://127.0.0.1:${port}; ` +
    `export no_proxy=localhost,127.0.0.1,.local; ` +
    `export NO_PROXY=localhost,127.0.0.1,.local; ` +
    command + '; ' +
    'EXIT_CODE=$?; ' +
    'cleanup; ' +
    'exit $EXIT_CODE';

  args.push('sh', '-c', wrapperScript);

  return args;
}

export { findBwrap, isBwrapAvailable, fixResolvConf, buildBwrapCommand };
export type { BuildBwrapOptions };
