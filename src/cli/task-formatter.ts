// src/cli/task-formatter.ts
import type { Task } from '../tasks/types';

/**
 * Format running tasks into display lines for the expanded Ctrl+O view.
 * Only shows active (running) tasks. Non-running tasks are ignored.
 *
 * @param tasks - All tasks from the task registry
 * @param extractProgress - Function to extract progress percentage from a task's tail buffer
 * @returns Array of display lines, each with ANSI dim styling
 */
export function formatTaskLines(
  tasks: Task[],
  extractProgress: (task: Task) => number | null,
): string[] {
  const active = tasks.filter(t => t.status === 'running');

  if (active.length === 0) return ['\x1b[2m┃ (no running tasks)\x1b[0m'];

  const lines: string[] = [];
  for (const t of active) {
    const elapsed = ((Date.now() - t.createdAt) / 1000).toFixed(0);
    const progress = extractProgress(t);
    const pct = progress !== null ? ` ${progress}%` : '';
    const cmd = t.command.length > 60 ? t.command.slice(0, 57) + '...' : t.command;
    lines.push(`\x1b[2m┃ ⚡ ${t.id.slice(-12)} ${elapsed}s${pct} ${cmd}\x1b[0m`);
  }
  lines.push(`\x1b[2m┃ Ctrl+O to collapse\x1b[0m`);
  return lines;
}
