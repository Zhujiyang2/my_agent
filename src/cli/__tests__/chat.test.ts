import { describe, it, expect } from 'vitest';
import {
  isExitCommand,
  formatWelcome,
  formatUserMessage,
  formatAssistantMessage,
  promptConfirm,
  WELCOME_ART,
} from '../chat';

describe('isExitCommand', () => {
  it('returns true for /exit', () => {
    expect(isExitCommand('/exit')).toBe(true);
  });

  it('returns true for /quit', () => {
    expect(isExitCommand('/quit')).toBe(true);
  });

  it('returns true for /q', () => {
    expect(isExitCommand('/q')).toBe(true);
  });

  it('returns false for normal text', () => {
    expect(isExitCommand('hello')).toBe(false);
  });

  it('trims whitespace', () => {
    expect(isExitCommand('  /exit  ')).toBe(true);
  });
});

describe('WELCOME_ART', () => {
  it('contains the symmetrical robot', () => {
    expect(WELCOME_ART).toContain('┌──');
    expect(WELCOME_ART).toContain('●');
    expect(WELCOME_ART).toContain('└──');
  });
});

describe('formatWelcome', () => {
  it('returns the welcome message with art', () => {
    const result = formatWelcome();
    expect(result).toContain('My Agent');
    expect(result).toContain('┌──');
    expect(result).toContain('AI-powered coding assistant');
  });
});

describe('formatUserMessage', () => {
  it('formats user message with a prompt arrow', () => {
    const result = formatUserMessage('hello');
    expect(result).toContain('>');
    expect(result).toContain('hello');
  });
});

describe('formatAssistantMessage', () => {
  it('formats assistant message', () => {
    const result = formatAssistantMessage('hi there');
    expect(result).toContain('hi there');
  });
});

describe('promptConfirm', () => {
  it('formats the confirmation prompt correctly', () => {
    const result = promptConfirm('rm -rf /data', 'file_destruction');
    expect(result).toContain('rm -rf /data');
    expect(result).toContain('high risk');
    expect(result).toContain('[y]');
    expect(result).toContain('[n]');
  });
});
