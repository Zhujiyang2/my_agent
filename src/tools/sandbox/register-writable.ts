// src/tools/sandbox/register-writable.ts
import type { ToolDefinition } from '../../tools/types';
import { getSandboxManager } from '../../sandbox/sandbox-manager';

export function createRegisterWritableTool(): ToolDefinition {
  return {
    name: 'register_writable_path',
    description:
      'Register a workspace directory as writable in the sandbox. ' +
      'After registration, the path and all sub-paths become readable and writable, ' +
      'and docker -v mounts to this path are allowed. ' +
      'Use this after discovering available storage via df -h / ls to declare your working area. ' +
      'The directory will be created on the host if it does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path on the host to register as writable workspace. ' +
            'Must not be under /etc, /boot, /sys, /proc or any protected credential path.',
        },
      },
      required: ['path'],
    },
    handler: async (params: Record<string, unknown>) => {
      const filePath = typeof params.path === 'string' ? params.path.trim() : '';

      if (!filePath) {
        return {
          content: 'Error: "path" parameter is required and must be a non-empty string.',
          summary: 'register_writable_path failed: missing path',
          exitCode: 1,
          isError: true,
        };
      }

      if (!filePath.startsWith('/')) {
        return {
          content: `Error: "${filePath}" is not an absolute path. Please provide an absolute path starting with /.`,
          summary: 'register_writable_path failed: not absolute path',
          exitCode: 1,
          isError: true,
        };
      }

      const mgr = getSandboxManager();
      if (!mgr) {
        return {
          content: 'Error: Sandbox manager is not initialized. Is the sandbox enabled?',
          summary: 'register_writable_path failed: no sandbox manager',
          exitCode: 1,
          isError: true,
        };
      }

      const result = mgr.registerWritable(filePath);

      if (!result.ok) {
        return {
          content: `Error: ${result.error}`,
          summary: `register_writable_path failed: ${result.error}`,
          exitCode: 1,
          isError: true,
        };
      }

      return {
        content:
          `Path "${filePath}" registered as writable workspace.\n` +
          `- File system: read/write access granted\n` +
          `- Docker -v mounts to this path: allowed\n` +
          `- Current writable paths: ${mgr.getStatus().writablePaths.join(', ') || '(none)'}`,
        summary: `writable registered: ${filePath}`,
        exitCode: 0,
      };
    },
  };
}
