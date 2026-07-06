// src/sandbox/__tests__/path-policy.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createPathPolicy } from '../path-policy';
import os from 'node:os';
import path from 'node:path';

describe('createPathPolicy', () => {
  let policy: ReturnType<typeof createPathPolicy>;

  beforeEach(() => {
    policy = createPathPolicy();
  });

  describe('classify', () => {
    it('returns "protect" for ~/.ssh paths', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.ssh/id_rsa`)).toBe('protect');
      expect(policy.classify(`${home}/.ssh/known_hosts`)).toBe('protect');
    });

    it('returns "protect" for ~/.aws/credentials', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.aws/credentials`)).toBe('protect');
    });

    it('returns "protect" for ~/.kube/config', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.kube/config`)).toBe('protect');
    });

    it('returns "protect" for ~/.gitconfig', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.gitconfig`)).toBe('protect');
    });

    it('returns "protect" for ~/.docker/config.json', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.docker/config.json`)).toBe('protect');
    });

    it('returns "protect" for ~/.config/gcloud paths', () => {
      const home = os.homedir();
      expect(policy.classify(`${home}/.config/gcloud/credentials.db`)).toBe('protect');
    });

    it('returns "protect" for /etc/shadow', () => {
      expect(policy.classify('/etc/shadow')).toBe('protect');
    });

    it('returns "protect" for /etc/ssl/private paths', () => {
      expect(policy.classify('/etc/ssl/private/key.pem')).toBe('protect');
    });

    it('returns "protect" for /root paths', () => {
      expect(policy.classify('/root/.bashrc')).toBe('protect');
      expect(policy.classify('/root')).toBe('protect');
    });

    it('returns "protect" for /proc/sys', () => {
      expect(policy.classify('/proc/sys/net/ipv4/ip_forward')).toBe('protect');
    });

    it('returns "protect" for /sys/kernel', () => {
      expect(policy.classify('/sys/kernel/debug')).toBe('protect');
    });

    it('returns "explore" for ordinary filesystem paths', () => {
      expect(policy.classify('/usr/bin/bash')).toBe('explore');
      expect(policy.classify('/etc/hosts')).toBe('explore');
      expect(policy.classify('/etc/localtime')).toBe('explore');
      expect(policy.classify('/mnt/data')).toBe('explore');
      expect(policy.classify('/home/user/projects')).toBe('explore');
    });

    it('returns "writable" for registered paths', () => {
      policy.registerWritable('/mnt/nvme0/workspace');
      expect(policy.classify('/mnt/nvme0/workspace')).toBe('writable');
      expect(policy.classify('/mnt/nvme0/workspace/models')).toBe('writable');
    });

    it('returns "writable" for /tmp (always writable)', () => {
      expect(policy.classify('/tmp/some-file')).toBe('writable');
      expect(policy.classify('/tmp')).toBe('writable');
    });
  });

  describe('registerWritable', () => {
    it('registers a valid path', () => {
      const result = policy.registerWritable('/mnt/data/workspace');
      expect(result.ok).toBe(true);
    });

    it('rejects paths under /etc', () => {
      const result = policy.registerWritable('/etc/my-app/config');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('system-critical');
    });

    it('rejects paths under /boot', () => {
      const result = policy.registerWritable('/boot/grub');
      expect(result.ok).toBe(false);
    });

    it('rejects paths under /sys', () => {
      const result = policy.registerWritable('/sys/class/gpio');
      expect(result.ok).toBe(false);
    });

    it('rejects paths under /proc', () => {
      const result = policy.registerWritable('/proc/test');
      expect(result.ok).toBe(false);
    });

    it('rejects paths inside protect directories', () => {
      const home = os.homedir();
      const result = policy.registerWritable(`${home}/.ssh/workspace`);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('protected');
    });
  });

  describe('unregisterWritable', () => {
    it('removes a previously registered path', () => {
      policy.registerWritable('/mnt/data');
      expect(policy.classify('/mnt/data')).toBe('writable');
      policy.unregisterWritable('/mnt/data');
      expect(policy.classify('/mnt/data')).toBe('explore');
    });
  });

  describe('extra protect paths', () => {
    it('honors extra protect paths from config', () => {
      const p = createPathPolicy({ extraProtectPaths: ['/opt/secrets'] });
      expect(p.classify('/opt/secrets/token')).toBe('protect');
    });
  });

  describe('getWritablePaths', () => {
    it('returns all registered writable paths', () => {
      const a = path.resolve('/mnt/a');
      const b = path.resolve('/data/b');
      policy.registerWritable(a);
      policy.registerWritable(b);
      const paths = policy.getWritablePaths();
      expect(paths).toContain(a);
      expect(paths).toContain(b);
    });
  });

  describe('getProtectPaths', () => {
    it('returns built-in and extra protect paths', () => {
      const paths = policy.getProtectPaths();
      const home = os.homedir();
      expect(paths).toContain(`${home}/.ssh`);
    });
  });
});
