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

export function createTaskRegistry(stateDir: string) {
  const tasks = new Map<string, Task>();
  const store = createTaskStore(stateDir);
  const completeCallbacks: Array<(task: Task) => void> = [];

  async function save(): Promise<void> {
    await store.saveTasks(Array.from(tasks.values()));
  }

  function spawn(command: string, opts?: {
    workdir?: string;
    timeoutMs?: number | null;
    env?: Record<string, string>;
    label?: string;
  }): Task {
    const id = generateId();
    const jobDir = store.getJobDir();
    const stdoutPath = path.join(jobDir, `${id}.stdout`);
    const stderrPath = path.join(jobDir, `${id}.stderr`);
    const exitFilePath = path.join(jobDir, `${id}.exit`);

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
      stdoutPath,
      stderrPath,
      exitFilePath,
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
        stdoutPath,
        stderrPath,
        exitFilePath,
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

    // Timeout management
    if (task.timeoutMs !== null && task.timeoutMs > 0) {
      const timer = setTimeout(() => {
        const t = tasks.get(id);
        if (t && t.status === 'running') {
          killTaskInstance(t, 'SIGTERM');
          t.status = 'timeout';
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
      // Store timer so destroy can clear it
      (task as Record<string, unknown>)._timeoutTimer = timer;
    }

    // Process exit callback
    child.promise.then((result) => {
      const t = tasks.get(id);
      if (!t) return;

      // Clear timeout timer
      const timer = (t as Record<string, unknown>)._timeoutTimer as ReturnType<typeof setTimeout> | undefined;
      if (timer) clearTimeout(timer);

      // Clear escalation timer
      if (t.escalationTimer !== null) {
        clearTimeout(t.escalationTimer);
        t.escalationTimer = null;
      }

      // Only set status if still running (kill() may have changed it)
      if (t.status === 'running') {
        t.status = result.exitCode === 0 ? 'completed' : 'failed';
      }
      t.result = result;
      t.exitCode = result.exitCode;
      t.signal = result.signal;
      t.finishedAt = Date.now();

      save().catch(() => {});
      for (const cb of completeCallbacks) {
        try { cb(t); } catch { /* ignore */ }
      }
    });

    // tailBuffer: capture stdout data events for live progress
    // The spawnCommand pipes stdout to file via stream; we don't have
    // a direct hook. tailBuffer is populated by the caller reading output
    // files on demand. For live-capture we'd need an additional listener;
    // that can be added in a follow-up if needed.

    return task;
  }

  function killTaskInstance(task: Task, signal: 'SIGTERM' | 'SIGKILL'): boolean {
    if (task.status !== 'running' || task.pid === null) return false;

    try {
      process.kill(task.pid, signal);
    } catch {
      return false;
    }

    if (signal === 'SIGKILL') {
      task.status = 'killed';
      task.signal = signal;
    }

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

    task.signal = signal;

    if (signal === 'SIGTERM') {
      task.escalationTimer = setTimeout(() => {
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
      // If finishedAt is null or recent, skip
      if (task.finishedAt !== null && task.finishedAt > cutoff) continue;
      if (task.finishedAt === null && task.createdAt > cutoff) continue;

      for (const p of [task.stdoutPath, task.stderrPath, task.exitFilePath]) {
        try {
          const stat = fs.statSync(p);
          freedBytes += stat.size;
          fs.unlinkSync(p);
        } catch { /* file doesn't exist */ }
      }
      tasks.delete(id);
      deleted++;
    }

    save().catch(() => {});
    return { deleted, freedBytes };
  }

  function destroy(): void {
    for (const [, task] of tasks) {
      const timer = (task as Record<string, unknown>)._timeoutTimer as ReturnType<typeof setTimeout> | undefined;
      if (timer) clearTimeout(timer);
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
      (task as Record<string, unknown>)._timeoutTimer = undefined;
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
    const exit = fs.existsSync(task.exitFilePath)
      ? JSON.parse(fs.readFileSync(task.exitFilePath, 'utf-8'))
      : null;

    if (exit) {
      task.status = exit.exitCode === 0 ? 'completed' : 'failed';
      task.exitCode = exit.exitCode;
      task.signal = exit.signal;
      task.finishedAt = exit.finishedAt;
      task.result = {
        exitCode: exit.exitCode ?? -1,
        signal: exit.signal,
        durationMs: (exit.finishedAt ?? Date.now()) - task.createdAt,
        killed: exit.signal !== null,
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

  async function readOutput(id: string, stream: 'stdout' | 'stderr', lines?: number): Promise<string> {
    return store.readOutput(id, stream, lines);
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
