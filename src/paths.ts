// src/paths.ts
import path from 'node:path';
import fs from 'node:fs';

/**
 * Find the project root directory by walking up from cwd
 * until we find a package.json file.
 */
export function findProjectRoot(): string {
  let current = process.cwd();

  for (let i = 0; i < 20; i++) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding package.json
      break;
    }
    current = parent;
  }

  // Fallback to cwd if package.json not found
  return process.cwd();
}

/**
 * Resolve a path relative to the project root.
 * Example: resolveProjectPath('.my_agent', 'config.json') → <root>/.my_agent/config.json
 */
export function resolveProjectPath(...segments: string[]): string {
  return path.join(findProjectRoot(), ...segments);
}
