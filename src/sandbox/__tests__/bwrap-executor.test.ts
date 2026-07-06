// src/sandbox/__tests__/bwrap-executor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildBwrapCommand, isBwrapAvailable, findBwrap } from '../bwrap-executor';
import { createPathPolicy } from '../path-policy';
import path from 'node:path';

describe('findBwrap', () => {
  it('returns a string path or null', () => {
    const result = findBwrap();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('isBwrapAvailable', () => {
  it('returns a boolean', () => {
    expect(typeof isBwrapAvailable()).toBe('boolean');
  });
});

describe('buildBwrapCommand', () => {
  let policy: ReturnType<typeof createPathPolicy>;

  beforeEach(() => {
    policy = createPathPolicy();
  });

  it('starts with bwrap', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    expect(cmd[0]).toBe('bwrap');
  });

  it('includes --ro-bind / /', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--ro-bind / /');
  });

  it('includes --tmpfs /tmp', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--tmpfs /tmp');
  });

  it('includes --bind /dev /dev', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--bind /dev /dev');
  });

  it('includes --bind /dev/shm /dev/shm', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--bind /dev/shm /dev/shm');
  });

  it('includes --unshare-pid and --share-net', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--unshare-pid');
    expect(joined).toContain('--share-net');
  });

  it('includes --bind for registered writable paths', () => {
    const workspacePath = path.resolve('/mnt/workspace');
    policy.registerWritable(workspacePath);
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain(`--bind ${workspacePath} ${workspacePath}`);
  });

  it('includes --bind for docker socket', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).toContain('--bind /var/run/docker.sock /var/run/docker.sock');
  });

  it('ends with -- followed by the target command', () => {
    const cmd = buildBwrapCommand('echo hello world', policy);
    const afterDash = cmd.slice(cmd.indexOf('--') + 1);
    expect(afterDash.join(' ')).toBe('echo hello world');
  });

  it('wraps command in shell when shell wrapper is needed', () => {
    const cmd = buildBwrapCommand('echo "hello world"', policy);
    const afterDash = cmd.slice(cmd.indexOf('--') + 1);
    // Complex commands with quotes should be wrapped in sh -c
    expect(afterDash[0]).toBe('sh');
    expect(afterDash[1]).toBe('-c');
  });
});
