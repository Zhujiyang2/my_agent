// src/tasks/store.ts
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from './types';

export function createTaskStore(baseDir: string) {
  const jobsDir = path.join(baseDir, 'jobs');

  async function ensureDir(): Promise<void> {
    await fs.promises.mkdir(jobsDir, { recursive: true });
  }

  async function saveTasks(tasks: Task[]): Promise<void> {
    await ensureDir();
    const tmpPath = path.join(baseDir, 'tasks.json.tmp');
    const targetPath = path.join(baseDir, 'tasks.json');
    const data = JSON.stringify(tasks, null, 2);
    await fs.promises.writeFile(tmpPath, data, 'utf-8');
    await fs.promises.rename(tmpPath, targetPath);
  }

  async function loadTasks(): Promise<Task[]> {
    const targetPath = path.join(baseDir, 'tasks.json');
    // Clean up stale tmp file
    const tmpPath = path.join(baseDir, 'tasks.json.tmp');
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    try {
      const data = await fs.promises.readFile(targetPath, 'utf-8');
      return JSON.parse(data) as Task[];
    } catch {
      return [];
    }
  }

  async function appendOutput(taskId: string, stream: 'stdout' | 'stderr', chunk: string): Promise<void> {
    await ensureDir();
    const filePath = path.join(jobsDir, `${taskId}.${stream}`);
    await fs.promises.appendFile(filePath, chunk, 'utf-8');
  }

  async function readOutput(taskId: string, stream: 'stdout' | 'stderr', lines = 100): Promise<string> {
    const filePath = path.join(jobsDir, `${taskId}.${stream}`);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      // Split and drop trailing empty string from final \n
      const allLines = content.split('\n');
      const meaningful = allLines[allLines.length - 1] === '' ? allLines.slice(0, -1) : allLines;
      if (meaningful.length === 0) return '';
      const tail = meaningful.slice(-lines);
      return tail.join('\n');
    } catch {
      return '';
    }
  }

  async function writeExit(taskId: string, data: { exitCode: number | null; signal: string | null; finishedAt: number }): Promise<void> {
    await ensureDir();
    const filePath = path.join(jobsDir, `${taskId}.exit`);
    await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8');
  }

  async function readExit(taskId: string): Promise<{ exitCode: number | null; signal: string | null; finishedAt: number } | null> {
    const filePath = path.join(jobsDir, `${taskId}.exit`);
    try {
      const data = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function getJobDir(): string {
    return jobsDir;
  }

  return { saveTasks, loadTasks, appendOutput, readOutput, writeExit, readExit, ensureDir, getJobDir };
}

export type TaskStore = ReturnType<typeof createTaskStore>;
