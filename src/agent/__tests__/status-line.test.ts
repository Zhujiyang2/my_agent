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
    stdoutPath: path.join(TEST_DIR, 'jobs', 'test.stdout'),
    stderrPath: path.join(TEST_DIR, 'jobs', 'test.stderr'),
    exitFilePath: path.join(TEST_DIR, 'jobs', 'test.exit'),
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
    sl = createStatusLine({ intervalMs: 99999 }); // long interval to avoid auto-fire
  });

  describe('renderStatusLine', () => {
    it('returns empty string for empty task list', () => {
      expect(sl.renderStatusLine([])).toBe('');
    });

    it('shows running task count in collapsed mode', () => {
      const tasks = [makeTask()];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('1 running');
    });

    it('shows completed task status', () => {
      const tasks = [makeTask({
        id: 'job-abc123',
        status: 'completed',
        exitCode: 0,
        finishedAt: Date.now(),
      })];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('completed');
    });

    it('shows failed task status', () => {
      const tasks = [makeTask({
        id: 'job-fail01',
        status: 'failed',
        exitCode: 1,
        finishedAt: Date.now(),
      })];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('failed');
    });

    it('handles mixed running and completed tasks in collapsed mode', () => {
      const tasks = [
        makeTask({ id: 'job-run-1', status: 'running' }),
        makeTask({ id: 'job-done-1', status: 'completed', exitCode: 0, finishedAt: Date.now() }),
      ];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('1 running');
      expect(result).toContain('completed');
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

  describe('toggle', () => {
    it('toggles expanded mode', () => {
      const tasks = [makeTask()];
      const collapsed = sl.renderStatusLine(tasks);
      sl.toggle();
      const expanded = sl.renderStatusLine(tasks);
      // Expanded has more lines (footer "Ctrl+O to collapse")
      const collapsedLines = collapsed.split('\n').length;
      const expandedLines = expanded.split('\n').length;
      expect(expandedLines).toBeGreaterThan(collapsedLines);
    });
  });
});
