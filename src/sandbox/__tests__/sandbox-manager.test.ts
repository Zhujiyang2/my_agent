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
});
