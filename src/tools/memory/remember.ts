// src/tools/memory/remember.ts
import type { ToolDefinition } from '../../tools/types';
import type { MemoryManager } from '../../memory/index';

export function createRememberTool(mm: MemoryManager): ToolDefinition {
  return {
    name: 'remember',
    description:
      '保存一条长期记忆。Agent 应该在有价值的信息出现时主动调用，' +
      '如用户说明编码偏好、工作原则、项目约定等。' +
      'IP地址和凭证信息会自动加密存储，使用时解密。但请避免存储姓名、手机号、邮箱、工号等个人身份信息（PII），这些会被永久脱敏。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'kebab-case 唯一标识，如 "prefer-react"',
        },
        description: {
          type: 'string',
          description: '单行摘要',
        },
        content: {
          type: 'string',
          description: 'markdown 正文，建议包含 **Why** 和 **How to apply**',
        },
        type: {
          type: 'string',
          enum: ['user', 'agent'],
          description: '记忆类型：user=用户偏好/原则，agent=Agent 学到的经验',
        },
      },
      required: ['name', 'description', 'content', 'type'],
    },
    handler: async (params: Record<string, unknown>) => {
      const name = String(params.name ?? '');
      const description = String(params.description ?? '');
      const content = String(params.content ?? '');
      const type = String(params.type ?? '');

      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
        return {
          content: `Invalid memory name: "${name}". Must be kebab-case (lowercase letters, digits, hyphens only, starting with a letter).`,
          summary: `remember failed: invalid name "${name}"`,
          exitCode: 1,
          isError: true,
        };
      }

      if (type !== 'user' && type !== 'agent') {
        return {
          content: `Invalid type: "${type}". Must be "user" or "agent".`,
          summary: `remember failed: invalid type "${type}"`,
          exitCode: 1,
          isError: true,
        };
      }

      try {
        const { warnings } = await mm.remember({ name, description, content, type: type as 'user' | 'agent' });

        if (warnings.length > 0) {
          return {
            content: `Memory "${name}" saved with encoding warnings:\n${warnings.join('\n')}\n\nSensitive values (IPs, credentials) are reversibly encoded on disk. PII (names, phones, emails) is redacted.`,
            summary: `remembered ${name} (encoded)`,
            exitCode: 0,
          };
        }

        return {
          content: `Memory "${name}" saved successfully.`,
          summary: `remembered ${name}`,
          exitCode: 0,
        };
      } catch (e) {
        return {
          content: `Error saving memory: ${e instanceof Error ? e.message : String(e)}`,
          summary: `remember failed: ${e instanceof Error ? e.message : String(e)}`,
          exitCode: 1,
          isError: true,
        };
      }
    },
  };
}
