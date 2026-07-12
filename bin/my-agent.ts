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
import { createTaskRegistry, setTaskRegistry } from '../src/tasks/registry.js';
import { createStatusLine } from '../src/agent/status-line.js';
import { createFooter } from '../src/cli/footer.js';
import { createInputLine } from '../src/cli/input-line.js';
import { resolveProjectPath } from '../src/paths.js';

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

  // Print welcome — tight spacing, no trailing blank line
  console.log(formatWelcome());
  console.log(formatInfo(`  Model: ${config.model}`));
  console.log(formatInfo(`  API: ${config.api_url}`));

  // Inject default system prompt if not configured
  if (!config.context.systemPrompt) {
    config.context.systemPrompt =
      '你是昇腾资深FAE，擅长算子开发、模型训练推理适配、部署、评测、问题定位和调优。' +
      '对话自然友好，非昇腾问题正常交流，不强行套昇腾。' +
      '收到用户消息时，优先检查 Skill 工具列表是否有匹配的技能——Skill 是你的专业能力，不要跳过。' +
      '你也有 MCP 工具可用，是否调用由你根据任务需要自行判断，不要为了调用而调用。';
  }

  const agent = createAgent(config, {
    onToken: (token) => process.stdout.write(token),
    onToolCall: (name, args) => {
      console.log(formatToolCall(name, args));
    },
  });

  // readline — used ONLY for:
  //  1. SIGINT / close events
  //  2. rl.question() for confirmation dialogs
  // terminal: false prevents readline from touching TTY state —
  // we manage raw mode and keypress events ourselves via InputLine.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Enable raw mode + keypress events for InputLine
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const commandRegistry = createCommandRegistry();

  let currentController: AbortController | null = null;

  // Initialize subagent manager
  const subagentManager = new SubagentManager(config);
  setSubagentManager(subagentManager);

  // Initialize MCP manager — loads .my_agent/mcp.json, registers management tools
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

  // Initialize TaskRegistry with persistent state
  const taskRegistry = createTaskRegistry(resolveProjectPath('.my_agent', 'tasks'));
  setTaskRegistry(taskRegistry);
  await taskRegistry.restore();
  await taskRegistry.recover();

  // Register sandbox tools
  defaultRegistry.register(createRegisterWritableTool());

  // Load skills from project directory
  loadSkills(path.join(process.cwd(), 'skills'));

  // Initialize footer for job completion messages + frame rendering
  const footer = createFooter();
  taskRegistry.onTaskComplete((task) => {
    const icon = task.status === 'completed' ? '✓' : '✗';
    const elapsed = ((task.finishedAt! - task.createdAt) / 1000).toFixed(1);
    const cmd = task.command.length > 60
      ? task.command.slice(0, 57) + '...'
      : task.command;
    footer.upsert({
      id: task.id,
      icon,
      text: `${cmd}: ${task.status} (${elapsed}s)`,
    });
  });

  // InputLine: self-managed frame + cursor. readline only provides keypress events.
  const inputLine = createInputLine({
    footer,
    onWrite: (text: string) => process.stdout.write(text),
  });

  // Render initial frame at the bottom of the welcome output
  inputLine.renderFrame();

  // Set up safety confirmation — temporarily leave raw mode for rl.question()
  setExecutorCallbacks({
    onConfirm: async (command: string, category: string) => {
      process.stdout.write(promptConfirm(command, category) + '\n');
      // Exit raw mode so rl.question() gets 'line' events
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      const answer = await new Promise<string>((resolve) => {
        rl.question('> ', resolve);
      });
      // Back to raw mode for InputLine
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      return answer.trim().toLowerCase().startsWith('y');
    },
  });

  // Start task status-line (stderr to avoid mixing with LLM output on stdout)
  const statusLine = createStatusLine({ intervalMs: 3000 });
  statusLine.start();

  // Main submit handler — called when user presses Enter
  async function handleSubmit(): Promise<void> {
    const rawInput = inputLine.submit();
    const input = rawInput.trim();
    if (!input) {
      inputLine.renderFrame();
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
        prompt: async (text: string) => {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          const answer = await new Promise<string>((resolve) => {
            rl.question(text, resolve);
          });
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          return answer;
        },
        write: (text: string) => {
          process.stdout.write(text);
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
      inputLine.renderFrame();
      return;
    }

    // action === 'send_to_agent'
    currentController = new AbortController();

    // Pause status-line during LLM output to avoid stderr/stdout cursor interference
    statusLine.pause();

    try {
      await agent.send(result.input, currentController.signal);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // interrupted by Ctrl+C — no extra message needed
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        // User-friendly error display
        if (msg.includes('fetch failed') || msg.includes('Network error') || msg.includes('ECONNREFUSED')) {
          console.log(formatError('  Connection lost — the API server is unreachable. Check your network and try again.'));
        } else if (msg.includes('timeout') || msg.includes('timed out')) {
          console.log(formatError('  Request timed out — the server is taking too long to respond.'));
        } else {
          console.log(formatError(`  Error: ${msg}`));
        }
      }
    } finally {
      currentController = null;
    }

    // After LLM output, cursor may be mid-line. Ensure frame starts cleanly.
    process.stdout.write('\n');
    inputLine.renderFrame();

    // Resume status-line refreshes
    statusLine.resume();
  }

  // Unified keypress handler: dispatch by key
  process.stdin.on('keypress', (_ch, key) => {
    if (!key) return;

    // Ctrl+O: toggle task status-line expand/collapse.
    // Status-line writes to stderr, which can move the shared terminal cursor.
    // Re-render the frame afterwards to restore correct cursor position.
    if (key.ctrl && !key.meta && key.name === 'o') {
      statusLine.toggle();
      inputLine.renderFrame();
      return;
    }

    // Ctrl+C: abort current LLM call
    if (key.ctrl && key.name === 'c') {
      if (currentController) {
        currentController.abort();
        currentController = null;
        console.log(formatInfo('\n  Interrupted'));
      }
      inputLine.reset();
      statusLine.resume();
      return;
    }

    // Enter: submit input
    if (key.name === 'return' || key.name === 'enter') {
      handleSubmit();
      return;
    }

    // All other keys → InputLine for editing
    inputLine.onKeypress(
      _ch || '',
      { name: key.name || '', ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift },
    );
  });

  // SIGINT from OS (Ctrl+C in raw mode arrives via keypress above; this is fallback)
  rl.on('SIGINT', () => {
    if (currentController) {
      currentController.abort();
      currentController = null;
      console.log(formatInfo('\n  Interrupted'));
    }
    inputLine.reset();
    statusLine.resume();
  });

  rl.on('close', () => {
    statusLine.stop();
    taskRegistry.destroy();
    subagentManager.destroy();
    mcpManager.destroy().catch(() => {});
    sandboxMgr.destroy().catch(() => {});
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(formatError(`  Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
