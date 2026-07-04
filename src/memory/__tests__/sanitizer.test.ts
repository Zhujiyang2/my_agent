// src/memory/__tests__/sanitizer.test.ts
import { describe, it, expect } from 'vitest';
import { sanitize } from '../sanitizer';

describe('sanitize', () => {
  it('redacts password in key=value context', () => {
    const result = sanitize('password=hunter2', 'test');
    expect(result.content).toContain('password=[REDACTED]');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('password');
  });

  it('redacts api_key in key: value context', () => {
    const result = sanitize('api_key: sk-abc123xyz', 'test');
    expect(result.content).toContain('api_key: [REDACTED]');
  });

  it('redacts token value', () => {
    const result = sanitize('token=ghp_abc123def456', 'test');
    expect(result.content).toContain('token=[REDACTED]');
  });

  it('redacts secret value', () => {
    const result = sanitize('secret: mysecret123', 'test');
    expect(result.content).toContain('secret: [REDACTED]');
  });

  it('redacts access_key value', () => {
    const result = sanitize('access_key=AKIA123456', 'test');
    expect(result.content).toContain('access_key=[REDACTED]');
  });

  it('redacts email addresses', () => {
    const result = sanitize('Contact me at john@example.com for help.', 'test');
    expect(result.content).toContain('[EMAIL]');
    expect(result.content).not.toContain('john@example.com');
  });

  it('redacts Chinese mobile phone numbers', () => {
    const result = sanitize('Call 13812345678 for support.', 'test');
    expect(result.content).toContain('[PHONE]');
    expect(result.content).not.toContain('13812345678');
  });

  it('does not redact non-phone 11-digit numbers (e.g., timestamps)', () => {
    const result = sanitize('timestamp: 1700000000000', 'test');
    expect(result.warnings).toHaveLength(0);
  });

  it('redacts Chinese name after "姓名"', () => {
    const result = sanitize('姓名张三，工号12345', 'test');
    expect(result.content).toContain('[姓名]');
    expect(result.content).not.toContain('张三');
  });

  it('redacts Chinese name after "名字"', () => {
    const result = sanitize('名字李四在这里', 'test');
    expect(result.content).toContain('[姓名]');
    expect(result.content).not.toContain('李四');
  });

  it('redacts Chinese name after "我是"', () => {
    const result = sanitize('我是王五，负责这个项目', 'test');
    expect(result.content).toContain('[姓名]');
    expect(result.content).not.toContain('王五');
  });

  it('redacts employee ID after "工号"', () => {
    const result = sanitize('工号12345 负责', 'test');
    expect(result.content).toContain('[ID]');
    expect(result.content).not.toContain('12345');
  });

  it('redacts employee_id value', () => {
    const result = sanitize('employee_id: EMP-001', 'test');
    expect(result.content).toContain('employee_id: [ID]');
  });

  it('redacts IPv4 addresses', () => {
    const result = sanitize('Server at 192.168.1.100 is running.', 'test');
    expect(result.content).toContain('[IP]');
    expect(result.content).not.toContain('192.168.1.100');
  });

  it('redacts other IPv4 addresses', () => {
    const result = sanitize('Host: 10.0.0.1', 'test');
    expect(result.content).toContain('[IP]');
  });

  it('does not modify clean content', () => {
    const clean = '用户偏好使用 React + TypeScript。**Why:** 生态丰富。';
    const result = sanitize(clean, 'test');
    expect(result.content).toBe(clean);
    expect(result.warnings).toHaveLength(0);
  });

  it('does not redact version numbers that look like IPs', () => {
    const result = sanitize('Version 1.2.3 is installed', 'test');
    expect(result.warnings).toHaveLength(0);
  });
});
