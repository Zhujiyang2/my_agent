import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFooter } from '../footer';

describe('createFooter', () => {
  let footer: ReturnType<typeof createFooter>;

  beforeEach(() => {
    footer = createFooter();
  });

  function mockColumns(cols: number) {
    vi.stubGlobal('process', {
      ...process,
      stdout: { ...process.stdout, columns: cols },
    });
  }

  describe('renderSeparator', () => {
    it('returns a separator line matching terminal width', () => {
      mockColumns(80);
      expect(footer.renderSeparator()).toBe('─'.repeat(80));
    });

    it('uses current terminal width', () => {
      mockColumns(120);
      expect(footer.renderSeparator()).toBe('─'.repeat(120));
    });
  });

  describe('render', () => {
    it('renders separator and hint when no messages', () => {
      mockColumns(80);
      const result = footer.render();
      expect(result).toContain('─'.repeat(80));
      expect(result).toContain('/exit to quit | Ctrl+C to interrupt');
      expect(result).not.toContain('Ctrl+O');
    });

    it('renders messages below separator and hint', () => {
      mockColumns(80);
      footer.upsert({
        id: 'job-test-001',
        icon: '✓',
        text: 'python train.py: completed (12.3s)',
      });

      const result = footer.render();
      const sepIdx = result.indexOf('─'.repeat(80));
      const hintIdx = result.indexOf('/exit to quit');
      const msgIdx = result.indexOf('python train.py');
      expect(sepIdx).toBeLessThan(hintIdx);
      expect(hintIdx).toBeLessThan(msgIdx);
    });

    it('renders multiple messages in insertion order', () => {
      mockColumns(80);
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: completed (1.0s)' });
      footer.upsert({ id: 'job-2', icon: '✗', text: 'cmd2: failed (2.0s)' });

      const result = footer.render();
      const idx1 = result.indexOf('cmd1');
      const idx2 = result.indexOf('cmd2');
      expect(idx1).toBeLessThan(idx2);
    });
  });

  describe('upsert', () => {
    it('deduplicates by id — replaces existing message', () => {
      mockColumns(80);
      footer.upsert({ id: 'job-1', icon: '⚡', text: 'cmd: running...' });
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd: completed (5.0s)' });

      const result = footer.render();
      expect(result).toContain('✓ cmd: completed (5.0s)');
      expect(result).not.toContain('running...');
      const matches = result.match(/cmd:/g);
      expect(matches).toHaveLength(1);
    });

    it('keeps at most 5 messages, dropping oldest', () => {
      mockColumns(80);
      for (let i = 1; i <= 7; i++) {
        footer.upsert({ id: `job-${i}`, icon: '✓', text: `cmd${i}: completed` });
      }

      const result = footer.render();
      expect(result).not.toContain('cmd1');
      expect(result).not.toContain('cmd2');
      expect(result).toContain('cmd3');
      expect(result).toContain('cmd7');
    });
  });

  describe('remove', () => {
    it('removes a message by id', () => {
      mockColumns(80);
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: completed' });
      footer.upsert({ id: 'job-2', icon: '✓', text: 'cmd2: completed' });
      footer.remove('job-1');

      const result = footer.render();
      expect(result).not.toContain('cmd1');
      expect(result).toContain('cmd2');
    });

    it('does nothing when id not found', () => {
      footer.remove('nonexistent');
      // Should not throw
    });
  });

  describe('clear', () => {
    it('removes all messages but keeps separator and hint', () => {
      mockColumns(80);
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: completed' });
      footer.clear();

      const result = footer.render();
      expect(result).not.toContain('cmd1');
      expect(result).toContain('/exit to quit | Ctrl+C to interrupt');
      expect(result).toContain('─'.repeat(80));
    });
  });

  describe('frameLineCount', () => {
    it('returns 3 when no messages (topSep 1 + bottomSep 1 + hint 1)', () => {
      expect(footer.frameLineCount()).toBe(3);
    });

    it('includes message lines in count', () => {
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd: done' });
      // topSep(1) + bottomSep(1) + hint(1) + msg(1) = 4
      expect(footer.frameLineCount()).toBe(4);
    });

    it('includes multiple messages', () => {
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: done' });
      footer.upsert({ id: 'job-2', icon: '✗', text: 'cmd2: failed' });
      // topSep(1) + bottomSep(1) + hint(1) + msgs(2) = 5
      expect(footer.frameLineCount()).toBe(5);
    });

    it('includes status line in count', () => {
      footer.setStatusLine('\x1b[2m┃ ⚡ 1 running\x1b[0m');
      // statusLine(1) + topSep(1) + bottomSep(1) + hint(1) = 4
      expect(footer.frameLineCount()).toBe(4);
    });

    it('counts multi-line status correctly', () => {
      footer.setStatusLine('line1\nline2\nline3');
      // statusLine(3) + topSep(1) + bottomSep(1) + hint(1) = 6
      expect(footer.frameLineCount()).toBe(6);
    });
  });

  describe('renderStatusLine / setStatusLine', () => {
    it('returns empty string when no status', () => {
      expect(footer.renderStatusLine()).toBe('');
    });

    it('returns the set status line', () => {
      footer.setStatusLine('\x1b[2m┃ ⚡ 2 running\x1b[0m');
      expect(footer.renderStatusLine()).toBe('\x1b[2m┃ ⚡ 2 running\x1b[0m');
    });
  });
});
