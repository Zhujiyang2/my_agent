# Skill System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Skill tool that scans `.my-agent/skills/*.md`, registers skill names as an enum parameter, and loads skill content on demand via LLM tool call.

**Architecture:** One new file `src/skills/skill-tool.ts` containing scan + parse + tool creation logic. One line added to `bin/my-agent.ts` to trigger skill loading at startup. No new dependencies or singletons — skills are loaded once, the resulting ToolDefinition is registered into `defaultRegistry`, and skill content enters the Flow layer as a tool result (exiting naturally via compaction).

**Tech Stack:** TypeScript, Node.js fs/path, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/skills/skill-tool.ts` (create) | Scan `.my-agent/skills/`, parse frontmatter, create and register Skill tool |
| `src/skills/__tests__/skill-tool.test.ts` (create) | Unit tests for scanning, parsing, tool creation, handler behavior |
| `bin/my-agent.ts` (modify) | Add one import + one function call to load skills at startup |

---

### Task 1: Write skill-tool.ts — scanning and frontmatter parsing

**Files:**
- Create: `src/skills/skill-tool.ts`

- [ ] **Step 1: Create the file with scanSkills and parseFrontmatter functions**

```typescript
// src/skills/skill-tool.ts
import fs from 'node:fs';
import path from 'node:path';
import { defaultRegistry } from '../tools/registry';
import type { ToolDefinition } from '../tools/types';

interface SkillMeta {
  name: string;
  description: string;
  filePath: string;
}

function parseFrontmatter(filePath: string): SkillMeta | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const fm = match[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);

    if (!nameMatch || !descMatch) return null;

    const name = nameMatch[1].trim();
    let desc = descMatch[1].trim();
    // Strip surrounding quotes if present
    if (
      (desc.startsWith('"') && desc.endsWith('"')) ||
      (desc.startsWith("'") && desc.endsWith("'"))
    ) {
      desc = desc.slice(1, -1);
    }

    return { name, description: desc, filePath };
  } catch {
    return null;
  }
}

function scanSkills(skillsDir: string): Map<string, SkillMeta> {
  const skills = new Map<string, SkillMeta>();

  if (!fs.existsSync(skillsDir)) return skills;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(skillsDir);
  } catch {
    return skills;
  }
  if (!stat.isDirectory()) return skills;

  let files: string[];
  try {
    files = fs.readdirSync(skillsDir);
  } catch {
    return skills;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;

    const filePath = path.join(skillsDir, file);
    const skill = parseFrontmatter(filePath);

    if (!skill) {
      console.warn(`[skills] Skipping ${file}: invalid or missing frontmatter (name + description required)`);
      continue;
    }

    if (skills.has(skill.name)) {
      console.warn(`[skills] Duplicate skill name "${skill.name}" — overriding with ${file}`);
    }

    skills.set(skill.name, skill);
  }

  return skills;
}
```

- [ ] **Step 2: Add createSkillTool and loadSkills functions**

Append to `src/skills/skill-tool.ts`:

```typescript
function createSkillTool(skills: Map<string, SkillMeta>): ToolDefinition {
  const names = Array.from(skills.keys());

  const skillDescriptions = names
    .map((n) => `${n} - ${skills.get(n)!.description}`)
    .join('\n');

  const description =
    `调用一个技能获取特定领域的指导和规范。可用技能:\n${skillDescriptions}`;

  return {
    name: 'Skill',
    description,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: names,
          description: '要激活的技能名称',
        },
      },
      required: ['name'],
    },
    handler: async (params: Record<string, unknown>) => {
      const name = String(params.name ?? '');
      const skill = skills.get(name);

      if (!skill) {
        return {
          content: `未知技能: "${name}"。可用技能: ${names.join(', ')}`,
          summary: `Skill 调用失败: "${name}" 不存在`,
          exitCode: 1,
          isError: true,
        };
      }

      try {
        const content = fs.readFileSync(skill.filePath, 'utf-8');
        return {
          content,
          summary: `已激活技能: ${skill.name}`,
          exitCode: 0,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: `读取技能文件失败: ${msg}`,
          summary: `Skill 调用失败: 无法读取 ${skill.name}`,
          exitCode: 1,
          isError: true,
        };
      }
    },
  };
}

export function loadSkills(skillsDir: string): void {
  const skills = scanSkills(skillsDir);

  if (skills.size === 0) return;

  const tool = createSkillTool(skills);
  defaultRegistry.register(tool);
}
```

- [ ] **Step 3: Verify the file compiles**

Run: `npx tsc --noEmit src/skills/skill-tool.ts`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/skills/skill-tool.ts
git commit -m "feat: add skill scanning and tool creation"
```

---

### Task 2: Write skill-tool.test.ts — unit tests

**Files:**
- Create: `src/skills/__tests__/skill-tool.test.ts`

- [ ] **Step 1: Write tests for parseFrontmatter and scanSkills**

```typescript
// src/skills/__tests__/skill-tool.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// We import internal functions via a test-only re-export pattern.
// For now, test through the public loadSkills API and assert on the
// registered tool's shape and handler behavior.
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
```

- [ ] **Step 2: Write tests for the handler**

Append to the test file:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail (TDD red phase)**

Run: `npx vitest run src/skills/__tests__/skill-tool.test.ts`
Expected: Tests fail because `src/skills/skill-tool.ts` doesn't exist yet, OR tests fail on import

- [ ] **Step 4: Run tests to verify they pass (TDD green phase)**

Run: `npx vitest run src/skills/__tests__/skill-tool.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/skills/__tests__/skill-tool.test.ts
git commit -m "test: add skill-tool unit tests"
```

---

### Task 3: Wire into bin/my-agent.ts

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Add skill import and loadSkills call**

In `bin/my-agent.ts`, add the import line after the existing tool imports (after line 23):

```typescript
import '../src/tools/subagent/index.js';
import { loadSkills } from '../src/skills/skill-tool.js';  // <-- add this line
import { setExecutorCallbacks } from '../src/tools/executor.js';
```

Then add the `loadSkills()` call after the MCP manager initialization (after line 89):

```typescript
  // Initialize MCP manager — loads ~/.my_agent/mcp.json, registers management tools
  const mcpConfig = loadMcpConfig();
  const mcpManager = new MCPManager();
  mcpManager.initialize(mcpConfig);
  setMCPManager(mcpManager);

  // Load skills from project directory
  loadSkills(path.join(process.cwd(), '.my-agent', 'skills'));  // <-- add this line
```

Note: `path` needs to be imported — it's already available as a Node built-in, add `import path from 'node:path';` to the imports if not already present.

- [ ] **Step 2: Verify the entire test suite still passes**

Run: `npx vitest run`
Expected: All tests pass (existing + new skill tests)

- [ ] **Step 3: Verify startup with no skills directory (should not error)**

Run: `node --import tsx bin/my-agent.ts` (and type `/exit`)
Expected: No errors about skills, agent starts normally

- [ ] **Step 4: Commit**

```bash
git add bin/my-agent.ts
git commit -m "feat: wire skill loading into CLI entry point"
```

---

### Task 4: Manual smoke test

- [ ] **Step 1: Create a test skill file**

```bash
mkdir -p .my-agent/skills
```

Create `.my-agent/skills/test.md`:

```markdown
---
name: test
description: 测试用技能，回答时在末尾加上 🎉
---

# Test Skill

You are now in test mode. Append 🎉 to every response.
```

- [ ] **Step 2: Start the agent and verify skill is discoverable**

Run: `node --import tsx bin/my-agent.ts`
Expected: Agent starts normally (no skill info in welcome message)

- [ ] **Step 3: Ask the LLM to use the skill**

Input: `请使用 Skill 工具调用 test 技能，然后说你好`
Expected: LLM calls Skill({ name: "test" }), gets the content, then says "你好🎉"

- [ ] **Step 4: Clean up test skill**

```bash
rm -rf .my-agent/skills
```
