# CLI Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract job-completion messages from the polling status line into an event-driven footer area below the readline prompt.

**Architecture:** New `src/cli/footer.ts` module manages a message buffer with id-based dedup. `bin/my-agent.ts` renders the footer before each `rl.prompt()`. `status-line.ts` is narrowed to only show running tasks, with the clearing logic fixed.

**Tech Stack:** TypeScript, Node.js readline, Vitest

---

### Task 1: Create footer.ts with TDD

**Files:**
- Create: `src/cli/footer.ts`
- Create: `src/cli/__tests__/footer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/__tests__/footer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFooter } from '../footer';
import type { FooterMessage } from '../footer';

describe('createFooter', () => {
  let footer: ReturnType<typeof createFooter>;

  beforeEach(() => {
    footer = createFooter();
  });

  describe('render', () => {
    it('renders separator and hint when no messages', () => {
      // Mock terminal width to 80
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      const result = footer.render();
      expect(result).toContain('─'.repeat(80));
      expect(result).toContain('Ctrl+O expand tasks');
    });

    it('renders a single completed message', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({
        id: 'job-test-001',
        icon: '✓',
        text: 'python train.py: completed (12.3s)',
      });

      const result = footer.render();
      expect(result).toContain('✓ python train.py: completed (12.3s)');
    });

    it('renders multiple messages in insertion order', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: completed (1.0s)' });
      footer.upsert({ id: 'job-2', icon: '✗', text: 'cmd2: failed (2.0s)' });

      const result = footer.render();
      const idx1 = result.indexOf('cmd1');
      const idx2 = result.indexOf('cmd2');
      expect(idx1).toBeLessThan(idx2);
    });

    it('uses current terminal width for separator', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 120 },
      });

      const result = footer.render();
      expect(result).toContain('─'.repeat(120));
    });
  });

  describe('upsert', () => {
    it('deduplicates by id — replaces existing message', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({ id: 'job-1', icon: '⚡', text: 'cmd: running...' });
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd: completed (5.0s)' });

      const result = footer.render();
      // Should only appear once, with the updated text
      expect(result).toContain('✓ cmd: completed (5.0s)');
      expect(result).not.toContain('running...');
      // Count occurrences of 'cmd:' — should be exactly 1
      const matches = result.match(/cmd:/g);
      expect(matches).toHaveLength(1);
    });

    it('keeps at most 5 messages, dropping oldest', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      for (let i = 1; i <= 7; i++) {
        footer.upsert({ id: `job-${i}`, icon: '✓', text: `cmd${i}: completed` });
      }

      const result = footer.render();
      // job-1 and job-2 should be dropped
      expect(result).not.toContain('cmd1');
      expect(result).not.toContain('cmd2');
      // job-3 through job-7 should be present
      expect(result).toContain('cmd3');
      expect(result).toContain('cmd7');
    });
  });

  describe('remove', () => {
    it('removes a message by id', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: completed' });
      footer.upsert({ id: 'job-2', icon: '✓', text: 'cmd2: completed' });
      footer.remove('job-1');

      const result = footer.render();
      expect(result).not.toContain('cmd1');
      expect(result).toContain('cmd2');
    });

    it('does nothing when id not found', () => {
      footer.remove('nonexistent');
      // Should not throw
    });
  });

  describe('clear', () => {
    it('removes all messages', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: completed' });
      footer.clear();

      const result = footer.render();
      expect(result).not.toContain('cmd1');
      expect(result).toContain('Ctrl+O expand tasks'); // hint still present
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cli/__tests__/footer.test.ts
```
Expected: FAIL — module `../footer` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/footer.ts`:

```typescript
export interface FooterMessage {
  id: string;
  icon: string;
  text: string;
}

export function createFooter() {
  const messages: FooterMessage[] = [];
  const MAX_MESSAGES = 5;

  function upsert(msg: FooterMessage): void {
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      messages[idx] = msg;
    } else {
      messages.push(msg);
      if (messages.length > MAX_MESSAGES) {
        messages.shift();
      }
    }
  }

  function remove(id: string): void {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      messages.splice(idx, 1);
    }
  }

  function render(): string {
    const width = process.stdout.columns ?? 80;
    const sep = '─'.repeat(width);

    const lines = [sep, '  Ctrl+O expand tasks'];
    for (const msg of messages) {
      lines.push(`${msg.icon} ${msg.text}`);
    }
    return lines.join('\n');
  }

  function clear(): void {
    messages.length = 0;
  }

  return { upsert, remove, render, clear };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/cli/__tests__/footer.test.ts
```
Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/footer.ts src/cli/__tests__/footer.test.ts
git commit -m "feat: add footer module for event-driven job completion display"
```

---

### Task 2: Narrow status-line collapsed view to only show running tasks

**Files:**
- Modify: `src/agent/status-line.ts:19-40`

- [ ] **Step 1: Update existing tests to reflect new behavior**

Modify `src/agent/__tests__/status-line.test.ts`:

Replace the test `'shows completed task status'` (line 54-63):

```typescript
    it('does not show completed task in collapsed mode', () => {
      const tasks = [makeTask({
        id: 'job-abc123',
        status: 'completed',
        exitCode: 0,
        finishedAt: Date.now(),
      })];
      const result = sl.renderStatusLine(tasks);
      // Collapsed mode: no completed tasks shown
      expect(result).toBe('');
    });
```

Replace the test `'shows failed task status'` (line 65-74):

```typescript
    it('does not show failed task in collapsed mode', () => {
      const tasks = [makeTask({
        id: 'job-fail01',
        status: 'failed',
        exitCode: 1,
        finishedAt: Date.now(),
      })];
      const result = sl.renderStatusLine(tasks);
      // Collapsed mode: no failed tasks shown
      expect(result).toBe('');
    });
```

Replace the test `'handles mixed running and completed tasks in collapsed mode'` (line 76-84):

```typescript
    it('shows only running tasks in collapsed mode', () => {
      const tasks = [
        makeTask({ id: 'job-run-1', status: 'running' }),
        makeTask({ id: 'job-done-1', status: 'completed', exitCode: 0, finishedAt: Date.now() }),
      ];
      const result = sl.renderStatusLine(tasks);
      expect(result).toContain('1 running');
      expect(result).not.toContain('completed');
      expect(result).not.toContain('failed');
    });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/agent/__tests__/status-line.test.ts
```
Expected: 3 tests FAIL (they still expect old behavior).

- [ ] **Step 3: Update renderStatusLine collapsed mode**

In `src/agent/status-line.ts`, replace lines 26-40 (the collapsed mode section) with:

```typescript
    if (!expanded) {
      // Collapsed: only show running tasks
      if (active.length === 0) return '';
      return `\x1b[2m┃ ⚡ ${active.length} running\x1b[0m`;
    }
```

Note: the `recent` variable is no longer needed in collapsed mode but is still used by expanded mode — keep the `recent` computation as-is (lines 21-24).

The full updated `renderStatusLine` function should be:

```typescript
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

    // Expanded: one line per task (unchanged)
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/agent/__tests__/status-line.test.ts
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/status-line.ts src/agent/__tests__/status-line.test.ts
git commit -m "refactor: narrow status-line collapsed view to only show running tasks"
```

---

### Task 3: Fix status-line refresh clearing to use readline module

**Files:**
- Modify: `src/agent/status-line.ts:1` (add import), `src/agent/status-line.ts:87-106` (refresh function)

- [ ] **Step 1: Add import at top of status-line.ts**

Insert after line 1 (`import type { Task } from '../tasks/types';`):

```typescript
import * as readline from 'node:readline';
```

So lines 1-3 become:

```typescript
// src/agent/status-line.ts
import type { Task } from '../tasks/types';
import * as readline from 'node:readline';
import { getTaskRegistry } from '../tasks/registry';
```

- [ ] **Step 2: Replace refresh() clearing logic**

Replace lines 87-106 (the `refresh` function) with:

```typescript
  function refresh(): void {
    const reg = getTaskRegistry();
    const tasks = reg ? reg.list() : [];
    const line = renderStatusLine(tasks);

    // Clear previous status lines using readline (coordinated cursor control)
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
```

- [ ] **Step 3: Run existing tests to confirm no regression**

```bash
npx vitest run src/agent/__tests__/status-line.test.ts
```
Expected: all tests PASS (tests don't exercise the refresh loop directly, but import/compilation must succeed).

- [ ] **Step 4: Commit**

```bash
git add src/agent/status-line.ts
git commit -m "fix: use readline.moveCursor/clearLine for status-line clearing instead of raw ANSI"
```

---

### Task 4: Wire footer into bin entry point

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Import footer module**

Add to the imports in `bin/my-agent.ts`, after line 37:

```typescript
import { createFooter } from '../src/cli/footer.js';
```

- [ ] **Step 2: Create footer instance and wire task completion callback**

After line 146 (`statusLine.start();`), insert:

```typescript
  // Initialize footer for job completion messages
  const footer = createFooter();
  taskRegistry.onTaskComplete((task) => {
    const icon = task.status === 'completed' ? '✓' : '✗';
    const elapsed = ((task.finishedAt! - task.createdAt) / 1000).toFixed(1);
    const cmd = task.command.length > 60
      ? task.command.slice(0, 57) + '...'
      : task.command;
    footer.upsert({
      id: task.id,
      icon,
      text: `${cmd}: ${task.status} (${elapsed}s)`,
    });
  });
```

- [ ] **Step 3: Render footer before each rl.prompt()**

Add `console.log(footer.render());` before every `rl.prompt()` call in the file. There are 4 occurrences:

Line 148: standalone `rl.prompt()` → becomes:
```typescript
  console.log(footer.render());
  rl.prompt();
```

Line 163: `rl.prompt()` after SIGINT → becomes:
```typescript
    console.log(footer.render());
    rl.prompt();
```

Line 171: `rl.prompt()` after empty input → becomes:
```typescript
    console.log(footer.render());
    rl.prompt();
```

Line 204: `rl.prompt()` after continue commands → becomes:
```typescript
    console.log(footer.render());
    rl.prompt();
```

Line 225: `rl.prompt()` after agent.send → becomes:
```typescript
    console.log(footer.render());
    rl.prompt();
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run
```
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/my-agent.ts
git commit -m "feat: wire footer display into CLI prompt cycle, connect task completion events"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All 4 spec requirements covered — footer.ts (Task 1), status-line narrowing (Task 2), clearing fix (Task 3), bin wiring (Task 4)
- [x] **Placeholder scan:** No TBD/TODO. Every step contains concrete code.
- [x] **Type consistency:** `FooterMessage` interface defined in Task 1, used consistently in Tasks 1 and 4. `createFooter` return type matches usage in Task 4.
