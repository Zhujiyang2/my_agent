// src/tools/sandbox/__tests__/register-writable.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRegisterWritableTool } from '../register-writable';
import { createSandboxManager, setSandboxManager } from '../../../sandbox/sandbox-manager';
import { DEFAULT_SANDBOX_CONFIG } from '../../../sandbox/types';
import fs from 'node:fs';

describe('register_writable_path tool', () => {
  let mgr: ReturnType<typeof createSandboxManager>;

  beforeEach(() => {
    mgr = createSandboxManager(DEFAULT_SANDBOX_CONFIG);
    setSandboxManager(mgr);
  });

  afterEach(() => {
    setSandboxManager(null);
  });

  it('has correct name', () => {
    const tool = createRegisterWritableTool();
    expect(tool.name).toBe('register_writable_path');
  });

  it('registers a valid path', async () => {
    const tool = createRegisterWritableTool();
    // Use a Unix-style path for testing — sandbox is a Linux feature
    const tmpDir = `/tmp/rw-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await tool.handler({ path: tmpDir });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('registered');
    } finally {
      mgr.unregisterWritable(tmpDir);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
