// src/tools/shell/__tests__/run-command.test.ts
import { describe, it, expect } from 'vitest';
import { runCommandTool } from '../run-command';
import os from 'node:os';

describe('runCommandTool', () => {
  it('has correct name', () => {
    expect(runCommandTool.name).toBe('run_command');
  });

  it('executes a simple command and returns stdout', async () => {
    const result = await runCommandTool.handler({ command: 'echo hello' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello');
    expect(result.content).toContain('exit code: 0');
  });

  it('executes command in a specified workdir', async () => {
    const tmp = os.tmpdir();
    const result = await runCommandTool.handler({ command: 'echo %cd%', workdir: tmp });
    expect(result.isError).toBeFalsy();
    expect(result.content.toLowerCase()).toContain('temp');
  });

  it('captures stderr when command fails', async () => {
    const result = await runCommandTool.handler({ command: 'node -e "console.error(\'error msg\'); process.exit(1)"' });
    expect(result.content).toContain('error msg');
    expect(result.content).toContain('exit code: 1');
  });

  it('reports non-zero exit code', async () => {
    const result = await runCommandTool.handler({ command: 'exit 1' });
    expect(result.content).toContain('exit code: 1');
  });

  it('handles command not found gracefully', async () => {
    const result = await runCommandTool.handler({ command: 'nonexistent_command_xyz' });
    expect(result.content).toContain('exit code');
  });

  it('returns error for empty command', async () => {
    const result = await runCommandTool.handler({ command: '' });
    expect(result.isError).toBe(true);
  });
});
