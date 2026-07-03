// src/tools/path-utils.ts

/**
 * Normalize a file path for the current platform.
 * On Windows, converts Unix-style drive-letter paths (/d/foo) to Windows paths (D:\foo).
 */
export function normalizePath(filePath: string): string {
  if (process.platform !== 'win32') return filePath;

  // Match /<drive-letter>/rest/of/path
  const match = filePath.match(/^\/([a-zA-Z])\//);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = filePath.slice(3).replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }

  return filePath;
}
