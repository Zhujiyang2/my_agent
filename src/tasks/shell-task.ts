// src/tasks/shell-task.ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ShellTaskResult } from './types';

export interface SpawnCommandOptions {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  taskId: string;
  outputPath: string;
}

export function spawnCommand(opts: SpawnCommandOptions): { pid: number; promise: Promise<ShellTaskResult> } {
  const startTime = Date.now();

  // Ensure the output directory exists
  const jobDir = path.dirname(opts.outputPath);
  fs.mkdirSync(jobDir, { recursive: true });

  const child = spawn(opts.command, {
    shell: true,
    cwd: opts.workdir ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const outputStream = fs.createWriteStream(opts.outputPath, { flags: 'a' });

  // Suppress ENOENT — the output directory may be cleaned up (e.g., tests)
  outputStream.on('error', () => {});

  child.stdout?.pipe(outputStream);
  child.stderr?.pipe(outputStream);

  const promise = new Promise<ShellTaskResult>((resolve) => {
    child.on('exit', (code, sig) => {
      const durationMs = Date.now() - startTime;
      const exitCode = code ?? -1;
      const exitInfo = JSON.stringify({ exitCode, signal: sig ?? null, finishedAt: Date.now() });
      try {
        fs.appendFileSync(opts.outputPath, `\n__EXIT__${exitInfo}\n`);
      } catch { /* file may be gone */ }
      resolve({
        exitCode,
        signal: sig ?? null,
        durationMs,
        killed: sig !== null,
        timedOut: false,
        spawnError: null,
      });
    });

    child.on('error', (err) => {
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: -1,
        signal: null,
        durationMs,
        killed: false,
        timedOut: false,
        spawnError: err.message,
      });
    });
  });

  return { pid: child.pid ?? -1, promise };
}
