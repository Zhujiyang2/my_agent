// src/agent/status-line.ts
import type { Task } from '../tasks/types';
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
      // Collapsed: single-line summary
      const parts: string[] = [];
      if (active.length > 0) {
        parts.push(`⚡ ${active.length} running`);
      }
      if (recent.length > 0) {
        const last = recent[0];
        const icon = last.status === 'completed' ? '✓' : last.status === 'failed' ? '✗' : '•';
        parts.push(`${icon} ${last.id.slice(0, 16)}: ${last.status}`);
      }
      return `\x1b[2m┃ ${parts.join(' │ ')}\x1b[0m`;
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
      lines.push(`\x1b[2m┃ ${icon} ${t.id.slice(-12)} ${t.status} ${elapsed.toFixed(0)}s exit=${t.exitCode}\x1b[0m`);
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
      // Move up and clear each line
      for (let i = 0; i < lastLineCount; i++) {
        output.write('\x1b[1A\x1b[2K');
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
        output.write('\x1b[1A\x1b[2K');
      }
      lastLineCount = 0;
    }
  }

  return { start, stop, refresh, toggle, renderStatusLine, extractProgress };
}

export type StatusLine = ReturnType<typeof createStatusLine>;
