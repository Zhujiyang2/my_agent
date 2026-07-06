#!/usr/bin/env node

// My Agent CLI - terminal AI assistant
// Usage: npm start  or  node --import tsx bin/my-agent.ts

// Bootstrap proxy support (via global-agent) — set GLOBAL_AGENT_HTTP_PROXY env var to activate
import 'global-agent/bootstrap';

import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../src/config/loader';
import { createAgent } from '../src/agent/loop';
import {
  formatWelcome,
  formatError,
  formatInfo,
  formatToolCall,
} from '../src/cli/chat';
import { createCommandRegistry } from '../src/cli/commands/index.js';
import { dispatch } from '../src/cli/commands/dispatcher.js';

// Load tools — side-effect imports trigger registration into defaultRegistry
import '../src/tools/shell/index.js';
import '../src/tools/files/index.js';
import '../src/tools/subagent/index.js';
import { loadSkills } from '../src/skills/skill-tool.js';
import { setExecutorCallbacks } from '../src/tools/executor.js';
import { promptConfirm } from '../src/cli/chat.js';
import { SubagentManager, setSubagentManager } from '../src/agent/subagent/manager.js';
import { loadMcpConfig } from '../src/mcp/config.js';
import { MCPManager, setMCPManager } from '../src/mcp/manager.js';
import { createSandboxManager, setSandboxManager } from '../src/sandbox/sandbox-manager.js';
import { loadSandboxDomains } from '../src/sandbox/net-domains.js';
import { createRegisterWritableTool } from '../src/tools/sandbox/index.js';
import { defaultRegistry } from '../src/tools/registry.js';

const nodeVersion = process.versions.node.split('.').map(Number);
if (nodeVersion[0] < 18) {
  console.error(formatError(`  Error: Node.js >= 18 required (current: ${process.version})`));
  process.exit(1);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(formatError(`  Config load failed: ${msg}`));
    process.exit(1);
  }

  console.log(formatWelcome());
  console.log(formatInfo(`  Model: ${config.model}`));
  console.log(formatInfo(`  API: ${config.api_url}`));
  console.log(formatInfo('  /exit to quit | Ctrl+C to interrupt'));
  console.log('');

  // Inject default system prompt if not configured
  if (!config.context.systemPrompt) {
    config.context.systemPrompt =
      'You are My Agent, an AI-powered coding assistant running in the terminal. ' +
      'You have access to tools for reading/writing files, running shell commands, ' +
      'spawning subagents, and more. Use your tools to help the user accomplish their tasks.';
  }

  const agent = createAgent(config, {
    onToken: (token) => process.stdout.write(token),
    onToolCall: (name, args) => {
      console.log(formatToolCall(name, args));
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36m> \x1b[0m',
  });

  rl.prompt();

  const commandRegistry = createCommandRegistry();

  let currentController: AbortController | null = null;
  let confirming = false;

  // Safely read a single confirmation line — bypasses readline 'line' events
  function readConfirmation(): Promise<boolean> {
    return new Promise((resolve) => {
      confirming = true;
      rl.question('> ', (answer) => {
        confirming = false;
        resolve(answer.trim().toLowerCase().startsWith('y'));
      });
    });
  }

  // Initialize subagent manager
  const subagentManager = new SubagentManager(config);
  setSubagentManager(subagentManager);

  // Initialize MCP manager — loads ~/.my_agent/mcp.json, registers management tools
  const mcpConfig = loadMcpConfig();
  const mcpManager = new MCPManager();
  mcpManager.initialize(mcpConfig);
  setMCPManager(mcpManager);

  // Initialize sandbox manager with domain config
  const domainsConfig = loadSandboxDomains();
  const sandboxMgr = createSandboxManager({
    ...config.sandbox,
    domains: {
      extra_allowed_domains: domainsConfig.extra_allowed_domains,
      blocked_domains: domainsConfig.blocked_domains,
    },
  });
  setSandboxManager(sandboxMgr);

  // Register sandbox tools
  defaultRegistry.register(createRegisterWritableTool());

  // Report sandbox status
  const sandboxStatus = sandboxMgr.getStatus();
  if (sandboxStatus.enabled) {
    const parts: string[] = [];
    if (sandboxStatus.bwrapAvailable) {
      parts.push('bwrap ✓');
    } else {
      parts.push('bwrap ✗ (fallback)');
    }
    if (sandboxStatus.socatAvailable) {
      parts.push('socat ✓');
    } else {
      parts.push('socat ✗ (no network isolation)');
    }
    console.log(formatInfo(`  Sandbox: ${parts.join(', ')}`));
  }

  // Load skills from project directory
  loadSkills(path.join(process.cwd(), '.my-agent', 'skills'));

  // Set up safety confirmation — must be after rl creation
  setExecutorCallbacks({
    onConfirm: async (command: string, category: string) => {
      process.stdout.write(promptConfirm(command, category) + '\n');
      return readConfirmation();
    },
  });

  rl.on('SIGINT', () => {
    if (currentController) {
      currentController.abort();
      currentController = null;
      console.log(formatInfo('\n  Interrupted'));
    }
    rl.prompt();
  });

  rl.on('line', async (line: string) => {
    if (confirming) return;

    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Build command context (shared for all commands)
    const cmdCtx = {
      agent,
      contextManager: agent.contextManager,
      config,
      output: {
        info: (text: string) => console.log(formatInfo(`  ${text}`)),
        error: (text: string) => console.log(formatError(`  ${text}`)),
      },
      ui: {
        prompt: (text: string) =>
          new Promise<string>((resolve) => {
            rl.question(text, resolve);
          }),
        write: (text: string) => {
          rl.write(text);
        },
      },
    };

    const result = await dispatch(input, commandRegistry, cmdCtx);

    if (result.action === 'exit') {
      console.log(formatInfo('  Goodbye!\n'));
      rl.close();
      return;
    }

    if (result.action === 'continue') {
      rl.prompt();
      return;
    }

    // action === 'send_to_agent'
    currentController = new AbortController();

    try {
      await agent.send(result.input, currentController.signal);
      console.log('\n');
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // interrupted by Ctrl+C — no extra message needed
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(formatError(`  Error: ${msg}`));
      }
    } finally {
      currentController = null;
    }

    rl.prompt();
  });

  rl.on('close', () => {
    subagentManager.destroy();
    mcpManager.destroy().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(formatError(`  Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
