// src/agent/status-line.ts
import type { Task } from '../tasks/types';
import * as readline from 'node:readline';
import { getTaskRegistry } from '../tasks/registry';

export interface StatusLineOptions {
  /** Refresh interval in ms (default: 3000) */
  intervalMs?: number;
  /** Output stream (default: process.stderr to avoid mixing with stdout) */
  output?: NodeJS.WriteStream;
}

export function createStatusLine(opts: StatusLineOptions = {}) {
  const intervalMs = opts.intervalMs ?? 3000;
  const output = opts.output ?? process.stderr;
  let expanded = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastLineCount = 0;

  function renderStatusLine(tasks: Task[]): string {
    const active = tasks.filter(t => t.status === 'running');
    const recent = tasks
      .filter(t => t.status !== 'running')
      .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
      .slice(0, 3);

    if (active.length === 0 && recent.length === 0) return '';

    if (!expanded) {
      // Collapsed: only show running tasks
      if (active.length === 0) return '';
      return `\x1b[2m┃ ⚡ ${active.length} running\x1b[0m`;
    }

    // Expanded: one line per task
    const lines: string[] = [];
    for (const t of active) {
      const elapsed = ((Date.now() - t.createdAt) / 1000).toFixed(0);
      const progress = extractProgress(t);
      const pct = progress !== null ? ` ${progress}%` : '';
      lines.push(`\x1b[2m┃ ⚡ ${t.id.slice(-12)} ${elapsed}s${pct} ${t.command.slice(0, 60)}\x1b[0m`);
    }
    for (const t of recent) {
      const elapsed = ((t.finishedAt ?? t.createdAt) - t.createdAt) / 1000;
      const icon = t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : '•';
      const cmd = t.command.length > 60 ? t.command.slice(0, 57) + '...' : t.command;
      lines.push(`\x1b[2m┃ ${icon} ${cmd}: ${t.status} (${elapsed.toFixed(0)}s)\x1b[0m`);
    }
    // Footer
    lines.push(`\x1b[2m┃ Ctrl+O to collapse\x1b[0m`);
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

  function toggle(): void {
    expanded = !expanded;
    refresh();
  }

  function refresh(): void {
    const reg = getTaskRegistry();
    const tasks = reg ? reg.list() : [];
    const line = renderStatusLine(tasks);

    // Clear previous status lines
    if (lastLineCount > 0) {
      for (let i = 0; i < lastLineCount; i++) {
        readline.moveCursor(output, 0, -1);
        readline.clearLine(output, 0);
      }
    }

    if (line) {
      output.write(line + '\n');
      lastLineCount = line.split('\n').length;
    } else {
      lastLineCount = 0;
    }
  }

  function start(): void {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Clear any remaining status lines
    if (lastLineCount > 0) {
      for (let i = 0; i < lastLineCount; i++) {
        readline.moveCursor(output, 0, -1);
        readline.clearLine(output, 0);
      }
      lastLineCount = 0;
    }
  }

  /** Pause the refresh timer without clearing display. Use during LLM output. */
  function pause(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Resume refresh timer after pause. */
  function resume(): void {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, intervalMs);
  }

  return { start, stop, pause, resume, refresh, toggle, renderStatusLine, extractProgress };
}

export type StatusLine = ReturnType<typeof createStatusLine>;
