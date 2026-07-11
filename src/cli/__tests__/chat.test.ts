import { describe, it, expect } from 'vitest';
import {
  formatWelcome,
  formatUserMessage,
  formatAssistantMessage,
  formatToolCall,
  promptConfirm,
  formatEchoedInput,
  WELCOME_ART,
} from '../chat';

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

describe('formatToolCall', () => {
  it('shows tool name and key arguments', () => {
    const result = formatToolCall('write_file', { path: '/tmp/test.py', content: 'print(1)' });
    expect(result).toContain('write_file');
    expect(result).toContain('/tmp/test.py');
  });

  it('shows run_command with the command', () => {
    const result = formatToolCall('run_command', { command: 'python test.py' });
    expect(result).toContain('run_command');
    expect(result).toContain('python test.py');
  });

  it('shows glob with pattern', () => {
    const result = formatToolCall('glob', { pattern: '*.py' });
    expect(result).toContain('glob');
    expect(result).toContain('*.py');
  });

  it('handles empty args gracefully', () => {
    const result = formatToolCall('echo', {});
    expect(result).toContain('echo');
  });
});

describe('formatEchoedInput', () => {
  it('wraps user input with gray background', () => {
    const result = formatEchoedInput('你好');
    expect(result).toContain('\x1b[48;5;237m');
    expect(result).toContain('> 你好');
    expect(result).toContain('\x1b[0m');
    const bgIdx = result.indexOf('\x1b[48;5;237m');
    const resetIdx = result.indexOf('\x1b[0m');
    expect(bgIdx).toBeLessThan(resetIdx);
  });

  it('handles empty string', () => {
    const result = formatEchoedInput('');
    expect(result).toContain('\x1b[48;5;237m');
    expect(result).toContain('> ');
    expect(result).toContain('\x1b[0m');
  });
});
