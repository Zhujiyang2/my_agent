import fs from 'node:fs';
import path from 'node:path';
import type { MemoryFile } from './types';

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface MemoryStore {
  write(file: MemoryFile): void;
  read(name: string): MemoryFile | null;
  delete(name: string): boolean;
  list(): string[];
}

export function createMemoryStore(memoryDir: string): MemoryStore {
  function ensureDir(): void {
    fs.mkdirSync(memoryDir, { recursive: true });
  }

  function validateName(name: string): void {
    if (!NAME_RE.test(name)) {
      throw new Error(
        `Invalid memory name: "${name}". Must match ${NAME_RE.source} (lowercase letters, digits, hyphens; must start with letter and not end with hyphen).`,
      );
    }
  }

  function filePath(name: string): string {
    return path.join(memoryDir, `${name}.md`);
  }

  function indexPath(): string {
    return path.join(memoryDir, 'MEMORY.md');
  }

  // ── Frontmatter encode/decode ──

  function encodeFrontmatter(file: MemoryFile): string {
    const lines = [
      '---',
      `name: ${file.name}`,
      `description: ${file.description}`,
      `metadata:`,
      `  type: ${file.metadata.type}`,
      `  accessed_at: ${file.metadata.accessed_at}`,
      `  compressed: ${file.metadata.compressed}`,
      '---',
      '',
      file.body,
    ];
    return lines.join('\n');
  }

  function decodeFrontmatter(raw: string): MemoryFile | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatterStr = match[1];
    const body = match[2];

    // Simple YAML-like parser for our constrained schema
    const fm: Record<string, string> = {};
    for (const line of frontmatterStr.split('\n')) {
      const kvMatch = line.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        fm[kvMatch[1]] = kvMatch[2];
      } else {
        // nested under metadata
        const nestedMatch = line.match(/^\s+(\w+):\s*(.*)$/);
        if (nestedMatch) {
          fm[`metadata_${nestedMatch[1]}`] = nestedMatch[2];
        }
      }
    }

    if (!fm.name || !fm.description || !fm.metadata_type) return null;

    return {
      name: fm.name,
      description: fm.description,
      metadata: {
        type: fm.metadata_type as 'user' | 'agent',
        accessed_at: fm.metadata_accessed_at || new Date().toISOString(),
        compressed: fm.metadata_compressed === 'true',
      },
      body,
    };
  }

  // ── MEMORY.md index ──

  function readIndex(): string {
    ensureDir();
    const ip = indexPath();
    if (!fs.existsSync(ip)) return '';
    return fs.readFileSync(ip, 'utf-8');
  }

  function writeIndex(content: string): void {
    ensureDir();
    fs.writeFileSync(indexPath(), content, 'utf-8');
  }

  function upsertIndex(name: string, description: string): void {
    const existing = readIndex();
    const lines = existing.split('\n').filter(l => l.trim() !== '');
    const newLine = `- [${name}](${name}.md) — ${description}`;

    const existingIdx = lines.findIndex(l => l.includes(`[${name}](${name}.md)`));
    if (existingIdx >= 0) {
      lines[existingIdx] = newLine;
    } else {
      lines.push(newLine);
    }

    writeIndex(lines.join('\n') + '\n');
  }

  function removeFromIndex(name: string): void {
    const existing = readIndex();
    const lines = existing
      .split('\n')
      .filter(l => !l.includes(`[${name}](${name}.md)`));
    writeIndex(lines.join('\n'));
  }

  // ── Public API ──

  function write(file: MemoryFile): void {
    validateName(file.name);
    ensureDir();
    const fp = filePath(file.name);
    fs.writeFileSync(fp, encodeFrontmatter(file), 'utf-8');
    upsertIndex(file.name, file.description);
  }

  function read(name: string): MemoryFile | null {
    validateName(name);
    const fp = filePath(name);
    if (!fs.existsSync(fp)) return null;
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      return decodeFrontmatter(raw);
    } catch {
      return null;
    }
  }

  function deleteFile(name: string): boolean {
    validateName(name);
    const fp = filePath(name);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    removeFromIndex(name);
    return true;
  }

  function list(): string[] {
    ensureDir();
    try {
      return fs
        .readdirSync(memoryDir)
        .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
        .map(f => f.replace(/\.md$/, ''));
    } catch {
      return [];
    }
  }

  return { write, read, delete: deleteFile, list };
}
