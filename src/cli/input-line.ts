import type { createFooter } from './footer.js';

type Footer = ReturnType<typeof createFooter>;

export interface InputLineOpts {
  footer: Footer;
  onWrite: (text: string) => void;
}

export interface InputLine {
  getLine(): string;
  getCursor(): number;
  onKeypress(
    str: string,
    key: { name: string; ctrl: boolean; meta: boolean; shift: boolean },
  ): void;
  submit(): string;
  reset(): void;
  renderFrame(): void;
}

export function createInputLine(opts: InputLineOpts): InputLine {
  const { footer, onWrite } = opts;

  let line = '';
  let cursor = 0;
  let isFrameVisible = false;

  function getLine(): string {
    return line;
  }

  function getCursor(): number {
    return cursor;
  }

  /** Render the full frame with input line between separators.
   *
   *  Layout:
   *    ────────────────  ← top sep
   *    > {line}█         ← input line (cursor here)
   *    ────────────────  ← bottom sep
   *      hints/messages  ← footer content
   *
   *  After writing everything top-to-bottom, we ANSI-cursor-up back to the
   *  input line and right to the correct cursor column. Since readline is NOT
   *  involved in rendering (we only use its keypress events), there's no
   *  conflicting cursor state — we are the sole owner of stdout positioning.
   */
  function renderFrame(): void {
    const topSep = footer.renderSeparator();
    const bottom = footer.render();
    const bottomLines = bottom.split('\n').length;

    if (isFrameVisible) {
      // Frame is already on screen. Cursor is on the input line (mid-frame).
      // Move up 1 line to above the old top separator, then clear from there.
      onWrite('\r');
      onWrite('\x1b[1A');
      onWrite('\x1b[0J');
    } else {
      // No frame visible (first render, or after LLM streaming).
      // Cursor is at the end of previous output. Clear from cursor down.
      onWrite('\x1b[0J');
    }

    // Write frame top-to-bottom
    onWrite(topSep + '\n');
    onWrite(`\x1b[36m> ${line}\x1b[0m\n`);
    onWrite(bottom + '\n');

    // Cursor is now at the start of the line AFTER `bottom`.
    // Move up `bottomLines` rows to the input line.
    onWrite(`\x1b[${bottomLines}A`);
    // Move right: past "> " (2 visible columns) + cursor offset within line
    onWrite(`\x1b[${2 + cursor}C`);

    isFrameVisible = true;
  }

  function onKeypress(
    str: string,
    key: { name: string; ctrl: boolean; meta: boolean; shift: boolean },
  ): void {
    // Enter/Return is handled externally via submit()
    if (key.name === 'return' || key.name === 'enter') {
      return;
    }

    if (key.name === 'backspace') {
      if (cursor > 0) {
        line = line.slice(0, cursor - 1) + line.slice(cursor);
        cursor--;
      }
    } else if (key.name === 'delete') {
      if (cursor < line.length) {
        line = line.slice(0, cursor) + line.slice(cursor + 1);
      }
    } else if (key.name === 'left') {
      if (cursor > 0) cursor--;
    } else if (key.name === 'right') {
      if (cursor < line.length) cursor++;
    } else if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      cursor = 0;
    } else if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      cursor = line.length;
    } else if (str && str.length === 1) {
      // Ordinary printable character
      line = line.slice(0, cursor) + str + line.slice(cursor);
      cursor++;
    }

    renderFrame();
  }

  /** Submit current line. Returns the raw content (caller decides trimming).
   *  Echoes with gray background for non-empty input, clears internal state. */
  function submit(): string {
    const submitted = line;
    if (submitted.trim().length > 0) {
      // Gray background echo — full line width, no separators
      onWrite(`\x1b[48;5;237m\x1b[36m> ${submitted}\x1b[0m\n`);
    }
    line = '';
    cursor = 0;
    isFrameVisible = false;
    return submitted;
  }

  /** Reset state and re-render frame (e.g. after LLM finishes streaming). */
  function reset(): void {
    line = '';
    cursor = 0;
    renderFrame();
  }

  return { getLine, getCursor, onKeypress, submit, reset, renderFrame };
}
