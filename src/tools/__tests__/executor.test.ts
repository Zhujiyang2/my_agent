// src/tools/__tests__/executor.test.ts
import { describe, it, expect } from 'vitest';
import { isHighRisk, HIGH_RISK_PATTERNS } from '../executor';

describe('isHighRisk', () => {
  it('detects file destruction: rm, dd, mkfs, shred', () => {
    expect(isHighRisk('rm -rf /data/*')).toBe(true);
    expect(isHighRisk('dd if=/dev/zero of=/dev/sda')).toBe(true);
    expect(isHighRisk('mkfs.ext4 /dev/sdb')).toBe(true);
    expect(isHighRisk('shred -u secret.txt')).toBe(true);
  });

  it('detects system state changes', () => {
    expect(isHighRisk('shutdown -h now')).toBe(true);
    expect(isHighRisk('reboot')).toBe(true);
    expect(isHighRisk('halt -p')).toBe(true);
  });

  it('detects permission changes', () => {
    expect(isHighRisk('chmod -R 777 /etc')).toBe(true);
    expect(isHighRisk('chown root:root /usr/bin/binary')).toBe(true);
  });

  it('detects process termination', () => {
    expect(isHighRisk('kill -9 1234')).toBe(true);
    expect(isHighRisk('pkill python')).toBe(true);
    expect(isHighRisk('killall nginx')).toBe(true);
  });

  it('detects network changes', () => {
    expect(isHighRisk('iptables -F')).toBe(true);
    expect(isHighRisk('ip link set eth0 down')).toBe(true);
  });

  it('detects disk operations', () => {
    expect(isHighRisk('fdisk /dev/sda')).toBe(true);
    expect(isHighRisk('mount /dev/sda1 /mnt')).toBe(true);
    expect(isHighRisk('umount /mnt')).toBe(true);
  });

  it('allows safe read-only commands', () => {
    expect(isHighRisk('ls -la')).toBe(false);
    expect(isHighRisk('cat file.txt')).toBe(false);
    expect(isHighRisk('head -n 10 log.txt')).toBe(false);
    expect(isHighRisk('grep error *.log')).toBe(false);
    expect(isHighRisk('ps aux')).toBe(false);
    expect(isHighRisk('nvidia-smi')).toBe(false);
    expect(isHighRisk('npu-smi info')).toBe(false);
    expect(isHighRisk('df -h')).toBe(false);
    expect(isHighRisk('free -m')).toBe(false);
    expect(isHighRisk('docker ps')).toBe(false);
    expect(isHighRisk('echo hello')).toBe(false);
  });

  it('does not false-positive when risk word appears as argument', () => {
    expect(isHighRisk('cat /var/log/kill.log')).toBe(false);
    expect(isHighRisk('ls /mnt/mount_point')).toBe(false);
  });

  it('all patterns are non-empty regex', () => {
    for (const pattern of HIGH_RISK_PATTERNS) {
      expect(pattern.source.length).toBeGreaterThan(0);
    }
  });
});
