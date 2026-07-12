import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createInputLine } from '../input-line';
import type { FooterMessage } from '../footer';

// Minimal footer stub matching the real interface
function createStubFooter(messages: FooterMessage[] = []) {
  let taskLines: string[] = [];
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
    setTasks(lines: string[]) { taskLines = lines; },
    clearTasks() { taskLines = []; },
    setStatusLine(line: string) { statusLine = line; },
    renderSeparator() {
      return '─'.repeat(80);
    },
    renderStatusLine() {
      return statusLine;
    },
    render() {
      const sep = '─'.repeat(80);
      const lines = [sep, '  /exit to quit | Ctrl+C to interrupt | Ctrl+O tasks'];
      for (const msg of messages) {
        lines.push(`${msg.icon} ${msg.text}`);
      }
      for (const tl of taskLines) {
        lines.push(tl);
      }
      return lines.join('\n');
    },
    frameLineCount() {
      const slc = statusLine ? 1 : 0;
      return slc + 3 + messages.length + taskLines.length;
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
      // Type "hi" character by character
      il.onKeypress('h', { name: 'h', ctrl: false, meta: false, shift: false });
      il.onKeypress('i', { name: 'i', ctrl: false, meta: false, shift: false });
      onWrite.mockClear();

      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      expect(output).toContain('> hi');
      expect(output).toContain('─'.repeat(80));
      expect(output).toContain('/exit to quit');
    });

    it('expands with task lines below hint when setTasks is called', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('h', { name: 'h', ctrl: false, meta: false, shift: false });
      onWrite.mockClear();

      // Simulate Ctrl+O: add task lines, then re-render
      footer.setTasks([
        '\x1b[2m┃ ⚡ a1b2c3d4e5f6 30s echo hello\x1b[0m',
        '\x1b[2m┃ Ctrl+O to collapse\x1b[0m',
      ]);
      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      // Task lines should appear after hint
      const hintIdx = output.indexOf('/exit to quit');
      const taskIdx = output.indexOf('echo hello');
      const collapseIdx = output.indexOf('Ctrl+O to collapse');
      expect(hintIdx).toBeLessThan(taskIdx);
      expect(taskIdx).toBeLessThan(collapseIdx);
      // Should render correctly (clear + full frame)
      expect(output).toContain('\x1b[0J');
    });

    it('clears task lines when clearTasks is called', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('h', { name: 'h', ctrl: false, meta: false, shift: false });
      // First expand
      footer.setTasks(['\x1b[2m┃ ⚡ echo hello\x1b[0m']);
      il.renderFrame();
      onWrite.mockClear();

      // Then collapse
      footer.clearTasks();
      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      expect(output).not.toContain('echo hello');
      expect(output).toContain('\x1b[1A'); // clear from top sep position
    });

    it('handles toggling with status line present', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      // Simulate status timer adding status line
      footer.setStatusLine('\x1b[2m┃ ⚡ 1 running\x1b[0m');
      il.renderFrame(); // frame now has status line
      onWrite.mockClear();

      // Now toggle tasks on (Ctrl+O)
      footer.setTasks(['\x1b[2m┃ ⚡ a1b2c3d4e5f6 30s npm test\x1b[0m', '\x1b[2m┃ Ctrl+O to collapse\x1b[0m']);
      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      // Status line should appear above top sep
      expect(output).toContain('⚡ 1 running');
      // Task line should appear in output
      expect(output).toContain('npm test');
      // Clear should happen from correct position (status line)
      expect(output).toContain('\x1b[2A'); // moves up 2 lines (status + top sep)
    });
  });
});
