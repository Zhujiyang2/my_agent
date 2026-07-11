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
    const stdoutPath = path.join(TEST_DIR, 'test.stdout');
    const stderrPath = path.join(TEST_DIR, 'test.stderr');
    const exitPath = path.join(TEST_DIR, 'test.exit');

    const { pid, promise } = spawnCommand({
      command: 'echo hello',
      taskId: 'test-001',
      stdoutPath,
      stderrPath,
      exitFilePath: exitPath,
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
      stdoutPath: path.join(TEST_DIR, 's2.stdout'),
      stderrPath: path.join(TEST_DIR, 's2.stderr'),
      exitFilePath: path.join(TEST_DIR, 's2.exit'),
    });

    const result = await promise;
    expect(result.exitCode).toBe(42);
  });

  it('stdout is streamed to file', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const stdoutPath = path.join(TEST_DIR, 's3.stdout');

    const { promise } = spawnCommand({
      command: 'echo line1 && echo line2',
      taskId: 'test-003',
      stdoutPath,
      stderrPath: path.join(TEST_DIR, 's3.stderr'),
      exitFilePath: path.join(TEST_DIR, 's3.exit'),
    });

    await promise;
    const content = fs.readFileSync(stdoutPath, 'utf-8');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
  });

  it('stderr is streamed to separate file', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const stderrPath = path.join(TEST_DIR, 's5.stderr');

    const { promise } = spawnCommand({
      command: 'echo err-msg >&2',
      taskId: 'test-005',
      stdoutPath: path.join(TEST_DIR, 's5.stdout'),
      stderrPath,
      exitFilePath: path.join(TEST_DIR, 's5.exit'),
    });

    await promise;
    const content = fs.readFileSync(stderrPath, 'utf-8');
    expect(content).toContain('err-msg');
  });

  it('exit file is written on completion', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const exitPath = path.join(TEST_DIR, 's6.exit');

    const { promise } = spawnCommand({
      command: 'echo done',
      taskId: 'test-006',
      stdoutPath: path.join(TEST_DIR, 's6.stdout'),
      stderrPath: path.join(TEST_DIR, 's6.stderr'),
      exitFilePath: exitPath,
    });

    await promise;
    expect(fs.existsSync(exitPath)).toBe(true);
    const exitData = JSON.parse(fs.readFileSync(exitPath, 'utf-8'));
    expect(exitData.exitCode).toBe(0);
  });
});
