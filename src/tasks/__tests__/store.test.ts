// src/tasks/__tests__/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTaskStore } from '../store';
import type { Task } from '../types';

const TEST_DIR = path.join(process.cwd(), '.my_agent', 'state-test');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'job-test-001',
    type: 'shell',
    command: 'echo hello',
    workdir: '/tmp',
    status: 'running',
    pid: 12345,
    exitCode: null,
    signal: null,
    outputPath: path.join(TEST_DIR, 'jobs', 'job-test-001.output'),
    createdAt: Date.now(),
    finishedAt: null,
    timeoutMs: null,
    tailBuffer: '',
    escalationTimer: null,
    recoveryPollerId: null,
    result: null,
    ...overrides,
  };
}

describe('TaskStore', () => {
  let store: ReturnType<typeof createTaskStore>;

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    store = createTaskStore(TEST_DIR);
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('saveTasks + loadTasks roundtrip', async () => {
    const tasks = [makeTask(), makeTask({ id: 'job-test-002', status: 'completed' })];
    await store.saveTasks(tasks);
    const loaded = await store.loadTasks();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('job-test-001');
    expect(loaded[1].id).toBe('job-test-002');
  });

  it('empty list roundtrip', async () => {
    await store.saveTasks([]);
    const loaded = await store.loadTasks();
    expect(loaded).toEqual([]);
  });

  it('appendOutput + readOutput roundtrip', async () => {
    await store.appendOutput('job-test-001', 'line 1\n');
    await store.appendOutput('job-test-001', 'line 2\n');
    const output = await store.readOutput('job-test-001');
    expect(output).toContain('line 1');
    expect(output).toContain('line 2');
  });

  it('readOutput lines param returns last N lines', async () => {
    for (let i = 1; i <= 50; i++) {
      await store.appendOutput('job-test-001', `line ${i}\n`);
    }
    const output = await store.readOutput('job-test-001', 3);
    const lines = output.trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('line 48');
    expect(lines[2]).toContain('line 50');
  });

  it('readOutput returns empty string for missing file', async () => {
    const output = await store.readOutput('nonexistent');
    expect(output).toBe('');
  });

  it('output captures both stdout and stderr', async () => {
    await store.appendOutput('job-test-001', 'out\n');
    await store.appendOutput('job-test-001', 'err\n');
    const output = await store.readOutput('job-test-001');
    expect(output).toContain('out');
    expect(output).toContain('err');
  });

  it('atomic write leaves no .tmp file', async () => {
    await store.saveTasks([makeTask()]);
    const tmpPath = path.join(TEST_DIR, 'tasks.json.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});
