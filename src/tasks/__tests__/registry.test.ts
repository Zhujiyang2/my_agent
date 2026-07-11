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

  it('cleanup deletes completed task files', async () => {
    const task = registry.spawn('echo cleanup-test');
    await registry.waitFor(task.id);
    const result = registry.cleanup({ olderThanDays: 0 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const stdoutExists = fs.existsSync(task.stdoutPath);
    expect(stdoutExists).toBe(false);
  });

  it('save + restore roundtrip', async () => {
    const task = registry.spawn('echo hello');
    await registry.waitFor(task.id);
    await registry.save();

    const registry2 = createTaskRegistry(TEST_DIR);
    await registry2.restore();
    const restored = registry2.get(task.id);
    expect(restored).toBeDefined();
    expect(restored!.command).toBe('echo hello');
    registry2.destroy();
  });

  it('readOutput returns task output', async () => {
    const task = registry.spawn('echo out1 && echo out2');
    await registry.waitFor(task.id);
    const out = await registry.readOutput(task.id, 'stdout');
    expect(out).toContain('out1');
    expect(out).toContain('out2');
  });
});
