# Ctrl+O: Show Only Running Tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `formatTaskLines` from `bin/my-agent.ts` to a standalone module and remove the recent-tasks section so Ctrl+O shows only running tasks.

**Architecture:** The function lives in `src/cli/task-formatter.ts` (new), taking `Task[]` and an `extractProgress` callback as parameters. `bin/my-agent.ts` imports and uses it, passing `taskRegistry.list()` and `statusLine.extractProgress`.

**Tech Stack:** TypeScript, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/cli/task-formatter.ts` | **Create** | Pure function: format running tasks into display lines |
| `src/cli/__tests__/task-formatter.test.ts` | **Create** | Unit tests for formatTaskLines |
| `bin/my-agent.ts` | **Modify** | Replace inline closure with import |

---

### Task 1: Write the failing tests

**Files:**
- Create: `src/cli/task-formatter.ts` (empty placeholder)
- Create: `src/cli/__tests__/task-formatter.test.ts`

- [ ] **Step 1: Create empty placeholder file for the module**

Run: `touch src/cli/task-formatter.ts`
No output expected.

- [ ] **Step 2: Write all tests in `src/cli/__tests__/task-formatter.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { formatTaskLines } from '../task-formatter';
import type { Task } from '../../tasks/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  const defaults: Task = {
    id: 'task-123456789012',
    type: 'shell',
    command: 'echo hello',
    workdir: '/tmp',
    status: 'running',
    pid: 12345,
    exitCode: null,
    signal: null,
    outputPath: '/tmp/output',
    createdAt: Date.now() - 30_000,
    finishedAt: null,
    timeoutMs: null,
    tailBuffer: '',
    escalationTimer: null,
    recoveryPollerId: null,
    result: null,
  };
  return { ...defaults, ...overrides };
}

function noProgress(_t: Task): null {
  return null;
}

describe('formatTaskLines', () => {
  it('returns only the collapse hint when no tasks exist', () => {
    const result = formatTaskLines([], noProgress);
    expect(result).toEqual(['\x1b[2m┃ (no running tasks)\x1b[0m']);
  });

  it('shows only running tasks, filtering out completed/failed/timeout/killed tasks', () => {
    const running = makeTask({ id: 'task-aaaaaaaaaaaa', status: 'running', command: 'npm test' });
    const completed = makeTask({ id: 'task-bbbbbbbbbbbb', status: 'completed', command: 'npm build' });
    const failed = makeTask({ id: 'task-cccccccccccc', status: 'failed', command: 'npm lint' });
    const timeout = makeTask({ id: 'task-dddddddddddd', status: 'timeout', command: 'npm audit' });
    const killed = makeTask({ id: 'task-eeeeeeeeeeee', status: 'killed', command: 'npm clean' });

    const result = formatTaskLines([running, completed, failed, timeout, killed], noProgress);

    expect(result).toHaveLength(2); // 1 running task + collapse hint
    expect(result[0]).toContain('aaaaaaaaaaaa');
    expect(result[0]).toContain('npm test');
    expect(result[0]).not.toContain('bbbbbbbbbbbb');
    expect(result[0]).not.toContain('cccccccccccc');
    expect(result[0]).not.toContain('dddddddddddd');
    expect(result[0]).not.toContain('eeeeeeeeeeee');
    expect(result[1]).toBe('\x1b[2m┃ Ctrl+O to collapse\x1b[0m');
  });

  it('shows "(no running tasks)" when tasks exist but none are running', () => {
    const completed = makeTask({ id: 'task-bbbbbbbbbbbb', status: 'completed', command: 'npm build' });
    const result = formatTaskLines([completed], noProgress);
    expect(result).toEqual(['\x1b[2m┃ (no running tasks)\x1b[0m']);
  });

  it('shows elapsed time for running tasks', () => {
    const running = makeTask({ createdAt: Date.now() - 120_000, command: 'sleep 120' });
    const result = formatTaskLines([running], noProgress);
    expect(result[0]).toMatch(/120s/);
  });

  it('shows progress percentage when tailBuffer contains progress info', () => {
    const running = makeTask({ tailBuffer: 'Downloading... 75% complete' });
    const progressFn = (t: Task) => {
      const m = t.tailBuffer.match(/(\d+)%/);
      return m ? parseInt(m[1], 10) : null;
    };
    const result = formatTaskLines([running], progressFn);
    expect(result[0]).toContain('75%');
  });

  it('truncates long commands to 60 characters', () => {
    const longCmd = 'a'.repeat(100);
    const running = makeTask({ command: longCmd });
    const result = formatTaskLines([running], noProgress);
    expect(result[0]).toContain('a'.repeat(57) + '...');
    expect(result[0]).not.toContain('a'.repeat(100));
  });

  it('shows task ID suffix (last 12 chars) in each line', () => {
    const running = makeTask({ id: 'task-deadbeefcafe' });
    const result = formatTaskLines([running], noProgress);
    expect(result[0]).toContain('deadbeefcafe');
  });

  it('handles multiple running tasks', () => {
    const r1 = makeTask({ id: 'task-aaaaaaaaaaaa', command: 'task-a' });
    const r2 = makeTask({ id: 'task-bbbbbbbbbbbb', command: 'task-b' });
    const r3 = makeTask({ id: 'task-cccccccccccc', command: 'task-c' });

    const result = formatTaskLines([r1, r2, r3], noProgress);

    expect(result).toHaveLength(4); // 3 tasks + collapse hint
    expect(result[0]).toContain('task-a');
    expect(result[1]).toContain('task-b');
    expect(result[2]).toContain('task-c');
    expect(result[3]).toBe('\x1b[2m┃ Ctrl+O to collapse\x1b[0m');
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `npx vitest run src/cli/__tests__/task-formatter.test.ts`
Expected: FAIL — `formatTaskLines` not found / module empty.

---

### Task 2: Implement formatTaskLines

**Files:**
- Create: `src/cli/task-formatter.ts`

- [ ] **Step 1: Write the implementation**

```typescript
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
```

- [ ] **Step 2: Run tests — verify they pass**

Run: `npx vitest run src/cli/__tests__/task-formatter.test.ts`
Expected: 8 tests PASS.

---

### Task 3: Integrate into bin/my-agent.ts

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Add import at top of file**

After line 39 (`import { resolveProjectPath } from '../src/paths.js';`), add:

```typescript
import { formatTaskLines } from '../src/cli/task-formatter.js';
```

- [ ] **Step 2: Replace the inline `formatTaskLines` closure**

Remove lines 299–327 (the `function formatTaskLines(): string[] { ... }` block) and replace the Ctrl+O handler's call to use the import.

The Ctrl+O handler (starts around line 336) currently calls `formatTaskLines()` — change to pass parameters:

```typescript
if (key.ctrl && !key.meta && key.name === 'o') {
  tasksExpanded = !tasksExpanded;
  if (tasksExpanded) {
    footer.setTasks(formatTaskLines(taskRegistry.list(), statusLine.extractProgress));
  } else {
    footer.clearTasks();
  }
  inputLine.renderFrame();
  return;
}
```

The full changed section replaces lines 299-327:

```typescript
  // Unified keypress handler: dispatch by key
  let tasksExpanded = false;

  process.stdin.on('keypress', (_ch, key) => {
```

- [ ] **Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Run all existing tests to verify no regressions**

Run: `npx vitest run`
Expected: All tests pass (including the new 8, plus all existing).

- [ ] **Step 5: Commit**

```bash
git add src/cli/task-formatter.ts src/cli/__tests__/task-formatter.test.ts bin/my-agent.ts
git commit -m "feat: extract formatTaskLines, show only running tasks on Ctrl+O"
```
