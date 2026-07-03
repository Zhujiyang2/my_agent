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
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/not found/i);
  });

  it('successfully loads a valid config file', () => {
    const config = { api_url: 'https://api.example.com/v1', model: 'test', api_key: 'sk-test' };
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(config));

    const result = loadConfig(TEST_CONFIG_FILE);
    expect(result).toEqual({
      ...config,
      tools: {
        safety_mode: 'auto',
        max_loop_rounds: 10,
        command_timeout: 60,
        background_timeout: 0,
      },
    });
  });

  it('throws on malformed JSON', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, '{ not json }');
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/Invalid JSON/i);
  });

  it('throws on JSON array instead of object', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, '[1, 2, 3]');
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/JSON object/i);
  });

  it('throws when api_url is missing', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ model: 'm', api_key: 'k' }));
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/missing.*api_url/i);
  });

  it('throws when model is missing', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ api_url: 'u', api_key: 'k' }));
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/missing.*model/i);
  });

  it('throws when api_key is missing', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ api_url: 'u', model: 'm' }));
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/missing.*api_key/i);
  });

  it('throws when a field has wrong type', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ api_url: 123, model: 'm', api_key: 'k' }));
    expect(() => loadConfig(TEST_CONFIG_FILE)).toThrow(/must be a string/);
  });

  it('provides default tools config when not specified', () => {
    const config = { api_url: 'https://api.example.com/v1', model: 'test', api_key: 'sk-test' };
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(config));

    const result = loadConfig(TEST_CONFIG_FILE);
    expect(result.tools).toEqual({
      safety_mode: 'auto',
      max_loop_rounds: 10,
      command_timeout: 60,
      background_timeout: 0,
    });
  });

  it('loads config from default path (~/.my_agent/config.json)', () => {
    // When no filePath is given, loadConfig uses the real ~/.my_agent/config.json
    const result = loadConfig();
    expect(result).toHaveProperty('api_url');
    expect(result).toHaveProperty('model');
    expect(result).toHaveProperty('api_key');
    expect(typeof result.api_url).toBe('string');
    expect(typeof result.model).toBe('string');
    expect(typeof result.api_key).toBe('string');
  });
});
