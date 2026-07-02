#!/usr/bin/env node

// Wrapper: npm bin creates a `node <this-file>` command, but our real
// entry is TypeScript. Re-launch with tsx to load the TS file.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsFile = path.join(__dirname, 'my-agent.ts');

const child = spawn(process.execPath, ['--import', 'tsx', tsFile], {
  stdio: 'inherit',
});

child.on('exit', (code) => { process.exit(code ?? 0); });
