# Ctrl+O: Show Only Running Tasks

**Date**: 2026-07-13
**Status**: approved

## Summary

When the user presses Ctrl+O, the expanded task list below the `/exit to quit` hint should only show **running** tasks. Currently it also shows recently completed/failed tasks (up to 3), which clutters the view.

## Changes

### 1. Extract `formatTaskLines` to `src/cli/task-formatter.ts`

The function is currently a closure inside `bin/my-agent.ts`. Extract it to a standalone module for testability and clean separation. It depends on `TaskRegistry` (for listing tasks) and `StatusLine` (for `extractProgress`), both passed as parameters.

```typescript
// src/cli/task-formatter.ts
export function formatTaskLines(
  tasks: Task[],
  extractProgress: (task: Task) => number | null,
): string[]
```

### 2. Remove recent tasks from expanded view

Remove the `recent` section (completed/failed tasks up to 3). Only show active (running) tasks.

### 3. Update empty-state message

Change from `(no tasks)` to `(no running tasks)` when no running tasks exist.

## Layout (unchanged)

```
┃ ⚡ 2 running                    ← status line (collapsed, auto-refresh)
───────────────────────────────── ← top sep
> npm test█                       ← input line
───────────────────────────────── ← bottom sep
  /exit to quit | Ctrl+C | Ctrl+O ← hint
┃ ⚡ a1b2... 30s echo hello       ← running tasks only
┃ ⚡ f6e5... 15s npm build
┃ Ctrl+O to collapse              ← collapse hint
```

## Files touched

| File | Change |
|------|--------|
| `src/cli/task-formatter.ts` | New: extracted `formatTaskLines` |
| `src/cli/__tests__/task-formatter.test.ts` | New: unit tests |
| `bin/my-agent.ts` | Replace inline function with import |

## Test cases

- Returns empty line when no tasks exist
- Shows only running tasks (filters out completed/failed/timeout/killed)
- Shows "(no running tasks)" when tasks exist but none are running
- Includes "Ctrl+O to collapse" footer
- Includes progress percentage when tailBuffer contains progress info
- Truncates long commands (>60 chars)
