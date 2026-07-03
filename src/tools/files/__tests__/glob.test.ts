// src/tools/files/__tests__/glob.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { globTool } from '../glob';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('globTool', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), 'my-agent-glob-test-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'a.log'), 'log-a');
    fs.writeFileSync(path.join(testDir, 'b.log'), 'log-b');
    fs.writeFileSync(path.join(testDir, 'c.txt'), 'txt');
    fs.mkdirSync(path.join(testDir, 'sub'));
    fs.writeFileSync(path.join(testDir, 'sub', 'd.log'), 'log-d');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('has correct metadata', () => {
    expect(globTool.name).toBe('glob');
    expect(globTool.description).toContain('find');
  });

  it('finds files matching *.log in a directory', async () => {
    const result = await globTool.handler({ pattern: '*.log', workdir: testDir });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('a.log');
    expect(result.content).toContain('b.log');
    expect(result.content).not.toContain('c.txt');
  });

  it('finds files recursively with ** prefix', async () => {
    const result = await globTool.handler({ pattern: '**/*.log', workdir: testDir });
    expect(result.content).toContain('a.log');
    expect(result.content).toContain('b.log');
    expect(result.content).toContain('d.log');
  });

  it('returns empty when no files match', async () => {
    const result = await globTool.handler({ pattern: '*.xyz', workdir: testDir });
    expect(result.content).toBe('');
  });

  it('returns error for nonexistent directory', async () => {
    const result = await globTool.handler({ pattern: '*', workdir: '/nonexistent/path' });
    expect(result.isError).toBe(true);
  });

  it('returns structured ToolResult with summary and exitCode', async () => {
    const result = await globTool.handler({ pattern: '*.log', workdir: testDir });
    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(result.exitCode).toBe(0);
    expect(result.keyOutput).toBeDefined();
  });

  it('returns exitCode 1 for glob error', async () => {
    const result = await globTool.handler({ pattern: '*', workdir: '/nonexistent/path' });
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
  });
});
