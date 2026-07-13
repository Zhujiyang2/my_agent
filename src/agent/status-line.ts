// src/agent/status-line.ts
import type { Task } from '../tasks/types';

export function createStatusLine() {

  function renderStatusLine(tasks: Task[]): string {
    const active = tasks.filter(t => t.status === 'running');
    if (active.length === 0) return '';

    const lines: string[] = [];
    lines.push(`\x1b[2m┃ ⚡ ${active.length} running\x1b[0m`);
    for (const t of active) {
      const cmd = t.command.length > 60 ? t.command.slice(0, 57) + '...' : t.command;
      lines.push(`\x1b[2m  ${cmd}\x1b[0m`);
    }
    return lines.join('\n');
  }

  function extractProgress(task: Task): number | null {
    const buf = task.tailBuffer;
    if (!buf) return null;

    // Try tqdm/percentage pattern: "XX%"
    const pctMatch = buf.match(/(\d{1,3})%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1], 10);
      if (pct >= 0 && pct <= 100) return pct;
    }

    // Try fraction pattern: "123/456"
    const fracMatch = buf.match(/(\d+)\/(\d+)/);
    if (fracMatch) {
      const num = parseInt(fracMatch[1], 10);
      const den = parseInt(fracMatch[2], 10);
      if (den > 0) return Math.round((num / den) * 100);
    }

    return null;
  }

  return { renderStatusLine, extractProgress };
}

export type StatusLine = ReturnType<typeof createStatusLine>;
