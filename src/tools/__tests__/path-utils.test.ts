// src/tools/__tests__/path-utils.test.ts
import { describe, it, expect } from 'vitest';
import { normalizePath } from '../path-utils';

describe('normalizePath', () => {
  it('converts /d/path to D:\\path on Windows', () => {
    const result = normalizePath('/d/code/test/hello.py');
    if (process.platform === 'win32') {
      expect(result).toBe('D:\\code\\test\\hello.py');
    } else {
      expect(result).toBe('/d/code/test/hello.py');
    }
  });

  it('converts /c/Users to C:\\Users on Windows', () => {
    const result = normalizePath('/c/Users/test.txt');
    if (process.platform === 'win32') {
      expect(result).toBe('C:\\Users\\test.txt');
    } else {
      expect(result).toBe('/c/Users/test.txt');
    }
  });

  it('leaves relative paths unchanged on all platforms', () => {
    expect(normalizePath('foo/bar.txt')).toBe('foo/bar.txt');
    expect(normalizePath('./test.txt')).toBe('./test.txt');
  });

  it('leaves non-drive-letter paths unchanged', () => {
    const result = normalizePath('/tmp/test.txt');
    // /tmp does not start with single letter + /, so it's unchanged
    expect(result).toBe('/tmp/test.txt');
  });

  it('leaves empty string unchanged', () => {
    expect(normalizePath('')).toBe('');
  });
});
