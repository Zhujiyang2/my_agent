// src/skills/skill-tool.ts
import fs from 'node:fs';
import path from 'node:path';
import { defaultRegistry } from '../tools/registry';
import type { ToolDefinition, ToolRegistry } from '../tools/registry';

const MAX_DESCRIPTION_LENGTH = 3000;

interface SkillMeta {
  name: string;
  description: string;
  filePath: string;
  content: string; // cached to avoid double-read
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(filePath: string): SkillMeta | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const fm = match[1];
    // Use [^\S\r\n] instead of \s to avoid matching newlines
    const nameMatch = fm.match(/^name:[^\S\r\n]*(.+)$/m);
    const descMatch = fm.match(/^description:[^\S\r\n]*(.+)$/m);

    if (!nameMatch || !descMatch) return null;

    const name = stripQuotes(nameMatch[1].trim());
    if (name.length === 0) return null;

    const desc = stripQuotes(descMatch[1].trim());

    return { name, description: desc, filePath, content };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] I/O error reading ${filePath}: ${msg}`);
    return null;
  }
}

function scanSkills(skillsDir: string): Map<string, SkillMeta> {
  const skills = new Map<string, SkillMeta>();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(skillsDir);
  } catch {
    return skills; // directory doesn't exist or inaccessible
  }
  if (!stat.isDirectory()) return skills;

  let files: string[];
  try {
    files = fs.readdirSync(skillsDir);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] Cannot read directory ${skillsDir}: ${msg}`);
    return skills;
  }

  // Sort for deterministic ordering across platforms
  files.sort();

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue;

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

function createSkillTool(skills: Map<string, SkillMeta>): ToolDefinition {
  // Use entries() to avoid double Map lookup
  const entries = Array.from(skills.entries());

  let skillDescriptions = entries
    .map(([n, s]) => `${n} - ${s.description}`)
    .join('\n');

  // Truncate if too long to avoid exceeding LLM API tool description limits
  if (skillDescriptions.length > MAX_DESCRIPTION_LENGTH) {
    skillDescriptions = skillDescriptions.slice(0, MAX_DESCRIPTION_LENGTH - 30)
      + '\n... (truncated, too many skills)';
  }

  const description =
    `BEFORE responding to ANY user message: scan the user's intent against the available skills below. If ANY skill matches — even 1% — call this tool FIRST to load its instructions. Skill instructions OVERRIDE your default behavior. Do NOT skip skill loading just because the request seems simple.\n\n可用技能:\n${skillDescriptions}`;

  const names = entries.map(([n]) => n);

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

      // Content is cached from scan time — no disk I/O needed
      return {
        content: `以下是用 "${skill.name}" 技能的指令 —— 你必须严格遵守这些规则来回答用户:\n\n${skill.content}`,
        summary: `已激活技能: ${skill.name}`,
        exitCode: 0,
      };
    },
  };
}

export function loadSkills(skillsDir: string, registry?: ToolRegistry): void {
  const skills = scanSkills(skillsDir);

  if (skills.size === 0) return;

  const target = registry ?? defaultRegistry;

  // Guard against duplicate registration
  if (target.get('Skill')) return;

  const tool = createSkillTool(skills);
  target.register(tool);
}
