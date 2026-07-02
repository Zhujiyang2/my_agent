// src/config/__tests__/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../loader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'my-agent-test-' + Date.now());
const TEST_CONFIG_FILE = path.join(TEST_CONFIG_DIR, 'config.json');

describe('loadConfig', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    try { fs.unlinkSync(TEST_CONFIG_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_CONFIG_DIR, { recursive: true }); } catch {}
  });

  it('throws when config file does not exist', () => {
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/not found|ENOENT|config/i);
  });

  it('successfully loads a valid config file', () => {
    const config = { api_url: 'https://api.example.com/v1', model: 'test', api_key: 'sk-test' };
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(config));

    const result = loadConfig(TEST_CONFIG_FILE);
    expect(result).toEqual(config);
  });

  it('throws on malformed JSON', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, '{ not json }');
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow();
  });

  it('throws when api_url is missing', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ model: 'm', api_key: 'k' }));
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/api_url/);
  });

  it('throws when model is missing', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ api_url: 'u', api_key: 'k' }));
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/model/);
  });

  it('throws when api_key is missing', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ api_url: 'u', model: 'm' }));
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/api_key/);
  });
});
