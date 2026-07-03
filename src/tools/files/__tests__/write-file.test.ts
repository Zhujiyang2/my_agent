// src/tools/files/__tests__/write-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileTool } from '../write-file';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('writeFileTool', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), 'my-agent-write-test-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    testFile = path.join(testDir, 'output.txt');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('has correct name', () => {
    expect(writeFileTool.name).toBe('write_file');
  });

  it('creates a new file with content', async () => {
    const result = await writeFileTool.handler({ path: testFile, content: 'hello world' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Created');
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('hello world');
  });

  it('overwrites an existing file', async () => {
    fs.writeFileSync(testFile, 'old content');
    const result = await writeFileTool.handler({ path: testFile, content: 'new content' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Overwritten');
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('new content');
  });

  it('returns error for invalid path', async () => {
    // Create a file, then try to write to <file>/sub — this will fail
    const blockerFile = path.join(testDir, 'blocker');
    fs.writeFileSync(blockerFile, 'block');
    const result = await writeFileTool.handler({ path: path.join(blockerFile, 'sub', 'output.txt'), content: 'test' });
    expect(result.isError).toBe(true);
  });

  it('creates parent directories if needed', async () => {
    const deepFile = path.join(testDir, 'deep', 'nested', 'file.txt');
    const result = await writeFileTool.handler({ path: deepFile, content: 'deep' });
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(deepFile, 'utf-8')).toBe('deep');
  });
});
