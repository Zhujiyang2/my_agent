import type { createFooter } from './footer.js';

type Footer = ReturnType<typeof createFooter>;

/** Calculate display width of a string (CJK characters = 2 columns). */
function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) {
      width += 1;
    } else if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      cp === 0x2329 || cp === 0x232a || // Misc technical
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals … Yi
      (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
      (cp >= 0xfe10 && cp <= 0xfe1f) || // Vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
      (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
      (cp >= 0x1f000 && cp <= 0x1f9ff) || // Emoji / Symbols
      (cp >= 0x20000 && cp <= 0x2ffff)    // CJK Extension B+
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

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
      // Old frame is visible. Cursor is on the input line.
      // Move to column 0, then up 1 row to the old top separator.
      // Clear from there to end of screen, wiping the entire old frame.
      onWrite('\r');
      onWrite('\x1b[1A');
      onWrite('\x1b[0J');
    } else {
      // No frame visible (first render, or after LLM output).
      // Go to column 0, then clear from cursor position down.
      onWrite('\r');
      onWrite('\x1b[0J');
    }

    // Write frame top-to-bottom
    onWrite(topSep + '\n');
    onWrite(`\x1b[36m> ${line}\x1b[0m\n`);
    onWrite(bottom + '\n');

    // Cursor is now after the trailing '\n' from `bottom + '\n'`.
    // Move up past the trailing blank + bottom content to the input line.
    onWrite(`\x1b[${bottomLines + 1}A`);
    // Move right: "> " (2 cols) + display width of characters before cursor
    const offset = 2 + displayWidth(line.slice(0, cursor));
    onWrite(`\x1b[${offset}C`);

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
      // Wipe the old frame: move to col 0 of input line, up 1 to top sep,
      // then clear everything from top sep to end of screen.
      onWrite('\r');
      onWrite('\x1b[1A');
      onWrite('\x1b[0J');
      // Gray background echo where the frame used to be
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
