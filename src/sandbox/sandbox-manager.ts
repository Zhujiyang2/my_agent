// src/sandbox/sandbox-manager.ts
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createPathPolicy } from './path-policy';
import { isBwrapAvailable, executeInBwrap } from './bwrap-executor';
import { isDockerCommand, createDockerValidator } from './docker-validator';
import { createProxyServer } from './net-proxy';
import type { SandboxConfig, SandboxStatus } from './types';
import type { ToolResult } from '../tools/types';
import { execSync, execFileSync } from 'node:child_process';

let sandboxManager: SandboxManager | null = null;

export function setSandboxManager(mgr: SandboxManager | null): void {
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
    console.warn('[sandbox] Failed to start proxy server.');
    proxyRunning = false;
  });

  return {
    async execute(
      command: string,
      options?: { workdir?: string; timeout?: number }
    ): Promise<ToolResult> {
      // Ensure proxy is running before executing
      await proxyPromise;

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

      // Check socat availability for network isolation
      if (!socatAvailable) {
        if (config.fallback_to_warn) {
          const result = executeDirect(command, options);
          result.content =
            '[SANDBOX WARNING] socat is not available — cannot isolate network. ' +
            'Command executed without network isolation.\n' +
            'Install socat: apt install socat / dnf install socat\n\n' +
            result.content;
          result.summary = 'sandbox=warn | ' + result.summary;
          return result;
        }
        return executeDirect(command, options);
      }

      // Check bwrap availability fresh on each execute call
      const bwrapAvailable = isBwrapAvailable();

      // If bwrap is unavailable, fall back to direct execution
      if (!bwrapAvailable) {
        if (config.fallback_to_warn) {
          const result = executeDirect(command, options);
          result.content =
            '[SANDBOX WARNING] bwrap is not available on this system. ' +
            'Command executed without filesystem isolation.\n' +
            'Install bubblewrap: apt install bubblewrap / dnf install bubblewrap\n\n' +
            result.content;
          result.summary = 'sandbox=warn | ' + result.summary;
          result.keyOutput = result.keyOutput
            ? 'bwrap not available — running without sandbox\n' + result.keyOutput
            : 'bwrap not available — running without sandbox';
          return result;
        }
        return executeDirect(command, options);
      }

      // Assign a unique port for the per-command socat forwarder
      const proxyPort = await findFreePort();
      return executeInBwrap(command, policy, { ...options, proxyPort });
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
      shell: process.platform === 'win32'
        ? (process.env.ComSpec || 'cmd.exe')
        : (process.env.SHELL || '/bin/sh'),
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
    return {
      content: (out || err.message) + `\nexit code: ${code}`,
      summary: `exit=${code} | ${(out || err.message).slice(0, 80)}`,
      exitCode: code,
      keyOutput: out.slice(0, 300),
      isError: true,
    };
  }
}
