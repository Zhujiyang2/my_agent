// src/tools/files/__tests__/read-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileTool } from '../read-file';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('readFileTool', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), 'my-agent-read-test-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    testFile = path.join(testDir, 'sample.txt');
    fs.writeFileSync(testFile, 'line1\nline2\nline3\nline4\nline5\n');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('has correct name', () => {
    expect(readFileTool.name).toBe('read_file');
  });

  it('reads entire file with line numbers', async () => {
    const result = await readFileTool.handler({ path: testFile });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('1: line1');
    expect(result.content).toContain('5: line5');
  });

  it('reads a range with offset and limit', async () => {
    const result = await readFileTool.handler({ path: testFile, offset: 1, limit: 2 });
    expect(result.content).toContain('2: line2');
    expect(result.content).toContain('3: line3');
    expect(result.content).not.toContain('1: line1');
    expect(result.content).not.toContain('4: line4');
  });

  it('returns error for nonexistent file', async () => {
    const result = await readFileTool.handler({ path: '/nonexistent/file.txt' });
    expect(result.isError).toBe(true);
  });
});
