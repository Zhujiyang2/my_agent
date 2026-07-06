// src/sandbox/__tests__/bwrap-executor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildBwrapCommand, isBwrapAvailable, findBwrap, fixResolvConf } from '../bwrap-executor';
import { createPathPolicy } from '../path-policy';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

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

describe('fixResolvConf', () => {
  const tmpResolv = path.join(os.tmpdir(), `test-resolv-${Date.now()}.conf`);

  afterEach(() => {
    try { fs.unlinkSync(tmpResolv); } catch {}
    try { fs.unlinkSync('/tmp/my-agent-resolv.conf'); } catch {}
  });

  it('returns null when resolv.conf has external nameserver', () => {
    fs.writeFileSync(tmpResolv, 'nameserver 8.8.8.8\n');
    const result = fixResolvConf(tmpResolv);
    expect(result).toBeNull();
  });

  it('returns a path when resolv.conf has localhost nameserver (127.0.0.53)', () => {
    fs.writeFileSync(tmpResolv, 'nameserver 127.0.0.53\n');
    const result = fixResolvConf(tmpResolv);
    // Should return a path to a fixed resolv.conf
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    const content = fs.readFileSync(result!, 'utf-8');
    expect(content).toContain('nameserver');
  });

  it('returns null for non-existent file', () => {
    const result = fixResolvConf('/nonexistent/resolv.conf');
    expect(result).toBeNull();
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

  it('includes --bind for docker socket if it exists', () => {
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    // docker.sock is only bound if it exists on the host
    if (fs.existsSync('/var/run/docker.sock')) {
      expect(joined).toContain('--bind /var/run/docker.sock /var/run/docker.sock');
    }
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

  it('adds --bind for fixed resolv.conf when host uses systemd-resolved', () => {
    // Create a temp resolv.conf with localhost nameserver
    const tmpResolv = path.join(os.tmpdir(), `test-resolv-dns-${Date.now()}.conf`);
    fs.writeFileSync(tmpResolv, 'nameserver 127.0.0.53\n');
    try {
      const cmd = buildBwrapCommand('echo hello', policy, { resolvConfPath: tmpResolv });
      const joined = cmd.join(' ');
      expect(joined).toContain('/etc/resolv.conf');
      // The fixed resolv.conf should exist
      const fixPath = fixResolvConf(tmpResolv);
      expect(fixPath).not.toBeNull();
      if (fixPath) {
        try { fs.unlinkSync(fixPath); } catch {}
      }
    } finally {
      try { fs.unlinkSync(tmpResolv); } catch {}
    }
  });

  it('does NOT add resolv.conf override when nameserver is external', () => {
    const tmpResolv = path.join(os.tmpdir(), `test-resolv-ext-${Date.now()}.conf`);
    fs.writeFileSync(tmpResolv, 'nameserver 8.8.8.8\n');
    try {
      const cmd = buildBwrapCommand('echo hello', policy, { resolvConfPath: tmpResolv });
      const joined = cmd.join(' ');
      // Should not include the DNS fix bind
      expect(joined).not.toContain('my-agent-resolv.conf');
    } finally {
      try { fs.unlinkSync(tmpResolv); } catch {}
    }
  });
});
