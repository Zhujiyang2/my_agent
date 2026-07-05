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
