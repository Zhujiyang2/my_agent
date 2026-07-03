#!/usr/bin/env node

// Wrapper: npm bin creates a `node <this-file>` command, but our real
// entry is TypeScript. Re-launch with tsx (resolved from project node_modules)
// to load the TS file.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const tsFile = path.join(__dirname, 'my-agent.ts');

// Resolve tsx from local project node_modules, fallback to global
const tsxLocal = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
const tsxImport = existsSync(tsxLocal) ? pathToFileURL(tsxLocal).href : 'tsx';

const child = spawn(process.execPath, ['--import', tsxImport, tsFile], {
  stdio: 'inherit',
  env: { ...process.env, NODE_PATH: path.join(projectRoot, 'node_modules') },
});

child.on('exit', (code) => { process.exit(code ?? 0); });
