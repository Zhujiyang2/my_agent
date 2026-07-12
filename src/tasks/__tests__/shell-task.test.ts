// src/tasks/__tests__/shell-task.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnCommand } from '../shell-task';

const TEST_DIR = path.join(os.tmpdir(), 'my-agent-shell-test');

describe('spawnCommand', () => {
  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('normal command returns exitCode=0', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const outputPath = path.join(TEST_DIR, 'test.output');

    const { pid, promise } = spawnCommand({
      command: 'echo hello',
      taskId: 'test-001',
      outputPath,
    });

    expect(pid).toBeGreaterThan(0);
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.spawnError).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('failing command returns non-zero exitCode', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const { promise } = spawnCommand({
      command: 'exit 42',
      taskId: 'test-002',
      outputPath: path.join(TEST_DIR, 's2.output'),
    });

    const result = await promise;
    expect(result.exitCode).toBe(42);
  });

  it('stdout and stderr are streamed to single output file', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const outputPath = path.join(TEST_DIR, 's3.output');

    const { promise } = spawnCommand({
      command: 'echo line1 && echo line2 && echo err-msg >&2',
      taskId: 'test-003',
      outputPath,
    });

    await promise;
    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
    expect(content).toContain('err-msg');
  });
});
