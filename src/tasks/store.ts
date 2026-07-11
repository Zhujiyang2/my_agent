// src/tasks/store.ts
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from './types';

export function createTaskStore(baseDir: string) {
  const jobsDir = path.join(baseDir, 'jobs');
  let saveLock: Promise<void> = Promise.resolve();

  async function ensureDir(): Promise<void> {
    await fs.promises.mkdir(jobsDir, { recursive: true });
  }

  async function saveTasks(tasks: Task[]): Promise<void> {
    // Serialize writes to avoid tmp-file collision
    saveLock = saveLock.then(async () => {
      await ensureDir();
      const tmpPath = path.join(baseDir, 'tasks.json.tmp');
      const targetPath = path.join(baseDir, 'tasks.json');
      const data = JSON.stringify(tasks, null, 2);
      await fs.promises.writeFile(tmpPath, data, 'utf-8');
      await fs.promises.rename(tmpPath, targetPath);
    });
    await saveLock;
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

  async function appendOutput(taskId: string, chunk: string): Promise<void> {
    await ensureDir();
    const filePath = path.join(jobsDir, `${taskId}.output`);
    await fs.promises.appendFile(filePath, chunk, 'utf-8');
  }

  async function readOutput(taskId: string, lines = 100): Promise<string> {
    const filePath = path.join(jobsDir, `${taskId}.output`);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      // Strip __EXIT__ recovery metadata lines
      const cleaned = content.split('\n').filter(l => !l.startsWith('__EXIT__')).join('\n');
      const allLines = cleaned.split('\n');
      const meaningful = allLines[allLines.length - 1] === '' ? allLines.slice(0, -1) : allLines;
      if (meaningful.length === 0) return '';
      const tail = meaningful.slice(-lines);
      return tail.join('\n');
    } catch {
      return '';
    }
  }

  function getJobDir(): string {
    return jobsDir;
  }

  return { saveTasks, loadTasks, appendOutput, readOutput, ensureDir, getJobDir };
}

export type TaskStore = ReturnType<typeof createTaskStore>;
