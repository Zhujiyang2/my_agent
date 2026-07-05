// src/skills/__tests__/skill-tool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultRegistry } from '../../tools/registry';
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
    // Remove the Skill tool if it was registered
    try {
      defaultRegistry.remove('Skill');
    } catch {
      // ignore
    }
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
      // File with no frontmatter
      fs.writeFileSync(path.join(dir, 'no-fm.md'), '# No frontmatter\n\nJust content.', 'utf-8');
      // File missing description
      fs.writeFileSync(
        path.join(dir, 'no-desc.md'),
        '---\nname: incomplete\n---\n\nBody.',
        'utf-8',
      );
      // Valid file
      writeSkillFile(dir, 'valid.md', 'valid', 'A valid skill');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.properties.name.enum).toEqual(['valid']);
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
      // enum should have one entry (no duplicates)
      expect(tool!.parameters.properties.name.enum).toEqual(['dup']);
      // description should be from the second file
      expect(tool!.description).toContain('Second version');
      expect(tool!.description).not.toContain('First version');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips surrounding quotes from description', () => {
    const dir = createTempDir();
    try {
      writeSkillFile(dir, 'quoted.md', 'quoted', '"A quoted description"');

      loadSkills(dir);

      const tool = defaultRegistry.get('Skill');
      expect(tool).toBeDefined();
      expect(tool!.description).toContain('quoted - A quoted description');
      expect(tool!.description).not.toContain('"');
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
    try {
      defaultRegistry.remove('Skill');
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns skill file content on success', async () => {
    const tool = defaultRegistry.get('Skill')!;
    const result = await tool.handler({ name: 'test-skill' });

    expect(result.exitCode).toBe(0);
    expect(result.content).toContain('# Test');
    expect(result.content).toContain('Do X then Y.');
    expect(result.content).toContain('---');
    expect(result.summary).toBe('已激活技能: test-skill');
  });

  it('returns error for unknown skill name', async () => {
    const tool = defaultRegistry.get('Skill')!;
    const result = await tool.handler({ name: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.content).toContain('未知技能');
    expect(result.content).toContain('test-skill'); // lists available skills
  });

  it('returns error when file was deleted after scan', async () => {
    const tool = defaultRegistry.get('Skill')!;
    // Delete the file but keep the registered tool
    fs.rmSync(dir, { recursive: true, force: true });

    const result = await tool.handler({ name: 'test-skill' });
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.content).toContain('读取技能文件失败');
  });
});
