#!/usr/bin/env node

// Register tsx loader so TypeScript files can be imported directly.
// This avoids the child-process wrapper which caused stdin instability
// on some platforms (notably Git Bash on Windows).
import 'tsx';
await import('./my-agent.ts');
