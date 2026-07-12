// src/tasks/types.ts

export type TaskType = 'shell' | 'agent';

export type TaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'killed'
  | 'lost';

export interface Task {
  id: string;
  type: TaskType;
  command: string;
  workdir: string;
  env?: Record<string, string>;
  status: TaskStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  outputPath: string;
  createdAt: number;
  finishedAt: number | null;
  timeoutMs: number | null;
  tailBuffer: string;
  escalationTimer: ReturnType<typeof setTimeout> | null;
  recoveryPollerId: ReturnType<typeof setInterval> | null;
  result: ShellTaskResult | null;
}

export interface ShellTaskResult {
  exitCode: number;
  signal: string | null;
  durationMs: number;
  killed: boolean;
  timedOut: boolean;
  spawnError: string | null;
}

// ── filterProgressBars ──

export function filterProgressBars(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  const result: string[] = [];
  let prevEmpty = false;

  for (const line of lines) {
    // Collapse consecutive blank lines
    if (line.trim() === '' || line === '\r') {
      if (!prevEmpty && result.length > 0) {
        result.push('');
        prevEmpty = true;
      }
      continue;
    }
    prevEmpty = false;

    // Check if this is a progress-bar line
    if (isProgressBarLine(line)) {
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

const PROGRESS_CHARS = /[━█▏▎▍▌▋▊▉═]/;

function isProgressBarLine(line: string): boolean {
  const trimmed = line.trim();

  // tqdm-style: "XX%|..."
  if (trimmed.match(/^\d{1,3}%\|/)) return true;

  // Unicode progress-bar characters
  if (PROGRESS_CHARS.test(trimmed)) return true;

  // Lines containing \r and a percentage (carriage-return progress updates)
  if (line.includes('\r') && /\d{1,3}%/.test(line)) return true;

  // Plain rate line: "1.2MB/s eta 15s"
  if (trimmed.match(/^[\d.]+\s*(kB|MB|GB|B)\/s(\s+eta\s+\S+)?$/)) return true;

  // pip/brew progress: "Downloading ..." with MB fraction
  if (trimmed.includes('MB') && trimmed.match(/\d+\.?\d*\/\d+\.?\d*\s*(kB|MB|GB)/)) return true;

  // git clone "Receiving objects:  45% (556/1234)" — partial progress (not 100%)
  if (trimmed.match(/Receiving objects:\s+(\d{1,2})%/) && !trimmed.includes('100%')) return true;

  // Progress characters percentage > 30%
  const progressCharCount = (trimmed.match(/[%=#>.]/g) || []).length;
  if (trimmed.length > 0 && progressCharCount / trimmed.length > 0.3) return true;

  return false;
}
