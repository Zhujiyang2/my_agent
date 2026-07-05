// src/memory/__tests__/sanitizer.test.ts
import { describe, it, expect } from 'vitest';
import { encode, decode } from '../sanitizer';

describe('encode + decode round-trip', () => {
  it('encodes and decodes IP addresses reversibly', () => {
    const result = encode('Server at 192.168.1.100 is running.', 'test');
    expect(result.content).not.toContain('192.168.1.100');
    expect(result.content).toMatch(/\{enc:[A-Za-z0-9+/=]+\}/);
    expect(result.warnings.length).toBeGreaterThan(0);

    const decoded = decode(result.content);
    expect(decoded).toContain('192.168.1.100');
    expect(decoded).not.toContain('{enc:');
  });

  it('encodes and decodes credentials reversibly', () => {
    const result = encode('password=hunter2', 'test');
    expect(result.content).not.toContain('hunter2');
    expect(result.content).toContain('password=');
    expect(result.content).toMatch(/\{enc:/);

    const decoded = decode(result.content);
    expect(decoded).toContain('password=hunter2');
  });

  it('encodes and decodes token values', () => {
    const result = encode('token=ghp_abc123def456', 'test');
    expect(result.content).not.toContain('ghp_abc123def456');
    const decoded = decode(result.content);
    expect(decoded).toContain('token=ghp_abc123def456');
  });

  it('encodes and decodes api_key values', () => {
    const result = encode('api_key: sk-abc123xyz', 'test');
    expect(result.content).not.toContain('sk-abc123xyz');
    const decoded = decode(result.content);
    expect(decoded).toContain('api_key: sk-abc123xyz');
  });

  it('encodes and decodes secret values', () => {
    const result = encode('secret: mysecret123', 'test');
    const decoded = decode(result.content);
    expect(decoded).toContain('secret: mysecret123');
  });

  it('encodes and decodes multiple IPs in one text', () => {
    const result = encode('Host: 10.0.0.1, DNS: 8.8.8.8', 'test');
    const decoded = decode(result.content);
    expect(decoded).toContain('10.0.0.1');
    expect(decoded).toContain('8.8.8.8');
  });

  it('does not encode version numbers (3-part)', () => {
    const result = encode('Version 1.2.3 is installed', 'test');
    expect(result.warnings).toHaveLength(0);
  });

  // ── One-way PII (NOT reversible) ──

  it('redacts email addresses (one-way)', () => {
    const result = encode('Contact john@example.com', 'test');
    expect(result.content).toContain('[EMAIL]');
    expect(result.content).not.toContain('john@example.com');
    // Cannot decode back
    const decoded = decode(result.content);
    expect(decoded).toContain('[EMAIL]'); // stays redacted
  });

  it('redacts Chinese phone numbers (one-way)', () => {
    const result = encode('Call 13812345678', 'test');
    expect(result.content).toContain('[PHONE]');
    expect(result.content).not.toContain('13812345678');
  });

  it('redacts Chinese names (one-way)', () => {
    const result = encode('姓名张三', 'test');
    expect(result.content).toContain('[姓名]');
    expect(result.content).not.toContain('张三');
  });

  it('redacts employee IDs (one-way)', () => {
    const result = encode('工号12345 负责', 'test');
    expect(result.content).toContain('[ID]');
    expect(result.content).not.toContain('12345');
  });

  it('does not modify clean content', () => {
    const clean = '用户偏好使用 React + TypeScript。**Why:** 生态丰富。';
    const result = encode(clean, 'test');
    expect(result.content).toBe(clean);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('decode', () => {
  it('returns text unchanged when no encoded markers', () => {
    expect(decode('plain text')).toBe('plain text');
  });

  it('handles corrupt encoded marker gracefully', () => {
    expect(decode('{enc:notbase64!!!}')).toBe('{enc:notbase64!!!}');
  });
});
