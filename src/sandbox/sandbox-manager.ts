// src/sandbox/sandbox-manager.ts
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createPathPolicy } from './path-policy';
import { isBwrapAvailable, buildBwrapCommand } from './bwrap-executor';
import { isDockerCommand, createDockerValidator } from './docker-validator';
import { createProxyServer } from './net-proxy';
import type { SandboxConfig, SandboxStatus } from './types';
import { execSync, execFileSync } from 'node:child_process';

let sandboxManager: SandboxManager | null = null;

export function setSandboxManager(mgr: SandboxManager | null): void {
  sandboxManager = mgr;
}

export function getSandboxManager(): SandboxManager | null {
  return sandboxManager;
}

export interface SandboxManager {
  /**
   * Build the full command string that should be passed to TaskRegistry.spawn().
   * Returns the sandbox-wrapped command line, or null if no wrapping is needed
   * (i.e., the original command should be spawned directly).
   */
  buildCommand(
    command: string,
    options?: { workdir?: string; timeout?: number }
  ): Promise<{ command: string; workdir: string }>;

  registerWritable(filePath: string): { ok: boolean; error?: string };
  unregisterWritable(filePath: string): void;
  getStatus(): SandboxStatus;
  /** Stop the proxy server and clean up resources */
  destroy(): Promise<void>;
}

function isSocatAvailable(): boolean {
  try {
    execFileSync('socat', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Find a free TCP port on localhost for the per-command socat forwarder */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function createSandboxManager(config: SandboxConfig): SandboxManager {
  const policy = createPathPolicy({
    extraProtectPaths: config.extra_protect_paths,
  });
  const dockerValidator = createDockerValidator(policy);

  const domainConfig = config.domains ?? { extra_allowed_domains: [], blocked_domains: [] };
  const proxy = createProxyServer({
    allowedDomains: domainConfig.extra_allowed_domains,
    blockedDomains: domainConfig.blocked_domains,
  });

  const socatAvailable = isSocatAvailable();

  // Start proxy on creation (fire-and-forget, errors logged)
  let proxyRunning = true;
  const proxyPromise = proxy.start().catch(() => {
    proxyRunning = false;
  });

  return {
    async buildCommand(
      command: string,
      options?: { workdir?: string; timeout?: number }
    ): Promise<{ command: string; workdir: string }> {
      // Ensure proxy is running
      await proxyPromise;

      const workdir = options?.workdir ?? process.cwd();

      // If sandbox is disabled, return command as-is
      if (!config.enabled) {
        return { command, workdir };
      }

      // Docker command: validate volume mounts first
      if (isDockerCommand(command)) {
        const validation = dockerValidator.validate(command);
        if (!validation.ok) {
          const reasons = validation.blocked
            .map((b) => `  - ${b.hostPath}: ${b.reason}`)
            .join('\n');
          throw new Error(`[SANDBOX BLOCKED] Docker volume mount(s) rejected:\n${reasons}`);
        }
        return { command, workdir };
      }

      // Check socat availability for network isolation
      if (!socatAvailable) {
        if (config.fallback_to_warn) {
          return {
            command: `echo '[SANDBOX WARNING] socat is not available — cannot isolate network.' && ${command}`,
            workdir,
          };
        }
        return { command, workdir };
      }

      // Check bwrap availability
      const bwrapAvailable = isBwrapAvailable();

      if (!bwrapAvailable) {
        if (config.fallback_to_warn) {
          return {
            command: `echo '[SANDBOX WARNING] bwrap is not available on this system.' && ${command}`,
            workdir,
          };
        }
        return { command, workdir };
      }

      // Build bwrap command with proxy
      const proxyPort = await findFreePort();
      const args = buildBwrapCommand(command, policy, { proxyPort });
      const bwrapCmd = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');

      return { command: bwrapCmd, workdir };
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
        bwrapAvailable: isBwrapAvailable(),
        socatAvailable,
        proxyRunning,
        writablePaths: policy.getWritablePaths(),
        protectPaths: policy.getProtectPaths(),
      };
    },

    async destroy(): Promise<void> {
      await proxyPromise;
      await proxy.stop();
    },
  };
}
