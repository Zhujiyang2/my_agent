// src/skills/__tests__/skill-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRegistry, defaultRegistry } from '../../tools/registry';
import { loadSkills } from '../skill-tool';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'my-agent-skill-test-'));
}

function writeSkillFile(
  dir: string,
  filename: string,
  name: string,
  description: string,
  body: string = '# Test Skill\n\nDo things.\n',
): string {
  const filePath = path.join(dir, filename);
  const content = `---
name: ${name}
description: ${description}
---
${body}`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('loadSkills', () => {
  afterEach(() => {
    try { defaultRegistry.remove('Skill'); } catch { /* ignore */ }
  });

  it('does not register a tool when the directory does not exist', () => {
    loadSkills('/nonexistent/path/to/skills');
    expect(defaultRegistry.get('Skill')).toBeUndefined();
  });

  it('does not register a tool when the directory is empty', () => {
    const dir = createTempDir();
    try {
      loadSkills(dir);
      expect(defaultRegistry.get('Skill')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not register a tool when the path is a file, not a directory', () => {
    const dir = createTempDir();
    const filePath = path.join(dir, 'not-a-dir');
    fs.writeFileSync(filePath, 'hello', 'utf-8');
    try {
      loadSkills(filePath);
      expect(defaultRegistry.get('Skill')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers a Skill tool with correct name and enum', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'brainstorming.md', 'brainstorming', '帮助将想法转化为设计文档');
      writeSkillFile(dir, 'writing-plans.md', 'writing-plans', '编写实现计划');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('Skill');
      expect(tool!.description).toContain('brainstorming - 帮助将想法转化为设计文档');
      expect(tool!.description).toContain('writing-plans - 编写实现计划');
      expect(tool!.parameters.properties.name.enum).toEqual(['brainstorming', 'writing-plans']);
      expect(tool!.parameters.required).toEqual(['name']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips .md files without valid frontmatter', () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'no-fm.md'), '# No frontmatter\n\nJust content.', 'utf-8');
      fs.writeFileSync(
        path.join(dir, 'no-desc.md'),
        '---\nname: incomplete\n---\n\nBody.',
        'utf-8',
      );
      writeSkillFile(dir, 'valid.md', 'valid', 'A valid skill');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['valid']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects skill with empty name (whitespace-only)', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'empty-name.md', '   ', 'Some description');
      writeSkillFile(dir, 'valid.md', 'valid', 'A valid skill');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['valid']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips surrounding quotes from both name and description', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'quoted.md', '"my-skill"', '"A quoted description"');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['my-skill']);
      expect(tool!.description).toContain('my-skill - A quoted description');
      // Strip only removes surrounding quotes from frontmatter values;
      // the description template contains legitimate Chinese quotes (e.g. "检查NPU")
      expect(tool!.description).toContain('A quoted description');
      expect(tool!.description).not.toContain('"A quoted description"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles duplicate skill names (latter wins)', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'first.md', 'dup', 'First version');
      writeSkillFile(dir, 'second.md', 'dup', 'Second version');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['dup']);
      expect(tool!.description).toContain('Second version');
      expect(tool!.description).not.toContain('First version');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles .MD uppercase extension on case-insensitive filesystems', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'UPPER.MD', 'upper', 'An uppercase extension skill');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['upper']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers into a custom registry when provided', () => {
    const customRegistry = createRegistry();
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'custom.md', 'custom', 'Custom registry skill');
      loadSkills(dir, customRegistry);

      // defaultRegistry should NOT have it
      expect(defaultRegistry.get('Skill')).toBeUndefined();
      // customRegistry SHOULD have it
      const tool = customRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['custom']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw on duplicate loadSkills call (idempotent)', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'a.md', 'a', 'Skill A');

      // First call registers
      loadSkills(dir);
      const tool1 = defaultRegistry.get('Skill');
      expect(tool1).toBeDefined();

      // Second call should be a no-op (idempotent)
      expect(() => loadSkills(dir)).not.toThrow();
      const tool2 = defaultRegistry.get('Skill');
      expect(tool2).toBe(tool1); // same instance
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sorts skill names deterministically', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'c.md', 'c-skill', 'Third');
      writeSkillFile(dir, 'a.md', 'a-skill', 'First');
      writeSkillFile(dir, 'b.md', 'b-skill', 'Second');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      // Enum should be sorted alphabetically by name
      expect(tool!.parameters.properties.name.enum).toEqual(['a-skill', 'b-skill', 'c-skill']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans .md files inside subdirectories (skills/<name>/<name>.md)', () => {
    const dir = createTempDir();
    try {
      const subDir = path.join(dir, 'my-skill');
      fs.mkdirSync(subDir);
      writeSkillFile(subDir, 'my-skill.md', 'my-skill', 'A subdirectory skill');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['my-skill']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mixes top-level .md files and subdirectory skills', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'legacy.md', 'legacy', 'A top-level skill');
      const subDir = path.join(dir, 'new-skill');
      fs.mkdirSync(subDir);
      writeSkillFile(subDir, 'new-skill.md', 'new-skill', 'A subdirectory skill');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['legacy', 'new-skill']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-.md files in subdirectories', () => {
    const dir = createTempDir();
    try {
      const subDir = path.join(dir, 'my-skill');
      fs.mkdirSync(subDir);
      writeSkillFile(subDir, 'my-skill.md', 'my-skill', 'A skill');
      fs.writeFileSync(path.join(subDir, 'script.sh'), '#!/bin/bash\necho hello', 'utf-8');
      fs.writeFileSync(path.join(subDir, 'config.json'), '{}', 'utf-8');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['my-skill']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Skill tool handler', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTempDir();
    writeSkillFile(dir, 'test.md', 'test-skill', 'A test skill', '# Test\n\nDo X then Y.');
    loadSkills(dir);
  });

  afterEach(() => {
    try { defaultRegistry.remove('Skill'); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns skill file content on success (from cache, no disk I/O)', async () => {
    const tool = defaultRegistry.get('Skill')!;
    const result = await tool.handler({ name: 'test-skill' });

    expect(result.exitCode).toBe(0);
    expect(result.content).toContain('# Test');
    expect(result.content).toContain('Do X then Y.');
    expect(result.content).toContain('---');
    expect(result.summary).toBe('已激活技能: test-skill');
  });

  it('returns cached content even when file was deleted after scan', async () => {
    const tool = defaultRegistry.get('Skill')!;
    // Delete the file — handler should still return cached content
    fs.rmSync(dir, { recursive: true, force: true });

    const result = await tool.handler({ name: 'test-skill' });
    expect(result.exitCode).toBe(0);
    expect(result.content).toContain('# Test');
    expect(result.content).toContain('Do X then Y.');
  });

  it('returns error for unknown skill name', async () => {
    const tool = defaultRegistry.get('Skill')!;
    const result = await tool.handler({ name: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.content).toContain('未知技能');
    expect(result.content).toContain('test-skill'); // lists available skills
  });

  it('handles quoted skill name correctly', async () => {
    // Use a fresh custom registry to avoid clash with beforeEach's registration
    const customRegistry = createRegistry();
    const dir2 = createTempDir();
    try {
      writeSkillFile(dir2, 'q.md', '"my-quoted-skill"', 'A skill with quoted name', '# Quoted\n\nContent.');
      loadSkills(dir2, customRegistry);

      const tool = customRegistry.get('Skill')!;
      expect(tool).toBeDefined();
      // Name was stripped of quotes, so enum uses unquoted name
      expect(tool!.parameters.properties.name.enum).toEqual(['my-quoted-skill']);

      // Calling with unquoted name works
      const result = await tool.handler({ name: 'my-quoted-skill' });
      expect(result.exitCode).toBe(0);
      expect(result.content).toContain('# Quoted');
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
