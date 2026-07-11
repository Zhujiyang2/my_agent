// src/tools/shell/__tests__/run-command.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCommandTool } from '../run-command';
import { createTaskRegistry, setTaskRegistry, getTaskRegistry } from '../../../tasks/registry';

const TEST_DIR = path.join(os.tmpdir(), 'my-agent-run-cmd-test');

describe('runCommandTool', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    setTaskRegistry(createTaskRegistry(TEST_DIR));
  });

  afterEach(async () => {
    const reg = getTaskRegistry();
    // Wait for all running tasks to settle before cleanup
    if (reg) {
      const running = reg.list({ status: 'running' });
      for (const t of running) {
        try { reg.kill(t.id); } catch { /* ignore */ }
      }
      // Give processes time to exit
      await new Promise(r => setTimeout(r, 200));
      reg.destroy();
    }
    setTaskRegistry(null);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('has correct name', () => {
    expect(runCommandTool.name).toBe('run_command');
  });

  it('spawns a command and returns task id placeholder', async () => {
    const result = await runCommandTool.handler({ command: 'echo hello' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Task started');
    expect(result.content).toMatch(/job-/);
  });

  it('returns error for empty command', async () => {
    const result = await runCommandTool.handler({ command: '' });
    expect(result.isError).toBe(true);
  });

  it('returns structured ToolResult with summary and exitCode', async () => {
    const result = await runCommandTool.handler({ command: 'echo hello' });
    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(result.summary).toContain('spawned');
    expect(result.exitCode).toBe(0);
    expect(result.keyOutput).toBeDefined();
  });

  it('task appears in registry after spawn', async () => {
    const result = await runCommandTool.handler({ command: 'echo quick-test' });
    const taskId = result.keyOutput?.match(/job-\d+-\w+/)?.[0];
    expect(taskId).toBeDefined();
    const reg = getTaskRegistry();
    expect(reg).not.toBeNull();
    const task = reg!.get(taskId!);
    expect(task).toBeDefined();
    expect(task!.status).toBe('running');
    // Wait for completion
    await reg!.waitFor(taskId!);
  });

  it('returns correct summary format', async () => {
    const result = await runCommandTool.handler({ command: 'echo test' });
    expect(result.summary).toMatch(/job-\d+-\w+: spawned/);
  });
});
