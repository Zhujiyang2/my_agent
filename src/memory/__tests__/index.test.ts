// src/memory/__tests__/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMemoryManager, type MemoryManager } from '../index';
import type { MemoryConfig } from '../types';

const TEST_DIR = path.join(os.tmpdir(), `my-agent-memory-mgr-${Date.now()}`);

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: true,
    user_budget: 4000,
    agent_budget: 2000,
    compress_threshold: 5,
    memoryDir: TEST_DIR,
    ...overrides,
  };
}

describe('createMemoryManager', () => {
  let mgr: MemoryManager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    mgr = createMemoryManager(makeConfig());
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('remembers a user memory and assembles it', async () => {
    await mgr.remember({
      name: 'prefer-react',
      description: '用户偏好 React + TypeScript',
      content: '用户在前端项目中偏好使用 React。\n\n**Why:** 生态丰富。',
      type: 'user',
    });

    const result = mgr.assemble();
    expect(result).not.toBeNull();
    expect(result).toContain('## User Memories');
    expect(result).toContain('prefer-react');
    expect(result).toContain('用户在前端项目中偏好使用 React');
  });

  it('remembers an agent memory and assembles it', async () => {
    await mgr.remember({
      name: 'refactored-context',
      description: 'Context 模块已重构',
      content: '上月重构了 ContextManager，使用双层架构。',
      type: 'agent',
    });

    const result = mgr.assemble();
    expect(result).toContain('## Agent Memories');
    expect(result).toContain('refactored-context');
  });

  it('forgets a memory', async () => {
    await mgr.remember({
      name: 'temp-memory',
      description: 'Temporary',
      content: 'Should be deleted.',
      type: 'user',
    });

    await mgr.forget('temp-memory');

    const result = mgr.assemble();
    expect(result).toBeNull();
  });

  it('forget on non-existent name does not throw', async () => {
    await expect(mgr.forget('nonexistent')).resolves.toBeUndefined();
  });

  it('lists all memory names', async () => {
    await mgr.remember({ name: 'alpha', description: 'A', content: 'Content A', type: 'user' });
    await mgr.remember({ name: 'beta', description: 'B', content: 'Content B', type: 'agent' });

    const names = await mgr.list();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toHaveLength(2);
  });

  it('overwrites existing memory', async () => {
    await mgr.remember({ name: 'test', description: 'First', content: 'Old content.', type: 'user' });
    await mgr.remember({ name: 'test', description: 'Updated', content: 'New content.', type: 'user' });

    const result = mgr.assemble();
    expect(result).toContain('New content.');
    expect(result).not.toContain('Old content.');
  });

  it('returns null from assemble when no memories exist', () => {
    const result = mgr.assemble();
    expect(result).toBeNull();
  });

  it('sanitizes sensitive content before saving', async () => {
    await mgr.remember({
      name: 'test',
      description: 'Test',
      content: 'My password=secret123 should be redacted.',
      type: 'user',
    });

    const result = mgr.assemble();
    expect(result).not.toContain('secret123');
    expect(result).toContain('[REDACTED]');
  });
});
