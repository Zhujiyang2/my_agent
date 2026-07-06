// src/sandbox/__tests__/net-domains.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { loadSandboxDomains } from '../net-domains';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('loadSandboxDomains', () => {
  const tmpFile = path.join(os.tmpdir(), `sandbox-domains-test-${Date.now()}.json`);

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('returns empty config when file does not exist', () => {
    const result = loadSandboxDomains('/nonexistent/path/domains.json');
    expect(result.extra_allowed_domains).toEqual([]);
    expect(result.blocked_domains).toEqual([]);
  });

  it('loads domains from a valid file', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      extra_allowed_domains: ['example.com'],
      blocked_domains: ['bad.com'],
    }));
    const result = loadSandboxDomains(tmpFile);
    expect(result.extra_allowed_domains).toEqual(['example.com']);
    expect(result.blocked_domains).toEqual(['bad.com']);
  });

  it('returns empty config for malformed JSON', () => {
    fs.writeFileSync(tmpFile, '{not json}');
    const result = loadSandboxDomains(tmpFile);
    expect(result.extra_allowed_domains).toEqual([]);
    expect(result.blocked_domains).toEqual([]);
  });

  it('filters non-string entries from arrays', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      extra_allowed_domains: ['good.com', 123, null, ''],
      blocked_domains: ['bad.com', {}, true],
    }));
    const result = loadSandboxDomains(tmpFile);
    expect(result.extra_allowed_domains).toEqual(['good.com']);
    expect(result.blocked_domains).toEqual(['bad.com']);
  });

  it('defaults missing fields to empty arrays', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({}));
    const result = loadSandboxDomains(tmpFile);
    expect(result.extra_allowed_domains).toEqual([]);
    expect(result.blocked_domains).toEqual([]);
  });
});
