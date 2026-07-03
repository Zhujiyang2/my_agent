#!/usr/bin/env node

// My Agent CLI - terminal AI assistant
// Usage: npm start  or  node --import tsx bin/my-agent.ts

import readline from 'node:readline';
import { loadConfig } from '../src/config/loader';
import { createAgent } from '../src/agent/loop';
import {
  isExitCommand,
  formatWelcome,
  formatError,
  formatInfo,
} from '../src/cli/chat';

// Load tools — side-effect imports trigger registration into defaultRegistry
import '../src/tools/shell/index.js';
import '../src/tools/files/index.js';
import { setExecutorCallbacks } from '../src/tools/executor.js';
import { promptConfirm } from '../src/cli/chat.js';

// Set up safety confirmation for high-risk commands
setExecutorCallbacks({
  onConfirm: async (command: string, category: string) => {
    process.stdout.write(promptConfirm(command, category) + '\n');
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('> ', (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase().startsWith('y'));
      });
    });
  },
});

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
  console.log(formatInfo(`  Safety: ${config.tools.safety_mode === 'confirm' ? 'high-risk confirmation ON' : 'auto-approve all'}`));
  console.log(formatInfo('  /exit to quit | Ctrl+C to interrupt | Ctrl+C twice to exit'));
  console.log('');

  const agent = createAgent(config, {
    onToken: (token) => process.stdout.write(token),
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36m> \x1b[0m',
  });

  rl.prompt();

  let currentController: AbortController | null = null;

  rl.on('SIGINT', () => {
    if (currentController) {
      currentController.abort();
      currentController = null;
      console.log(formatInfo('\n  Interrupted'));
      rl.prompt();
    } else {
      console.log(formatInfo('\n  Goodbye!'));
      process.exit(0);
    }
  });

  rl.on('line', async (line: string) => {
    if (isExitCommand(line)) {
      console.log(formatInfo('  Goodbye!\n'));
      rl.close();
      return;
    }

    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    currentController = new AbortController();

    try {
      await agent.send(input, currentController.signal);
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
    process.exit(0);
  });
}

main();
