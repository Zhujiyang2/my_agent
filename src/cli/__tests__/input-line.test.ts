import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createInputLine } from '../input-line';
import type { FooterMessage } from '../footer';

// Minimal footer stub matching the real interface
function createStubFooter(messages: FooterMessage[] = []) {
  let statusLine = '';
  return {
    messages,
    upsert(msg: FooterMessage) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) messages[idx] = msg;
      else messages.push(msg);
    },
    remove(_id: string) {},
    clear() { messages.length = 0; },
    setStatusLine(line: string) { statusLine = line; },
    renderSeparator() {
      return '─'.repeat(80);
    },
    renderStatusLine() {
      return statusLine;
    },
    render() {
      const sep = '─'.repeat(80);
      const lines = [sep, '  /exit to quit | Ctrl+C to interrupt'];
      for (const msg of messages) {
        lines.push(`${msg.icon} ${msg.text}`);
      }
      return lines.join('\n');
    },
    frameLineCount() {
      const slc = statusLine ? statusLine.split('\n').length : 0;
      return slc + 3 + messages.length;
    },
  };
}

describe('createInputLine', () => {
  let footer: ReturnType<typeof createStubFooter>;
  let onWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    footer = createStubFooter();
    onWrite = vi.fn();
  });

  describe('initial state', () => {
    it('has empty line and cursor at 0', () => {
      const il = createInputLine({ footer, onWrite });
      expect(il.getLine()).toBe('');
      expect(il.getCursor()).toBe(0);
    });
  });

  describe('character input', () => {
    it('inserts character at cursor position', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('你');
      expect(il.getCursor()).toBe(1);
    });

    it('inserts multiple characters in order', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('你好');
      expect(il.getCursor()).toBe(2);
    });

    it('renders frame on each keypress', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      expect(onWrite).toHaveBeenCalled();
      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      expect(output).toContain('> a');
      expect(output).toContain('─'.repeat(80));
    });
  });

  describe('backspace', () => {
    it('deletes character before cursor', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'backspace', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('你');
      expect(il.getCursor()).toBe(1);
    });

    it('does nothing when line is empty', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('', { name: 'backspace', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('');
      expect(il.getCursor()).toBe(0);
    });
  });

  describe('delete', () => {
    it('deletes character at cursor position', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      // Cursor at 2, move left to position 1 (between char 0 and char 1)
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      // Delete character at cursor position 1 (the second char)
      il.onKeypress('', { name: 'delete', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('你');
      expect(il.getCursor()).toBe(1);
    });
  });

  describe('cursor movement', () => {
    it('moves cursor left', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(1);
    });

    it('moves cursor right', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'right', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(1);
    });

    it('does not move past start', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(0);
    });

    it('does not move past end', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'right', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(1);
    });

    it('home jumps to start', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'home', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(0);
    });

    it('end jumps to end', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'end', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(2);
    });
  });

  describe('submit', () => {
    it('returns raw line and echoes with gray background', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });

      const submitted = il.submit();
      expect(submitted).toBe('你好');

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      expect(output).toContain('\x1b[48;5;237m');
      expect(output).toContain('> 你好');
    });

    it('clears internal state after submit', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.submit();
      expect(il.getLine()).toBe('');
      expect(il.getCursor()).toBe(0);
    });

    it('returns empty string for empty input (no echo)', () => {
      const il = createInputLine({ footer, onWrite });
      const submitted = il.submit();
      expect(submitted).toBe('');
    });

    it('returns whitespace-only input as-is (caller decides trimming)', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress(' ', { name: ' ', ctrl: false, meta: false, shift: false });
      il.onKeypress(' ', { name: ' ', ctrl: false, meta: false, shift: false });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      const submitted = il.submit();
      expect(submitted).toBe('  a');
    });
  });

  describe('reset', () => {
    it('clears line and re-renders frame', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      onWrite.mockClear();
      il.reset();
      expect(il.getLine()).toBe('');
      expect(il.getCursor()).toBe(0);
      expect(onWrite).toHaveBeenCalled();
    });
  });

  describe('renderFrame', () => {
    it('renders frame with top sep, prompt+line, bottom sep+hints', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('h', { name: 'h', ctrl: false, meta: false, shift: false });
      il.onKeypress('i', { name: 'i', ctrl: false, meta: false, shift: false });
      onWrite.mockClear();

      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      expect(output).toContain('> hi');
      expect(output).toContain('─'.repeat(80));
      expect(output).toContain('/exit to quit');
    });

    it('renders status line above top separator', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      footer.setStatusLine('\x1b[2m┃ ⚡ 1 running\x1b[0m');
      il.renderFrame();
      onWrite.mockClear();

      // Re-render to verify the old frame is properly cleared (moves up past status line)
      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      // Clear should move up past status line + top sep = 2 lines
      expect(output).toContain('\x1b[2A');
      expect(output).toContain('⚡ 1 running');
    });

    it('handles multi-line status line correctly', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      // Multi-line status: "N running" + one task name per line
      footer.setStatusLine('\x1b[2m┃ ⚡ 2 running\x1b[0m\n\x1b[2m  npm build\x1b[0m\n\x1b[2m  npm test\x1b[0m');
      il.renderFrame();
      onWrite.mockClear();

      // Re-render: should clear old multi-line status properly
      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      // 3 status lines + 1 top sep = 4 lines to move up
      expect(output).toContain('\x1b[4A');
      expect(output).toContain('2 running');
      expect(output).toContain('npm build');
      expect(output).toContain('npm test');
    });

    it('clears status line when emptied between renders', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      // First render with multi-line status
      footer.setStatusLine('line1\nline2');
      il.renderFrame();
      onWrite.mockClear();

      // Remove status and re-render
      footer.setStatusLine('');
      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      // Should clear old frame (3 lines up: 2 status + 1 top sep)
      expect(output).toContain('\x1b[3A');
      // New frame should NOT contain status content
      expect(output).not.toContain('line1');
    });
  });
});
