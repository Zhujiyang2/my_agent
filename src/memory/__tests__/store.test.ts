import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMemoryStore, type MemoryStore } from '../store';
import type { MemoryFile } from '../types';

const TEST_DIR = path.join(os.tmpdir(), `my-agent-memory-test-${Date.now()}`);

function makeFile(overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    name: 'test-memory',
    description: 'A test memory',
    metadata: {
      type: 'user',
      accessed_at: '2026-07-04T12:00:00Z',
      compressed: false,
    },
    body: 'This is the body content.\n\n**Why:** testing.\n',
    ...overrides,
  };
}

describe('createMemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    store = createMemoryStore(TEST_DIR);
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── write ──

  it('writes a .md file with frontmatter and body', () => {
    const mf = makeFile();
    store.write(mf);

    const filePath = path.join(TEST_DIR, 'test-memory.md');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('name: test-memory');
    expect(content).toContain('description: A test memory');
    expect(content).toContain('type: user');
    expect(content).toContain('This is the body content.');
  });

  it('overwrites an existing memory file', () => {
    store.write(makeFile());
    store.write(makeFile({ body: 'Updated body.' }));

    const content = fs.readFileSync(path.join(TEST_DIR, 'test-memory.md'), 'utf-8');
    expect(content).toContain('Updated body.');
  });

  // ── read ──

  it('reads a .md file and parses frontmatter + body', () => {
    store.write(makeFile());
    const result = store.read('test-memory');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('test-memory');
    expect(result!.description).toBe('A test memory');
    expect(result!.metadata.type).toBe('user');
    expect(result!.body).toContain('This is the body content.');
  });

  it('returns null for non-existent file', () => {
    expect(store.read('nonexistent')).toBeNull();
  });

  it('returns null for a damaged file (bad frontmatter)', () => {
    const filePath = path.join(TEST_DIR, 'bad.md');
    fs.writeFileSync(filePath, 'no frontmatter here\njust text');
    const result = store.read('bad');
    expect(result).toBeNull();
  });

  // ── delete ──

  it('deletes a .md file', () => {
    store.write(makeFile());
    const removed = store.delete('test-memory');
    expect(removed).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, 'test-memory.md'))).toBe(false);
  });

  it('returns false when deleting non-existent file', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  // ── list ──

  it('lists all memory names from .md files', () => {
    store.write(makeFile({ name: 'alpha' }));
    store.write(makeFile({ name: 'beta' }));
    store.write(makeFile({ name: 'gamma' }));

    const names = store.list();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('gamma');
    expect(names).toHaveLength(3);
  });

  it('returns empty array when directory does not exist', () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    const names = store.list();
    expect(names).toEqual([]);
  });

  // ── MEMORY.md index ──

  it('updates MEMORY.md with upsert on write', () => {
    store.write(makeFile({ name: 'alpha', description: 'First memory' }));
    store.write(makeFile({ name: 'beta', description: 'Second memory' }));

    const indexPath = path.join(TEST_DIR, 'MEMORY.md');
    const index = fs.readFileSync(indexPath, 'utf-8');
    expect(index).toContain('[alpha](alpha.md) — First memory');
    expect(index).toContain('[beta](beta.md) — Second memory');
  });

  it('upserts existing entry in MEMORY.md (no duplicate lines)', () => {
    store.write(makeFile({ name: 'alpha', description: 'First memory' }));
    store.write(makeFile({ name: 'alpha', description: 'Updated description' }));

    const index = fs.readFileSync(path.join(TEST_DIR, 'MEMORY.md'), 'utf-8');
    const lines = index.split('\n').filter(l => l.includes('alpha'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Updated description');
  });

  it('removes entry from MEMORY.md on delete', () => {
    store.write(makeFile({ name: 'alpha' }));
    store.write(makeFile({ name: 'beta' }));
    store.delete('alpha');

    const index = fs.readFileSync(path.join(TEST_DIR, 'MEMORY.md'), 'utf-8');
    expect(index).not.toContain('alpha');
    expect(index).toContain('beta');
  });

  // ── updateAccessedAt ──

  it('updates accessed_at without touching body content', () => {
    store.write(makeFile({ body: 'secret body content.' }));
    store.updateAccessedAt('test-memory', '2026-07-05T10:00:00Z');

    const file = store.read('test-memory');
    expect(file).not.toBeNull();
    expect(file!.metadata.accessed_at).toBe('2026-07-05T10:00:00Z');
    expect(file!.body).toContain('secret body content.');
  });

  it('updateAccessedAt keeps encoded content intact', () => {
    // Write a file with content that looks like an encoded marker
    store.write(makeFile({ name: 'encoded-mem', body: 'Ref: {enc:abc123} is encoded.' }));
    store.updateAccessedAt('encoded-mem', '2026-01-01T00:00:00Z');

    const file = store.read('encoded-mem');
    expect(file!.metadata.accessed_at).toBe('2026-01-01T00:00:00Z');
    expect(file!.body).toContain('{enc:abc123}');
  });

  // ── name validation ──

  it('rejects invalid names', () => {
    const invalidNames = ['', '-bad', 'bad-', 'UPPERCASE', 'has space', 'has_underscore'];
    for (const name of invalidNames) {
      expect(() => store.write(makeFile({ name }))).toThrow();
    }
  });
});
