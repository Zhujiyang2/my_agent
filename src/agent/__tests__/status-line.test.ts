// src/agent/__tests__/status-line.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStatusLine } from '../status-line';
import { createTaskRegistry, setTaskRegistry, getTaskRegistry } from '../../tasks/registry';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Task } from '../../tasks/types';

const TEST_DIR = path.join(os.tmpdir(), 'my-agent-status-test');

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
    outputPath: path.join(TEST_DIR, 'jobs', 'test.output'),
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

describe('createStatusLine', () => {
  let sl: ReturnType<typeof createStatusLine>;

  beforeEach(() => {
    sl = createStatusLine();
  });

  describe('renderStatusLine', () => {
    it('returns empty string for empty task list', () => {
      expect(sl.renderStatusLine([])).toBe('');
    });

    it('shows running count and task name', () => {
      const tasks = [
        makeTask({ id: 'job-run-1', status: 'running', command: 'npm build' }),
      ];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('1 running');
      expect(result).toContain('npm build');
    });

    it('shows multiple running tasks each on their own line', () => {
      const tasks = [
        makeTask({ id: 'job-run-1', status: 'running', command: 'npm build' }),
        makeTask({ id: 'job-run-2', status: 'running', command: 'npm test' }),
      ];
      const result = sl.renderStatusLine(tasks);
      const lines = result.split('\n');
      expect(lines[0]).toContain('2 running');
      expect(lines[1]).toContain('npm build');
      expect(lines[2]).toContain('npm test');
    });

    it('filters out non-running tasks', () => {
      const tasks = [
        makeTask({ id: 'job-run-1', status: 'running', command: 'npm build' }),
        makeTask({ id: 'job-done-1', status: 'completed', exitCode: 0, finishedAt: Date.now(), command: 'npm lint' }),
      ];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('1 running');
      expect(result).toContain('npm build');
      expect(result).not.toContain('npm lint');
    });

    it('does not show completed task when no running tasks', () => {
      const tasks = [makeTask({
        id: 'job-abc123',
        status: 'completed',
        exitCode: 0,
        finishedAt: Date.now(),
        command: 'npm build',
      })];
      const result = sl.renderStatusLine(tasks);
      expect(result).toBe('');
    });

    it('does not show failed task when no running tasks', () => {
      const tasks = [makeTask({
        id: 'job-fail01',
        status: 'failed',
        exitCode: 1,
        finishedAt: Date.now(),
        command: 'npm test',
      })];
      const result = sl.renderStatusLine(tasks);
      expect(result).toBe('');
    });

    it('truncates long command names to 60 chars', () => {
      const longCmd = 'a'.repeat(100);
      const tasks = [makeTask({ id: 'job-run-1', status: 'running', command: longCmd })];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('a'.repeat(57) + '...');
      expect(result).not.toContain('a'.repeat(100));
    });

    it('shows only running tasks when mix of statuses', () => {
      const tasks = [
        makeTask({ id: 'job-run-1', status: 'running', command: 'npm build' }),
        makeTask({ id: 'job-done-1', status: 'completed', exitCode: 0, finishedAt: Date.now(), command: 'npm lint' }),
      ];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('1 running');
      expect(result).toContain('npm build');
      expect(result).not.toContain('completed');
      expect(result).not.toContain('failed');
    });
  });

  describe('extractProgress', () => {
    it('extracts percentage from tailBuffer', () => {
      const progress = sl.extractProgress(
        makeTask({ tailBuffer: 'Downloading... 45% complete' })
      );
      expect(progress).toBe(45);
    });

    it('extracts fraction as percentage', () => {
      const progress = sl.extractProgress(
        makeTask({ tailBuffer: 'Processing 50/200 items' })
      );
      expect(progress).toBe(25);
    });

    it('returns null when no progress indicator found', () => {
      const progress = sl.extractProgress(
        makeTask({ tailBuffer: 'Just some output' })
      );
      expect(progress).toBeNull();
    });

    it('returns null for empty tailBuffer', () => {
      const progress = sl.extractProgress(makeTask({ tailBuffer: '' }));
      expect(progress).toBeNull();
    });

    it('clamps percentage to 0-100 range', () => {
      const progress = sl.extractProgress(
        makeTask({ tailBuffer: '150% done (overflow)' })
      );
      expect(progress).toBeNull(); // >100 should not be treated as progress
    });
  });
});
