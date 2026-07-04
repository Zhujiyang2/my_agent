// src/tools/memory/__tests__/memory-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMemoryManager, type MemoryManager } from '../../../memory/index';
import { createRememberTool } from '../remember';
import { createForgetTool } from '../forget';

const TEST_DIR = path.join(os.tmpdir(), `memory-tools-test-${Date.now()}`);

describe('remember tool', () => {
  let mm: MemoryManager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    mm = createMemoryManager({
      enabled: true,
      user_budget: 4000,
      agent_budget: 2000,
      compress_threshold: 5,
      memoryDir: TEST_DIR,
    });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('has correct name and parameters', () => {
    const tool = createRememberTool(mm);
    expect(tool.name).toBe('remember');
    expect(tool.parameters.required).toContain('name');
    expect(tool.parameters.required).toContain('description');
    expect(tool.parameters.required).toContain('content');
    expect(tool.parameters.required).toContain('type');
    expect(tool.parameters.properties.type.enum).toEqual(['user', 'agent']);
  });

  it('writes a user memory and returns confirmation', async () => {
    const tool = createRememberTool(mm);
    const result = await tool.handler({
      name: 'prefer-react',
      description: '用户偏好 React + TypeScript',
      content: '在前端项目中偏好使用 React。',
      type: 'user',
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain('prefer-react');

    const names = await mm.list();
    expect(names).toContain('prefer-react');
  });

  it('rejects invalid name', async () => {
    const tool = createRememberTool(mm);
    const result = await tool.handler({
      name: 'Invalid Name!',
      description: 'Test',
      content: 'Content.',
      type: 'user',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid memory name');
  });

  it('rejects invalid type', async () => {
    const tool = createRememberTool(mm);
    const result = await tool.handler({
      name: 'test',
      description: 'Test',
      content: 'Content.',
      type: 'invalid',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('type');
  });

  it('warns when content was sanitized', async () => {
    const tool = createRememberTool(mm);
    const result = await tool.handler({
      name: 'test',
      description: 'Test with password',
      content: 'password=secret123',
      type: 'user',
    });

    expect(result.content).toContain('sanitized');
  });
});

describe('forget tool', () => {
  let mm: MemoryManager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    mm = createMemoryManager({
      enabled: true,
      user_budget: 4000,
      agent_budget: 2000,
      compress_threshold: 5,
      memoryDir: TEST_DIR,
    });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('has correct name and parameters', () => {
    const tool = createForgetTool(mm);
    expect(tool.name).toBe('forget');
    expect(tool.parameters.required).toContain('name');
  });

  it('deletes a memory', async () => {
    await mm.remember({ name: 'temp', description: 'Temp', content: 'Content.', type: 'user' });

    const tool = createForgetTool(mm);
    const result = await tool.handler({ name: 'temp' });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain('temp');

    const names = await mm.list();
    expect(names).not.toContain('temp');
  });

  it('returns error for non-existent memory', async () => {
    const tool = createForgetTool(mm);
    const result = await tool.handler({ name: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });
});
