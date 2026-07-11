// src/tasks/registry.ts
import fs from 'node:fs';
import path from 'node:path';
import { createTaskStore } from './store';
import { spawnCommand } from './shell-task';
import type { Task, TaskStatus, TaskType, ShellTaskResult } from './types';

function generateId(): string {
  const ts = Date.now();
  const hex = Math.random().toString(16).slice(2, 8);
  return `job-${ts}-${hex}`;
}

const ESCALATION_DELAY_MS = 5000;

/** Terminal statuses — exit callback must not overwrite these. */
const TERMINAL_BY_KILL: ReadonlySet<TaskStatus> = new Set(['killed', 'timeout']);

export function createTaskRegistry(stateDir: string) {
  const tasks = new Map<string, Task>();
  const store = createTaskStore(stateDir);
  const completeCallbacks: Array<(task: Task) => void> = [];
  // Separate map for non-serializable timer handles (type-safe, no casts)
  const timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function save(): Promise<void> {
    const taskList = Array.from(tasks.values()).filter(t => t.status !== 'completed');
    await store.saveTasks(taskList);
  }

  function spawn(command: string, opts?: {
    workdir?: string;
    timeoutMs?: number | null;
    env?: Record<string, string>;
    label?: string;
  }): Task {
    const id = generateId();
    const jobDir = store.getJobDir();
    const outputPath = path.join(jobDir, `${id}.output`);

    const task: Task = {
      id,
      type: 'shell',
      command,
      workdir: opts?.workdir ?? process.cwd(),
      env: opts?.env,
      status: 'running',
      pid: null,
      exitCode: null,
      signal: null,
      outputPath,
      createdAt: Date.now(),
      finishedAt: null,
      timeoutMs: opts?.timeoutMs !== undefined ? opts.timeoutMs : null,
      tailBuffer: '',
      escalationTimer: null,
      recoveryPollerId: null,
      result: null,
    };

    let child: { pid: number; promise: Promise<ShellTaskResult> };
    try {
      child = spawnCommand({
        command,
        workdir: task.workdir,
        env: task.env,
        taskId: id,
        outputPath,
      });
      task.pid = child.pid;
    } catch (err) {
      task.status = 'failed';
      task.result = {
        exitCode: -1,
        signal: null,
        durationMs: 0,
        killed: false,
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      };
      tasks.set(id, task);
      return task;
    }

    tasks.set(id, task);

    // ── tailBuffer: capture live stdout for progress extraction ──
    // spawnCommand pipes stdout/stderr directly to files via stream.
    // We add a lightweight memory buffer by reading the file snapshot
    // periodically via a short interval (first 30s only, to limit overhead).
    const tailTimer = setInterval(async () => {
      const t = tasks.get(id);
      if (!t || t.status !== 'running') {
        clearInterval(tailTimer);
        return;
      }
      try {
        const out = await store.readOutput(id, 5);
        if (out) t.tailBuffer = out;
      } catch { /* ignore read errors */ }
    }, 2000);
    // Stop tail polling after 60s (progress bars are most useful early)
    setTimeout(() => clearInterval(tailTimer), 60_000);

    // ── Timeout management ──
    if (task.timeoutMs !== null && task.timeoutMs > 0) {
      const timer = setTimeout(() => {
        const t = tasks.get(id);
        if (t && t.status === 'running') {
          killTaskInstance(t, 'SIGTERM');
          t.status = 'timeout';
          t.signal = 'SIGTERM';
          t.result = {
            exitCode: -1,
            signal: 'SIGTERM',
            durationMs: Date.now() - t.createdAt,
            killed: true,
            timedOut: true,
            spawnError: null,
          };
        }
      }, task.timeoutMs);
      timeoutTimers.set(id, timer);
    }

    // ── Process exit callback ──
    child.promise.then((result) => {
      const t = tasks.get(id);
      if (!t) return;

      // Clear timeout timer
      const timer = timeoutTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        timeoutTimers.delete(id);
      }

      // Clear escalation timer
      if (t.escalationTimer !== null) {
        clearTimeout(t.escalationTimer);
        t.escalationTimer = null;
      }

      // Preserve terminal status set by kill() or timeout handler.
      // Only auto-set completed/failed when status is still 'running'.
      if (t.status === 'running') {
        t.status = result.exitCode === 0 ? 'completed' : 'failed';
      }
      // Merge per-command result fields, but preserve timeout/kill flags
      const wasTerminal = TERMINAL_BY_KILL.has(t.status);
      t.exitCode = wasTerminal ? (t.result?.exitCode ?? result.exitCode) : result.exitCode;
      t.signal = wasTerminal ? (t.result?.signal ?? result.signal) : result.signal;
      t.finishedAt = Date.now();
      if (!wasTerminal) {
        t.result = result;
      }
      // Ensure result is always set
      if (!t.result) t.result = result;

      save().catch(() => {});
      for (const cb of completeCallbacks) {
        try { cb(t); } catch { /* ignore */ }
      }

      // Auto-clean successful tasks after callbacks have had a chance to read output
      if (t.status === 'completed') {
        setTimeout(() => {
          try { fs.unlinkSync(t.outputPath); } catch { /* file already gone */ }
          tasks.delete(id);
          timeoutTimers.delete(id);
          save().catch(() => {});
        }, 0);
      }
    });

    return task;
  }

  function killTaskInstance(task: Task, signal: 'SIGTERM' | 'SIGKILL'): boolean {
    if (task.status !== 'running' || task.pid === null) return false;

    try {
      process.kill(task.pid, signal);
    } catch {
      return false;
    }

    // Mark killed immediately — exit callback will respect this terminal status
    task.status = 'killed';
    task.signal = signal;

    return true;
  }

  function kill(id: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): boolean {
    const task = tasks.get(id);
    if (!task || task.status !== 'running' || task.pid === null) return false;

    // Clear escalation timer
    if (task.escalationTimer !== null) {
      clearTimeout(task.escalationTimer);
      task.escalationTimer = null;
    }

    const ok = killTaskInstance(task, signal);
    if (!ok) return false;

    if (signal === 'SIGTERM') {
      task.escalationTimer = setTimeout(() => {
        const t = tasks.get(id);
        // Only escalate if task is still running (process hasn't exited yet)
        if (!t || t.status !== 'running') return;
        try {
          process.kill(task.pid!, 'SIGKILL');
        } catch { /* already dead */ }
        task.status = 'killed';
        task.signal = 'SIGKILL';
        save().catch(() => {});
      }, ESCALATION_DELAY_MS);
    }

    save().catch(() => {});
    return true;
  }

  function get(id: string): Task | undefined {
    return tasks.get(id);
  }

  function list(filter?: { status?: TaskStatus | TaskStatus[]; type?: TaskType }): Task[] {
    let result = Array.from(tasks.values());
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      result = result.filter(t => statuses.includes(t.status));
    }
    if (filter?.type) {
      result = result.filter(t => t.type === filter.type);
    }
    return result;
  }

  function waitFor(id: string): Promise<ShellTaskResult> {
    const task = tasks.get(id);
    if (!task) return Promise.reject(new Error(`Task ${id} not found`));
    if (task.result) return Promise.resolve(task.result);

    return new Promise((resolve, reject) => {
      const cleanup = onTaskComplete((completed) => {
        if (completed.id === id) {
          cleanup();
          if (completed.result) {
            resolve(completed.result);
          } else {
            reject(new Error(`Task ${id} completed without result`));
          }
        }
      });
    });
  }

  function onTaskComplete(callback: (task: Task) => void): () => void {
    completeCallbacks.push(callback);
    return () => {
      const idx = completeCallbacks.indexOf(callback);
      if (idx >= 0) completeCallbacks.splice(idx, 1);
    };
  }

  function cleanup(opts?: {
    olderThanDays?: number;
    statuses?: TaskStatus[];
  }): { deleted: number; freedBytes: number } {
    const olderThanDays = opts?.olderThanDays ?? 7;
    const statuses = opts?.statuses ?? ['completed', 'failed', 'killed', 'timeout', 'lost'];
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let freedBytes = 0;

    for (const [id, task] of tasks) {
      if (!statuses.includes(task.status)) continue;
      if (task.finishedAt !== null && task.finishedAt > cutoff) continue;
      if (task.finishedAt === null && task.createdAt > cutoff) continue;

      try {
        const stat = fs.statSync(task.outputPath);
        freedBytes += stat.size;
        fs.unlinkSync(task.outputPath);
      } catch { /* file doesn't exist */ }
      tasks.delete(id);
      timeoutTimers.delete(id);
      deleted++;
    }

    save().catch(() => {});
    return { deleted, freedBytes };
  }

  function destroy(): void {
    for (const [, timer] of timeoutTimers) {
      clearTimeout(timer);
    }
    timeoutTimers.clear();
    for (const [, task] of tasks) {
      if (task.escalationTimer !== null) clearTimeout(task.escalationTimer);
      if (task.recoveryPollerId !== null) clearInterval(task.recoveryPollerId);
    }
    completeCallbacks.length = 0;
    save().catch(() => {});
  }

  async function restore(): Promise<void> {
    const loaded = await store.loadTasks();
    for (const task of loaded) {
      // Strip non-serializable fields
      task.escalationTimer = null;
      task.recoveryPollerId = null;
      tasks.set(task.id, task);
    }
  }

  async function recover(): Promise<void> {
    for (const [, task] of tasks) {
      if (task.status !== 'running') continue;

      // Check if pid is still alive
      let alive = false;
      if (task.pid !== null) {
        try { process.kill(task.pid, 0); alive = true; } catch { /* dead */ }
      }

      if (alive) {
        // Monitor for eventual exit
        task.recoveryPollerId = setInterval(() => {
          if (task.pid !== null) {
            try { process.kill(task.pid, 0); } catch {
              finishRecoveredTask(task);
              if (task.recoveryPollerId !== null) {
                clearInterval(task.recoveryPollerId);
                task.recoveryPollerId = null;
              }
            }
          }
        }, 5000);
      } else {
        finishRecoveredTask(task);
      }
    }
  }

  function finishRecoveredTask(task: Task): void {
    let exitData: { exitCode: number; signal: string | null; finishedAt: number } | null = null;

    // Try to read exit info from the output file tail (crash recovery)
    try {
      const outputContent = fs.readFileSync(task.outputPath, 'utf-8');
      const exitMarker = '__EXIT__';
      const markerIdx = outputContent.lastIndexOf(exitMarker);
      if (markerIdx >= 0) {
        const jsonStart = markerIdx + exitMarker.length;
        const jsonEnd = outputContent.indexOf('\n', jsonStart);
        if (jsonEnd > jsonStart) {
          exitData = JSON.parse(outputContent.slice(jsonStart, jsonEnd));
        }
      }
    } catch { /* file doesn't exist or can't be read */ }

    if (exitData) {
      task.status = exitData.exitCode === 0 ? 'completed' : 'failed';
      task.exitCode = exitData.exitCode;
      task.signal = exitData.signal;
      task.finishedAt = exitData.finishedAt;
      task.result = {
        exitCode: exitData.exitCode ?? -1,
        signal: exitData.signal,
        durationMs: (exitData.finishedAt ?? Date.now()) - task.createdAt,
        killed: exitData.signal !== null,
        timedOut: false,
        spawnError: null,
      };
    } else {
      task.status = 'lost';
    }

    save().catch(() => {});
    for (const cb of completeCallbacks) {
      try { cb(task); } catch { /* ignore */ }
    }
  }

  async function readOutput(id: string, lines?: number): Promise<string> {
    return store.readOutput(id, lines);
  }

  return {
    spawn, get, list, kill, waitFor,
    onTaskComplete, cleanup, destroy,
    save: () => save(),
    restore,
    recover,
    readOutput,
  };
}

export type TaskRegistry = ReturnType<typeof createTaskRegistry>;

// ── Global singleton ──

let taskRegistry: TaskRegistry | null = null;

export function setTaskRegistry(reg: TaskRegistry | null): void {
  taskRegistry = reg;
}

export function getTaskRegistry(): TaskRegistry | null {
  return taskRegistry;
}
