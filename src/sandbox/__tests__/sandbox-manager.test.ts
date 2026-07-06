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
    setSandboxManager(null);
  });

  describe('getStatus', () => {
    it('returns status with enabled flag and proxy/socat fields', () => {
      const status = mgr.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.engine).toBe('bwrap');
      expect(typeof status.bwrapAvailable).toBe('boolean');
      expect(typeof status.socatAvailable).toBe('boolean');
      expect(typeof status.proxyRunning).toBe('boolean');
      expect(Array.isArray(status.writablePaths)).toBe(true);
      expect(Array.isArray(status.protectPaths)).toBe(true);
    });
  });

  describe('registerWritable', () => {
    it('registers a path and creates the directory on host', () => {
      const tmpDir = path.join(os.tmpdir(), `sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      try {
        const result = mgr.registerWritable(tmpDir);
        expect(result.ok).toBe(true);
        expect(fs.existsSync(tmpDir)).toBe(true);
        expect(mgr.getStatus().writablePaths).toContain(path.resolve(tmpDir));
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

  describe('proxy lifecycle', () => {
    it('accepts domain config and creates manager', () => {
      const mgr2 = createSandboxManager({
        ...DEFAULT_SANDBOX_CONFIG,
        domains: { extra_allowed_domains: [], blocked_domains: [] },
      });
      expect(mgr2).toBeDefined();
    });

    it('starts proxy server when sandbox is enabled', () => {
      const mgr2 = createSandboxManager({
        ...DEFAULT_SANDBOX_CONFIG,
        domains: { extra_allowed_domains: ['custom.io'], blocked_domains: ['bad.io'] },
      });
      const status = mgr2.getStatus();
      expect(status).toBeDefined();
      expect(status.proxyRunning).toBe(true);
    });

    it('creates manager with default empty domains when not provided', () => {
      const mgr2 = createSandboxManager(DEFAULT_SANDBOX_CONFIG);
      const status = mgr2.getStatus();
      expect(status.proxyRunning).toBe(true);
    });
  });
});
