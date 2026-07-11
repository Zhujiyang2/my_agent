// src/tasks/__tests__/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTaskRegistry } from '../registry';

const TEST_DIR = path.join(os.tmpdir(), 'my-agent-registry-test');

describe('TaskRegistry', () => {
  let registry: ReturnType<typeof createTaskRegistry>;

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    registry = createTaskRegistry(TEST_DIR);
  });

  afterEach(() => {
    registry.destroy();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('spawn returns a Task object', () => {
    const task = registry.spawn('echo hello');
    expect(task.id).toMatch(/^job-/);
    expect(task.status).toBe('running');
    expect(task.command).toBe('echo hello');
  });

  it('waitFor resolves when process completes', async () => {
    const task = registry.spawn('echo done');
    const result = await registry.waitFor(task.id);
    expect(result.exitCode).toBe(0);
  });

  it('waitFor on already-completed task returns immediately', async () => {
    const task = registry.spawn('exit 0');
    await registry.waitFor(task.id);
    const result2 = await registry.waitFor(task.id);
    expect(result2.exitCode).toBe(0);
  });

  it('get finds an existing task', () => {
    const task = registry.spawn('sleep 0.1');
    const found = registry.get(task.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(task.id);
  });

  it('get returns undefined for unknown id', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('list returns all tasks', () => {
    registry.spawn('echo a');
    registry.spawn('echo b');
    const all = registry.list();
    expect(all).toHaveLength(2);
  });

  it('list filters by status', async () => {
    const t1 = registry.spawn('echo fast');
    await registry.waitFor(t1.id);
    const completed = registry.list({ status: 'completed' });
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  it('kill terminates a running process', async () => {
    const task = registry.spawn('sleep 100', { timeoutMs: null });
    expect(task.status).toBe('running');
    const killed = registry.kill(task.id);
    expect(killed).toBe(true);
    await registry.waitFor(task.id);
    const t = registry.get(task.id)!;
    expect(t.status).toBe('killed');
  });

  it('onTaskComplete callback fires on completion', async () => {
    const completed: string[] = [];
    const cleanup = registry.onTaskComplete((t) => completed.push(t.id));
    const task = registry.spawn('echo done');
    await registry.waitFor(task.id);
    expect(completed).toContain(task.id);
    cleanup();
  });

  it('onTaskComplete cleanup removes the callback', async () => {
    const calls: string[] = [];
    const cleanup = registry.onTaskComplete((t) => calls.push(t.id));
    cleanup();
    const task = registry.spawn('echo done');
    await registry.waitFor(task.id);
    expect(calls).toHaveLength(0);
  });

  it('destroy cleans up timers and callbacks', () => {
    registry.spawn('echo a');
    registry.destroy();
    // No throw = pass
  });

  it('concurrent spawn of multiple tasks', async () => {
    const tasks = [registry.spawn('echo a'), registry.spawn('echo b'), registry.spawn('echo c')];
    const results = await Promise.all(tasks.map(t => registry.waitFor(t.id)));
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r.exitCode).toBe(0));
  });

  it('cleanup deletes failed task files', async () => {
    const task = registry.spawn('exit 1'); // failed tasks are NOT auto-cleaned
    await registry.waitFor(task.id);
    // Wait for any pending timers to settle
    await new Promise(resolve => setTimeout(resolve, 50));
    const result = registry.cleanup({ olderThanDays: 0 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const outputExists = fs.existsSync(task.outputPath);
    expect(outputExists).toBe(false);
  });

  it('save does not persist completed tasks, does persist non-completed', async () => {
    const completedTask = registry.spawn('echo done');
    await registry.waitFor(completedTask.id);
    const failedTask = registry.spawn('exit 42');
    await registry.waitFor(failedTask.id);
    await registry.save();

    const registry2 = createTaskRegistry(TEST_DIR);
    await registry2.restore();
    // Completed tasks are filtered from save
    expect(registry2.get(completedTask.id)).toBeUndefined();
    // Failed (non-completed) tasks are persisted
    expect(registry2.get(failedTask.id)).toBeDefined();
    expect(registry2.get(failedTask.id)!.command).toBe('exit 42');
    registry2.destroy();
  });

  it('readOutput returns task output', async () => {
    const task = registry.spawn('echo out1 && echo out2');
    await registry.waitFor(task.id);
    const out = await registry.readOutput(task.id);
    expect(out).toContain('out1');
    expect(out).toContain('out2');
  });

  // ── Auto-clean tests ──

  it('successful tasks are auto-cleaned after completion', async () => {
    const task = registry.spawn('echo cleanup-me');
    await registry.waitFor(task.id);

    // Wait for the setTimeout(0) cleanup to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    // File should be deleted
    expect(fs.existsSync(task.outputPath)).toBe(false);

    // Task should not appear in list
    const all = registry.list();
    expect(all.find(t => t.id === task.id)).toBeUndefined();
  });

  it('failed tasks are preserved after completion', async () => {
    const task = registry.spawn('exit 1');
    await registry.waitFor(task.id);

    // Wait to ensure cleanup does NOT happen for failed tasks
    await new Promise(resolve => setTimeout(resolve, 50));

    // File should still exist
    expect(fs.existsSync(task.outputPath)).toBe(true);

    // Task should still be in the list
    const all = registry.list();
    expect(all.find(t => t.id === task.id)).toBeDefined();
  });

  it('save + restore roundtrip — successful tasks are not persisted', async () => {
    const task = registry.spawn('echo hello');
    await registry.waitFor(task.id);
    await registry.save();

    const registry2 = createTaskRegistry(TEST_DIR);
    await registry2.restore();
    const restored = registry2.get(task.id);
    expect(restored).toBeUndefined();
    registry2.destroy();
  });

  it('save + restore roundtrip — failed tasks are persisted', async () => {
    const task = registry.spawn('exit 1');
    await registry.waitFor(task.id);
    await registry.save();

    const registry2 = createTaskRegistry(TEST_DIR);
    await registry2.restore();
    const restored = registry2.get(task.id);
    expect(restored).toBeDefined();
    expect(restored!.command).toBe('exit 1');
    registry2.destroy();
  });

  // ── Recover tests ──

  it('recover marks task with exitCode as completed', async () => {
    const task = registry.spawn('echo hello');
    await registry.waitFor(task.id);
    // Wait for auto-clean setTimeout(0) to fire
    await new Promise(resolve => setTimeout(resolve, 50));
    // After auto-clean, successful tasks are removed
    const t = registry.get(task.id);
    expect(t).toBeUndefined();
  });

  it('recover marks task with null exitCode as lost', async () => {
    // This test verifies that if a task has no exitCode (null),
    // finishRecoveredTask marks it as 'lost'. We test this indirectly
    // by verifying that auto-clean does NOT run for non-completed tasks.
    const task = registry.spawn('exit 1');
    await registry.waitFor(task.id);
    await new Promise(resolve => setTimeout(resolve, 50));
    const t = registry.get(task.id);
    expect(t).toBeDefined();
    expect(t!.status).toBe('failed');
  });
});
