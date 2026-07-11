import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFooter } from '../footer';

describe('createFooter', () => {
  let footer: ReturnType<typeof createFooter>;

  beforeEach(() => {
    footer = createFooter();
  });

  describe('render', () => {
    it('renders separator and hint when no messages', () => {
      // Mock terminal width to 80
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      const result = footer.render();
      expect(result).toContain('─'.repeat(80));
      expect(result).toContain('Ctrl+O expand tasks');
    });

    it('renders a single completed message', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({
        id: 'job-test-001',
        icon: '✓',
        text: 'python train.py: completed (12.3s)',
      });

      const result = footer.render();
      expect(result).toContain('✓ python train.py: completed (12.3s)');
    });

    it('renders multiple messages in insertion order', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: completed (1.0s)' });
      footer.upsert({ id: 'job-2', icon: '✗', text: 'cmd2: failed (2.0s)' });

      const result = footer.render();
      const idx1 = result.indexOf('cmd1');
      const idx2 = result.indexOf('cmd2');
      expect(idx1).toBeLessThan(idx2);
    });

    it('uses current terminal width for separator', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 120 },
      });

      const result = footer.render();
      expect(result).toContain('─'.repeat(120));
    });
  });

  describe('upsert', () => {
    it('deduplicates by id — replaces existing message', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({ id: 'job-1', icon: '⚡', text: 'cmd: running...' });
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd: completed (5.0s)' });

      const result = footer.render();
      // Should only appear once, with the updated text
      expect(result).toContain('✓ cmd: completed (5.0s)');
      expect(result).not.toContain('running...');
      // Count occurrences of 'cmd:' — should be exactly 1
      const matches = result.match(/cmd:/g);
      expect(matches).toHaveLength(1);
    });

    it('keeps at most 5 messages, dropping oldest', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      for (let i = 1; i <= 7; i++) {
        footer.upsert({ id: `job-${i}`, icon: '✓', text: `cmd${i}: completed` });
      }

      const result = footer.render();
      // job-1 and job-2 should be dropped
      expect(result).not.toContain('cmd1');
      expect(result).not.toContain('cmd2');
      // job-3 through job-7 should be present
      expect(result).toContain('cmd3');
      expect(result).toContain('cmd7');
    });
  });

  describe('remove', () => {
    it('removes a message by id', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

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
    it('removes all messages', () => {
      vi.stubGlobal('process', {
        ...process,
        stdout: { ...process.stdout, columns: 80 },
      });

      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: completed' });
      footer.clear();

      const result = footer.render();
      expect(result).not.toContain('cmd1');
      expect(result).toContain('Ctrl+O expand tasks'); // hint still present
    });
  });
});
