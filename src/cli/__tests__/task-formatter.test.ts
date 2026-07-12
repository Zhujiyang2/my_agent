import { describe, it, expect } from 'vitest';
import { formatTaskLines } from '../task-formatter';
import type { Task } from '../../tasks/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  const defaults: Task = {
    id: 'task-123456789012',
    type: 'shell',
    command: 'echo hello',
    workdir: '/tmp',
    status: 'running',
    pid: 12345,
    exitCode: null,
    signal: null,
    outputPath: '/tmp/output',
    createdAt: Date.now() - 30_000,
    finishedAt: null,
    timeoutMs: null,
    tailBuffer: '',
    escalationTimer: null,
    recoveryPollerId: null,
    result: null,
  };
  return { ...defaults, ...overrides };
}

function noProgress(_t: Task): null {
  return null;
}

describe('formatTaskLines', () => {
  it('returns only the collapse hint when no tasks exist', () => {
    const result = formatTaskLines([], noProgress);
    expect(result).toEqual(['\x1b[2m┃ (no running tasks)\x1b[0m']);
  });

  it('shows only running tasks, filtering out completed/failed/timeout/killed tasks', () => {
    const running = makeTask({ id: 'task-aaaaaaaaaaaa', status: 'running', command: 'npm test' });
    const completed = makeTask({ id: 'task-bbbbbbbbbbbb', status: 'completed', command: 'npm build' });
    const failed = makeTask({ id: 'task-cccccccccccc', status: 'failed', command: 'npm lint' });
    const timeout = makeTask({ id: 'task-dddddddddddd', status: 'timeout', command: 'npm audit' });
    const killed = makeTask({ id: 'task-eeeeeeeeeeee', status: 'killed', command: 'npm clean' });

    const result = formatTaskLines([running, completed, failed, timeout, killed], noProgress);

    expect(result).toHaveLength(2); // 1 running task + collapse hint
    expect(result[0]).toContain('aaaaaaaaaaaa');
    expect(result[0]).toContain('npm test');
    expect(result[0]).not.toContain('bbbbbbbbbbbb');
    expect(result[0]).not.toContain('cccccccccccc');
    expect(result[0]).not.toContain('dddddddddddd');
    expect(result[0]).not.toContain('eeeeeeeeeeee');
    expect(result[1]).toBe('\x1b[2m┃ Ctrl+O to collapse\x1b[0m');
  });

  it('shows "(no running tasks)" when tasks exist but none are running', () => {
    const completed = makeTask({ id: 'task-bbbbbbbbbbbb', status: 'completed', command: 'npm build' });
    const result = formatTaskLines([completed], noProgress);
    expect(result).toEqual(['\x1b[2m┃ (no running tasks)\x1b[0m']);
  });

  it('shows elapsed time for running tasks', () => {
    const running = makeTask({ createdAt: Date.now() - 120_000, command: 'sleep 120' });
    const result = formatTaskLines([running], noProgress);
    expect(result[0]).toMatch(/120s/);
  });

  it('shows progress percentage when tailBuffer contains progress info', () => {
    const running = makeTask({ tailBuffer: 'Downloading... 75% complete' });
    const progressFn = (t: Task) => {
      const m = t.tailBuffer.match(/(\d+)%/);
      return m ? parseInt(m[1], 10) : null;
    };
    const result = formatTaskLines([running], progressFn);
    expect(result[0]).toContain('75%');
  });

  it('truncates long commands to 60 characters', () => {
    const longCmd = 'a'.repeat(100);
    const running = makeTask({ command: longCmd });
    const result = formatTaskLines([running], noProgress);
    expect(result[0]).toContain('a'.repeat(57) + '...');
    expect(result[0]).not.toContain('a'.repeat(100));
  });

  it('shows task ID suffix (last 12 chars) in each line', () => {
    const running = makeTask({ id: 'task-deadbeefcafe' });
    const result = formatTaskLines([running], noProgress);
    expect(result[0]).toContain('deadbeefcafe');
  });

  it('handles multiple running tasks', () => {
    const r1 = makeTask({ id: 'task-aaaaaaaaaaaa', command: 'task-a' });
    const r2 = makeTask({ id: 'task-bbbbbbbbbbbb', command: 'task-b' });
    const r3 = makeTask({ id: 'task-cccccccccccc', command: 'task-c' });

    const result = formatTaskLines([r1, r2, r3], noProgress);

    expect(result).toHaveLength(4); // 3 tasks + collapse hint
    expect(result[0]).toContain('task-a');
    expect(result[1]).toContain('task-b');
    expect(result[2]).toContain('task-c');
    expect(result[3]).toBe('\x1b[2m┃ Ctrl+O to collapse\x1b[0m');
  });
});
